/**
 * Capacidades de `restaurante` — la primera tanda, solo consultas.
 *
 * Corre contra la base de verdad, como el resto de las suites de capacidades: un doble de
 * `cartaService` probaría que el adaptador llama a la función que el propio test dice que hay
 * que llamar, y nada más. Lo que interesa aquí es que los **filtros de la vertical** se
 * respeten —visible, disponible, negocio— y eso solo se ve contra Postgres.
 *
 * Necesita `scripts/fixtures/dev_carta_restaurante.sql`.
 */
'use strict';

require('dotenv').config();
// La feature comercial se fuerza igual que en las demás suites: `asistente_ia` no está en
// ningún plan de la base local, y sin ella el Gate deniega antes de llegar a la capacidad.
process.env.FEATURES_FORZADAS = 'asistente_ia';

const Models = require('../../app_core/models/conection');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const { principalDeContacto } = require('../../intelligence/engine/identidad');
const intelligence = require('../../intelligence');
const policyGate = require('../../intelligence/core/policyGate');

const sequelize = Models.sequelize;

const CAPACIDADES = ['consultar_carta', 'buscar_producto', 'consultar_estado_pedido', 'tomar_pedido'];
const TEL_DUENO = '+573001112233';
const TEL_INTRUSO = '+573009998877';

let idNegocio;
let idNegocioRival;
let principal;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

async function habilitar(negocio, capacidad) {
    await sequelize.query(
        `
        INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada)
        VALUES (:negocio, :capacidad, true)
        ON CONFLICT (id_negocio, capacidad) DO UPDATE SET habilitada = true;
        `,
        { replacements: { negocio, capacidad } }
    );
}

function ejecutar(capacidad, args = {}, extra = {}) {
    return policyGate.ejecutar({ capacidad, principal, idNegocio, args, ...extra });
}

beforeAll(async () => {
    intelligence.arrancar();

    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`))?.id_negocio;
    idNegocioRival = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';`))?.id_negocio;

    const hayCarta = await unaFila(
        `SELECT 1 AS ok FROM restaurante.carta_producto WHERE id_negocio = :n AND nombre = 'Hamburguesa doble';`,
        { n: idNegocio }
    );
    if (!hayCarta) throw new Error('Falta la carta. Ejecuta scripts/fixtures/dev_carta_restaurante.sql.');

    const idUsuario = (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = '1000000002';`))?.id_usuario;
    principal = await resolverPrincipalUsuario(idUsuario);

    for (const c of CAPACIDADES) await habilitar(idNegocio, c);
});

afterAll(async () => {
    await sequelize.query(
        `DELETE FROM restaurante.pedid_detalle WHERE id_orden IN (
            SELECT id_orden FROM restaurante.pedid_orden
             WHERE id_negocio = :n AND contacto_nombre LIKE 'BOT %');`,
        { replacements: { n: idNegocio } }
    );
    await sequelize.query(
        `DELETE FROM restaurante.pedid_orden WHERE numero_orden LIKE 'ORD-99%'
            OR (id_negocio = :n AND contacto_nombre LIKE 'BOT %');`,
        { replacements: { n: idNegocio } }
    );
    intelligence._reiniciar();
    await sequelize.close();
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('consultar_carta', () => {
    it('sin categoría devuelve las categorías, no la carta entera', async () => {
        // La carta completa no cabe en un mensaje y abruma: primero se enseña por dónde entrar.
        const { resultado } = await ejecutar('consultar_carta');

        const nombres = resultado.categorias.map((c) => c.nombre);
        expect(nombres).toEqual(expect.arrayContaining(['Hamburguesas', 'Bebidas', 'Postres']));
        expect(resultado.productos).toBeUndefined();
    });

    it('con categoría devuelve sus productos con precio', async () => {
        const { resultado: cats } = await ejecutar('consultar_carta');
        const hamburguesas = cats.categorias.find((c) => c.nombre === 'Hamburguesas');

        const { resultado } = await ejecutar('consultar_carta', { id_categoria: hamburguesas.id_categoria });
        const doble = resultado.productos.find((p) => p.nombre === 'Hamburguesa doble');

        expect(doble.precio).toBe(32000);
        expect(typeof doble.precio).toBe('number');
    });

    it('una categoría que no existe FALLA en vez de devolver vacío', async () => {
        // El fallo que esto existe para que no vuelva (2026-08-24, en producción): el modelo
        // pidió la categoría 2 —un ordinal, «la segunda»— cuando las de ese negocio eran 38, 39
        // y 40. La capacidad devolvía lista vacía con resultado `ok`, el bot se lo creyó, y el
        // cliente leyó «en Platos no tenemos productos disponibles» con la carta llena.
        //
        // La lección va más allá del caso: una capacidad que devuelve vacío ante una entrada
        // inválida le enseña al modelo a mentirle al cliente. Vacío significa «no hay», y eso
        // tiene que ser cierto.
        await expect(ejecutar('consultar_carta', { id_categoria: 999999 }))
            .rejects.toMatchObject({ code: 'CATEGORIA_NO_ENCONTRADA' });
    });

    it('tampoco vale la categoría de OTRO negocio', async () => {
        const ajena = await unaFila(
            `SELECT id_categoria FROM restaurante.carta_categoria
              WHERE id_negocio <> :n AND estado = 'A' LIMIT 1;`,
            { n: idNegocio }
        );
        if (!ajena) return; // sin otra carta en la base no hay nada que comprobar

        await expect(ejecutar('consultar_carta', { id_categoria: ajena.id_categoria }))
            .rejects.toMatchObject({ code: 'CATEGORIA_NO_ENCONTRADA' });
    });

    it('NO enseña lo que el negocio oculta ni lo que está agotado', async () => {
        // Son dos filtros distintos de la vertical —`visible` y `disponible`— y el que se
        // olvida es siempre el segundo. Un bot que ofrece algo agotado hace que el negocio
        // quede mal con su cliente.
        const { resultado: cats } = await ejecutar('consultar_carta');
        const todos = [];
        for (const c of cats.categorias) {
            const { resultado } = await ejecutar('consultar_carta', { id_categoria: c.id_categoria });
            todos.push(...resultado.productos.map((p) => p.nombre));
        }

        expect(todos).toContain('Hamburguesa clásica');
        expect(todos).not.toContain('Menú del personal');  // visible = false
        expect(todos).not.toContain('Malteada de mora');   // disponible = false
    });
});

describe('buscar_producto', () => {
    it('encuentra TODOS los que comparten la palabra, no solo uno', async () => {
        const { resultado } = await ejecutar('buscar_producto', { termino: 'hamburguesa' });
        const nombres = resultado.productos.map((p) => p.nombre);

        expect(nombres).toEqual(expect.arrayContaining(['Hamburguesa clásica', 'Hamburguesa doble']));
    });

    it('devuelve vacío en vez de inventarse algo', async () => {
        // Es la respuesta que el catálogo le pide al modelo que sepa dar: «no lo tenemos».
        const { resultado } = await ejecutar('buscar_producto', { termino: 'sushi' });
        expect(resultado.productos).toEqual([]);
    });

    it('no cruza inquilinos: la carta del vecino no existe para este negocio', async () => {
        await habilitar(idNegocioRival, 'buscar_producto');
        const { resultado } = await policyGate.ejecutar({
            capacidad: 'buscar_producto',
            principal,
            idNegocio: idNegocioRival,
            args: { termino: 'hamburguesa' },
        }).catch((e) => ({ resultado: { error: e.code } }));

        // El principal no pertenece al rival, así que el Gate lo para antes de llegar a la
        // carta. Es la misma puerta que cerró F2 y aquí se comprueba que también aplica a las
        // capacidades nuevas, no solo a las de reserva.
        expect(resultado.error).toBeDefined();
    });
});

describe('consultar_estado_pedido — un pedido solo lo ve quien lo pidió', () => {
    // El número de orden es corto y secuencial («ORD-12»), así que aquí adivinar SÍ es una
    // estrategia: sin la comprobación de pertenencia, cualquiera podría recorrer los números y
    // leer el teléfono y el total de los pedidos de los demás.
    // `id_usuario` es NOT NULL en `pedid_orden`: una orden siempre la toma alguien del
    // negocio. Comprobado al escribir esto, y es exactamente el tercer bloqueo que impide
    // que el bot cree pedidos hoy — no es una convención del servicio, es el esquema.
    // ⚠️ Los números tienen que seguir el formato real `ORD-<n>`: `generarNumeroOrden` hace
    // `CAST(SUBSTRING(numero_orden FROM 5) AS INTEGER)` sobre TODAS las órdenes del negocio, así
    // que uno con otra forma —`TEST-REST-1` daba `-REST-1`— hace fallar la creación de cualquier
    // pedido nuevo de ese negocio. Descubierto escribiendo esto, y es una fragilidad real del
    // servicio, no solo del test.
    async function crearOrdenDePrueba(numero, telefono) {
        await sequelize.query(
            `
            INSERT INTO restaurante.pedid_orden
                (id_negocio, numero_orden, id_usuario, estado, tipo_pedido, contacto_telefono, total)
            VALUES (:n, :num, :u, 'ABIERTA', 'DOMICILIO', :tel, 45000);
            `,
            { replacements: { n: idNegocio, num: numero, u: principal.id_usuario, tel: telefono } }
        );
    }

    it('el dueño del pedido lo ve', async () => {
        await crearOrdenDePrueba('ORD-9901', TEL_DUENO);
        const { resultado } = await policyGate.ejecutar({
            capacidad: 'consultar_estado_pedido',
            principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_DUENO }),
            idNegocio,
            args: { numero_orden: 'ORD-9901' },
        });
        expect(resultado.numero_orden).toBe('ORD-9901');
        expect(resultado.total).toBe(45000);
    });

    it('otro número no lo ve, aunque acierte el número de orden', async () => {
        await crearOrdenDePrueba('ORD-9902', TEL_DUENO);
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_estado_pedido',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_INTRUSO }),
                idNegocio,
                args: { numero_orden: 'ORD-9902' },
            })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('un pedido de mesa, sin teléfono, no se consulta desde el canal', async () => {
        await crearOrdenDePrueba('ORD-9903', null);
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_estado_pedido',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_DUENO }),
                idNegocio,
                args: { numero_orden: 'ORD-9903' },
            })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('el NEGOCIO sí puede consultar cualquiera', async () => {
        await crearOrdenDePrueba('ORD-9904', TEL_DUENO);
        const { resultado } = await ejecutar('consultar_estado_pedido', { numero_orden: 'ORD-9904' });
        expect(resultado.numero_orden).toBe('ORD-9904');
    });

    it('un número que no existe dice que no existe, y no revienta', async () => {
        await expect(
            ejecutar('consultar_estado_pedido', { numero_orden: 'NO-EXISTE-999' })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ENCONTRADO' });
    });
});


describe('tomar_pedido — la mutación', () => {
    const TEL_CLIENTE = '+573005556677';

    function contacto() {
        return principalDeContacto(idNegocio, { telefonoVerificado: TEL_CLIENTE });
    }

    async function idsDeCarta() {
        const { resultado } = await ejecutar('buscar_producto', { termino: 'hamburguesa' });
        return resultado.productos;
    }

    async function abrirCaja() {
        // Una orden no existe fuera de un turno de caja: es la regla del dominio que hay que
        // respetar, no rodear. Aquí se abre una a mano para poder ejercitar el camino feliz.
        await sequelize.query(
            `INSERT INTO restaurante.rest_caja (id_negocio, id_usuario, monto_apertura, estado, fecha_apertura)
             SELECT :n, :u, 0, 'A', now()
              WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A');`,
            { replacements: { n: idNegocio, u: principal.id_usuario } }
        );
    }

    async function cerrarCaja() {
        await sequelize.query(
            `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_negocio = :n AND estado = 'A';`,
            { replacements: { n: idNegocio } }
        );
    }

    function pedir(items, extra = {}) {
        return policyGate.ejecutar({
            capacidad: 'tomar_pedido',
            principal: contacto(),
            idNegocio,
            args: {
                items,
                cliente_nombre: 'BOT Cliente',
                direccion: 'Calle 10 # 5-30, apto 201',
                ...extra,
            },
            confirmadoPor: { origen: 'test', texto: 'sí' },
        });
    }

    afterEach(cerrarCaja);

    it('con la caja CERRADA no toma el pedido, y lo dice en cristiano', async () => {
        await cerrarCaja();
        const [prod] = await idsDeCarta();

        await expect(pedir([{ id_producto: prod.id_producto, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'RESTAURANTE_CERRADO' });
    });

    it('crea la orden, a nombre del usuario Asistente y con el teléfono del CANAL', async () => {
        await abrirCaja();
        const [prod] = await idsDeCarta();

        const { resultado } = await pedir([{ id_producto: prod.id_producto, cantidad: 2 }]);
        expect(resultado.numero_orden).toBeTruthy();

        const fila = await unaFila(
            `SELECT o.contacto_telefono, o.tipo_pedido, o.direccion_domicilio,
                    u.num_identificacion AS autor
               FROM restaurante.pedid_orden o
               JOIN general.gener_usuario u ON u.id_usuario = o.id_usuario
              WHERE o.numero_orden = :num AND o.id_negocio = :n;`,
            { num: resultado.numero_orden, n: idNegocio }
        );

        expect(fila.tipo_pedido).toBe('DOMICILIO');
        expect(fila.direccion_domicilio).toContain('Calle 10');
        // La plataforma impone el teléfono, igual que en reservar_turno.
        expect(fila.contacto_telefono).toBe(TEL_CLIENTE);
        // Y el autor es el asistente de ESTE negocio, para que el informe de ventas por
        // usuario no le atribuya al dueño lo que vendió el bot.
        expect(fila.autor).toBe(`ASISTENTE-${idNegocio}`);
    });

    it('el precio sale del CATÁLOGO, no de lo que diga la conversación', async () => {
        // Es la mitad que hace útil releer los productos. Si el precio viniera del modelo, un
        // pedido podría cobrarse a lo que el bot recordara de hace veinte turnos — y esa
        // diferencia se descubre en la puerta del cliente, con el domiciliario delante.
        await abrirCaja();
        const [prod] = await idsDeCarta();

        const { resultado } = await policyGate.ejecutar({
            capacidad: 'tomar_pedido',
            principal: contacto(),
            idNegocio,
            args: {
                // El modelo intenta colar un precio. El validador ni siquiera lo deja pasar
                // (no está declarado en `elemento`), y aunque pasara, el adaptador lo ignora.
                items: [{ id_producto: prod.id_producto, cantidad: 2, precio_unitario: 1 }],
                cliente_nombre: 'BOT Precio',
                direccion: 'Calle 10 # 5-30',
            },
            confirmadoPor: { origen: 'test', texto: 'sí' },
        });

        const fila = await unaFila(
            `SELECT d.precio_unitario::numeric AS unitario, d.subtotal::numeric AS subtotal
               FROM restaurante.pedid_detalle d
               JOIN restaurante.pedid_orden o USING (id_orden)
              WHERE o.numero_orden = :num AND o.id_negocio = :n;`,
            { num: resultado.numero_orden, n: idNegocio }
        );

        expect(Number(fila.unitario)).toBe(prod.precio);
        expect(Number(fila.subtotal)).toBe(prod.precio * 2);
    });

    it('el pedido creado se puede consultar después, y solo por su dueño', async () => {
        await abrirCaja();
        const [prod] = await idsDeCarta();
        const { resultado } = await pedir([{ id_producto: prod.id_producto, cantidad: 1 }]);

        const { resultado: estado } = await policyGate.ejecutar({
            capacidad: 'consultar_estado_pedido',
            principal: contacto(),
            idNegocio,
            args: { numero_orden: resultado.numero_orden },
        });
        expect(estado.numero_orden).toBe(resultado.numero_orden);

        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_estado_pedido',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_INTRUSO }),
                idNegocio,
                args: { numero_orden: resultado.numero_orden },
            })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('rechaza un producto que no está disponible en vez de crear media orden', async () => {
        await abrirCaja();
        const oculto = await unaFila(
            `SELECT id_producto FROM restaurante.carta_producto
              WHERE id_negocio = :n AND nombre = 'Malteada de mora';`,
            { n: idNegocio }
        );

        await expect(pedir([{ id_producto: oculto.id_producto, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'PRODUCTO_NO_DISPONIBLE' });
    });

    it('sin confirmación del cliente NO se ejecuta', async () => {
        // El Policy Gate lo exige, no el adaptador: aquí nace una orden con inventario que se
        // consume, y eso compromete al negocio (ADR-010, paso 5).
        await abrirCaja();
        const [prod] = await idsDeCarta();

        await expect(
            policyGate.ejecutar({
                capacidad: 'tomar_pedido',
                principal: contacto(),
                idNegocio,
                args: {
                    items: [{ id_producto: prod.id_producto, cantidad: 1 }],
                    cliente_nombre: 'BOT SinConfirmar',
                    direccion: 'Calle 10 # 5-30',
                },
            })
        ).rejects.toBeDefined();
    });

    it('un item mal formado se rechaza ANTES de tocar el dominio', async () => {
        await abrirCaja();
        // El validador de argumentos conoce la forma de cada elemento de la lista. Sin eso,
        // esto reventaría dentro de crearOrden, en un sitio que no sabe explicárselo a nadie.
        await expect(pedir([{ producto: 'hamburguesa' }])).rejects.toMatchObject({
            code: 'ARGUMENTOS_INVALIDOS',
        });
    });
});
