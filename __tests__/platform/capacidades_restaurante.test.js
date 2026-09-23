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
const { asegurarCajaPrincipal } = require('../../app_core/helpers/cajaPrincipal');
// La feature comercial se fuerza igual que en las demás suites: `asistente_ia` no está en
// ningún plan de la base local, y sin ella el Gate deniega antes de llegar a la capacidad.
process.env.FEATURES_FORZADAS = 'asistente_ia';

const Models = require('../../app_core/models/conection');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const { principalDeContacto } = require('../../intelligence/engine/identidad');
const intelligence = require('../../intelligence');
const policyGate = require('../../intelligence/core/policyGate');
const registry = require('../../intelligence/core/registry');
const horarioService = require('../../app_restaurante_api/services/horarioService');
const personaNegocioDao = require('../../app_core/dao/personaNegocioDao');

const sequelize = Models.sequelize;

const CAPACIDADES = [
    'consultar_carta',
    'buscar_producto',
    'consultar_estado_pedido',
    'tomar_pedido',
    'consultar_cuenta',
    'cancelar_pedido',
    'agregar_items_pedido',
];
const TEL_DUENO = '+573001112233';
const TEL_INTRUSO = '+573009998877';

let idNegocio;
let idNegocioRival;
let principal;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

/** `dia_semana` de HOY en hora de Bogotá (0=Dom..6=Sáb), sin depender del TZ del proceso. */
function diaBogotaAhora() {
    return new Date(Date.now() - 5 * 3600 * 1000).getUTCDay();
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
    await sequelize.query(
        `DELETE FROM restaurante.rest_cuenta_movimiento WHERE id_negocio = :n AND concepto LIKE 'BOT %';`,
        { replacements: { n: idNegocio } }
    );
    await sequelize.query(
        `DELETE FROM restaurante.rest_cuenta c USING platform.persona_negocio pn
          WHERE c.id_persona_negocio = pn.id_persona_negocio
            AND c.id_negocio = :n AND pn.nombre_mostrado LIKE 'BOT %';`,
        { replacements: { n: idNegocio } }
    );
    await sequelize.query(
        `DELETE FROM platform.persona_negocio WHERE id_negocio = :n AND nombre_mostrado LIKE 'BOT %';`,
        { replacements: { n: idNegocio } }
    );
    intelligence._reiniciar();
    await sequelize.close();
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('consultar_carta', () => {
    it('sin categoría devuelve el ENLACE y un ÍNDICE de categorías, no los productos', async () => {
        // El cambio del 2026-09-22. Antes esto devolvía la carta entera —todas las categorías
        // con todos sus productos y precios— y el modelo la transcribía tal cual en el chat: un
        // mensaje larguísimo que duplica, peor, lo que ya existe con fotos en el menú digital.
        // Visto en producción el 2026-09-21. Ahora, sin categoría, se lleva al cliente al
        // enlace; el índice solo trae nombre, id y cuántos productos por categoría.
        const { resultado } = await ejecutar('consultar_carta');

        expect(typeof resultado.enlace).toBe('string');
        expect(resultado.enlace).toContain(String(idNegocio));

        const categorias = resultado.categorias.map((c) => c.categoria);
        expect(categorias).toEqual(expect.arrayContaining(['Hamburguesas', 'Bebidas', 'Postres']));
        expect(resultado.categorias.every((c) => 'productos' in c)).toBe(false);
    });

    it('los ids de categoría siguen viajando: son los que hacen falta para acotar', async () => {
        // Que el cliente no los vea no significa que el modelo no los necesite. Sin ellos,
        // «¿qué bebidas tienen?» obligaría a adivinar un id — que es exactamente el fallo del
        // 2026-08-24.
        const { resultado } = await ejecutar('consultar_carta');
        expect(resultado.categorias.every((c) => Number.isInteger(c.id_categoria))).toBe(true);
    });

    it('con categoría devuelve sus productos con precio', async () => {
        const { resultado: indice } = await ejecutar('consultar_carta');
        const hamburguesas = indice.categorias.find((c) => c.categoria === 'Hamburguesas');

        const { resultado } = await ejecutar('consultar_carta', { id_categoria: hamburguesas.id_categoria });
        const doble = resultado.productos.find((p) => p.nombre === 'Hamburguesa doble');

        expect(resultado.categoria).toBe('Hamburguesas');
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
        // quede mal con su cliente. Se comprueba por categoría: el índice ya no trae productos,
        // así que el filtro se ve en el conteo (2 hamburguesas visibles, no 3) y confirmado al
        // pedir el detalle de esa categoría.
        const { resultado: indice } = await ejecutar('consultar_carta');
        const hamburguesas = indice.categorias.find((c) => c.categoria === 'Hamburguesas');
        const postres = indice.categorias.find((c) => c.categoria === 'Postres');
        expect(hamburguesas.cuantos_productos).toBe(2); // no cuenta 'Menú del personal'
        expect(postres.cuantos_productos).toBe(1); // no cuenta 'Malteada de mora'

        const { resultado: conHamburguesas } = await ejecutar('consultar_carta', {
            id_categoria: hamburguesas.id_categoria,
        });
        const nombres = conHamburguesas.productos.map((p) => p.nombre);
        expect(nombres).toContain('Hamburguesa clásica');
        expect(nombres).not.toContain('Menú del personal'); // visible = false

        const { resultado: conPostres } = await ejecutar('consultar_carta', {
            id_categoria: postres.id_categoria,
        });
        expect(conPostres.productos.map((p) => p.nombre)).not.toContain('Malteada de mora'); // disponible = false
    });
});

describe('buscar_producto', () => {
    it('encuentra TODOS los que comparten la palabra, no solo uno', async () => {
        const { resultado } = await ejecutar('buscar_producto', { termino: 'hamburguesa' });
        const nombres = resultado.productos.map((p) => p.nombre);

        expect(nombres).toEqual(expect.arrayContaining(['Hamburguesa clásica', 'Hamburguesa doble']));
    });

    it('tampoco por búsqueda sale lo que el negocio esconde', async () => {
        // `cartaService.buscarProductos` NO filtra `visible`: es la misma búsqueda que usa el
        // panel del negocio, donde ver lo oculto es justo lo que se quiere. Por el bot no puede
        // salir, así que el adaptador lo filtra. Sin esto, «menú del personal» —oculto a
        // propósito— aparecía en el chat de un cliente con solo escribir «menú».
        const { resultado } = await ejecutar('buscar_producto', { termino: 'personal' });
        expect(resultado.productos.map((p) => p.nombre)).not.toContain('Menú del personal');
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
        await asegurarCajaPrincipal(idNegocio);
        await sequelize.query(
            `
            INSERT INTO restaurante.pedid_orden
                (id_negocio, id_punto_caja, numero_orden, id_usuario, estado, tipo_pedido, contacto_telefono, total)
            VALUES (:n, (SELECT id_punto_caja FROM restaurante.rest_punto_caja
                          WHERE id_negocio = :n AND estado = 'A' ORDER BY orden LIMIT 1),
                    :num, :u, 'ABIERTA', 'DOMICILIO', :tel, 45000);
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

    // Un domicilio del bot ahora exige al menos un domiciliario registrado (para que nunca
    // llegue a Despacho sin nadie asignado) — sin esto, todas las pruebas de esta suite que
    // piden DOMICILIO fallarían con SIN_DOMICILIARIO_DISPONIBLE por algo que no están probando.
    beforeAll(async () => {
        const rolDom = await unaFila(
            `SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1;`
        );
        await sequelize.query(
            `INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
             VALUES (:u, :r, :n, 'A')
             ON CONFLICT DO NOTHING;`,
            { replacements: { u: principal.id_usuario, r: rolDom.id_rol, n: idNegocio } }
        );
    });

    afterAll(async () => {
        await sequelize.query(
            `DELETE FROM general.gener_usuario_rol
              WHERE id_usuario = :u AND id_negocio = :n
                AND id_rol = (SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1);`,
            { replacements: { u: principal.id_usuario, n: idNegocio } }
        );
    });

    function pedir(items, extra = {}) {
        return policyGate.ejecutar({
            capacidad: 'tomar_pedido',
            principal: contacto(),
            idNegocio,
            args: {
                items,
                cliente_nombre: 'BOT Cliente',
                tipo_entrega: 'DOMICILIO',
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

    describe('el horario de atención (2026-09-21)', () => {
        afterEach(() => horarioService.reemplazar({ idNegocio, idUsuario: null, bloques: [] }));

        it('fuera del horario configurado, no toma el pedido y no llega a mirar la caja', async () => {
            await abrirCaja(); // la caja SÍ está abierta: lo que tiene que cortar es el horario
            const [prod] = await idsDeCarta();
            const otroDia = (diaBogotaAhora() + 1) % 7; // nunca hoy, sea la hora que sea

            await horarioService.reemplazar({
                idNegocio, idUsuario: null,
                bloques: [{ dia_semana: otroDia, hora_inicio: '00:00', hora_fin: '23:59:59' }],
            });

            await expect(pedir([{ id_producto: prod.id_producto, cantidad: 1 }]))
                .rejects.toMatchObject({ code: 'FUERA_DE_HORARIO_ATENCION' });
        });

        it('dentro del horario pero con la caja cerrada, avisa que el negocio aún no abre', async () => {
            await cerrarCaja();
            const [prod] = await idsDeCarta();

            await horarioService.reemplazar({
                idNegocio, idUsuario: null,
                bloques: [{ dia_semana: diaBogotaAhora(), hora_inicio: '00:00', hora_fin: '23:59:59' }],
            });

            await expect(pedir([{ id_producto: prod.id_producto, cantidad: 1 }]))
                .rejects.toMatchObject({ code: 'NEGOCIO_AUN_NO_ABRE' });
        });

        it('dentro del horario y con la caja abierta, toma el pedido normal', async () => {
            await abrirCaja();
            const [prod] = await idsDeCarta();

            await horarioService.reemplazar({
                idNegocio, idUsuario: null,
                bloques: [{ dia_semana: diaBogotaAhora(), hora_inicio: '00:00', hora_fin: '23:59:59' }],
            });

            const { resultado } = await pedir([{ id_producto: prod.id_producto, cantidad: 1 }]);
            expect(resultado.numero_orden).toBeTruthy();
        });
    });

    describe('la llamada de prueba antes de preguntar (2026-09-21)', () => {
        // El fallo real: el cliente llegaba hasta «¿confirmo tu pedido?», decía que sí, y AHÍ
        // se enteraba de que el restaurante estaba cerrado — porque `requireCajaAbierta` vive
        // dentro de `ejecutar`, y sin confirmación el Gate nunca llegaba a llamarlo. El
        // manejador de modelo ya hace una llamada `dryRun: true` sin confirmar antes de
        // preguntar (intelligence/engine/manejadorLlm.js); esto prueba que el Gate la deja
        // llegar hasta el dominio en vez de cortarla antes.
        it('en seco y sin confirmar: si la caja está cerrada, se entera ANTES de preguntar', async () => {
            await cerrarCaja();
            const [prod] = await idsDeCarta();

            await expect(policyGate.ejecutar({
                capacidad: 'tomar_pedido',
                principal: contacto(),
                idNegocio,
                args: {
                    items: [{ id_producto: prod.id_producto, cantidad: 1 }],
                    cliente_nombre: 'BOT Preview Cerrado',
                    tipo_entrega: 'DOMICILIO',
                    direccion: 'Calle 10 # 5-30',
                },
                dryRun: true,
                // Sin confirmadoPor a propósito: es justo la llamada que se hace antes de
                // preguntar, cuando todavía no hay ningún sí que confirmar.
            })).rejects.toMatchObject({ code: 'RESTAURANTE_CERRADO' });
        });

        it('en seco y sin confirmar: si todo iría bien, deniega por falta de confirmación y no deja rastro', async () => {
            await abrirCaja();
            const [prod] = await idsDeCarta();

            await expect(policyGate.ejecutar({
                capacidad: 'tomar_pedido',
                principal: contacto(),
                idNegocio,
                args: {
                    items: [{ id_producto: prod.id_producto, cantidad: 1 }],
                    cliente_nombre: 'BOT Preview Ok',
                    tipo_entrega: 'DOMICILIO',
                    direccion: 'Calle 10 # 5-30',
                },
                dryRun: true,
            })).rejects.toMatchObject({ code: 'CONFIRMACION_REQUERIDA' });

            const fila = await unaFila(
                `SELECT 1 AS existe FROM restaurante.pedid_orden
                  WHERE id_negocio = :n AND contacto_nombre = 'BOT Preview Ok';`,
                { n: idNegocio },
            );
            expect(fila).toBeNull();
        });
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
                tipo_entrega: 'DOMICILIO',
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

    it('un domicilio nace con un domiciliario asignado, sin que nadie del negocio lo haga a mano', async () => {
        await abrirCaja();
        const [prod] = await idsDeCarta();
        const { resultado } = await pedir([{ id_producto: prod.id_producto, cantidad: 1 }]);

        const fila = await unaFila(
            `SELECT id_domiciliario FROM restaurante.pedid_orden WHERE numero_orden = :num AND id_negocio = :n;`,
            { num: resultado.numero_orden, n: idNegocio }
        );
        expect(fila.id_domiciliario).toBe(principal.id_usuario);
    });

    it('un pedido para RECOGER no necesita domiciliario', async () => {
        await abrirCaja();
        const [prod] = await idsDeCarta();
        const { resultado } = await pedir([{ id_producto: prod.id_producto, cantidad: 1 }], {
            tipo_entrega: 'LLEVAR',
        });

        const fila = await unaFila(
            `SELECT id_domiciliario, tipo_pedido FROM restaurante.pedid_orden WHERE numero_orden = :num AND id_negocio = :n;`,
            { num: resultado.numero_orden, n: idNegocio }
        );
        expect(fila.tipo_pedido).toBe('LLEVAR');
        expect(fila.id_domiciliario).toBeNull();
    });

    it('sin ningún domiciliario, un domicilio se rechaza en vez de crear uno sin nadie asignado', async () => {
        await abrirCaja();
        const [prod] = await idsDeCarta();

        await sequelize.query(
            `UPDATE general.gener_usuario_rol SET estado = 'I'
              WHERE id_usuario = :u AND id_negocio = :n
                AND id_rol = (SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1);`,
            { replacements: { u: principal.id_usuario, n: idNegocio } }
        );
        try {
            await expect(pedir([{ id_producto: prod.id_producto, cantidad: 1 }]))
                .rejects.toMatchObject({ code: 'SIN_DOMICILIARIO_DISPONIBLE' });
        } finally {
            await sequelize.query(
                `UPDATE general.gener_usuario_rol SET estado = 'A'
                  WHERE id_usuario = :u AND id_negocio = :n
                    AND id_rol = (SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1);`,
                { replacements: { u: principal.id_usuario, n: idNegocio } }
            );
        }
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
                    tipo_entrega: 'DOMICILIO',
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

describe('consultar_cuenta — tiquetera y fiado', () => {
    const TEL_CUENTA = '+573007776655';
    const TEL_SIN_CUENTA = '+573001110000';
    let permiteOriginal;

    beforeAll(async () => {
        permiteOriginal = (await unaFila(
            `SELECT permite_cuentas_cliente FROM general.gener_negocio WHERE id_negocio = :n;`,
            { n: idNegocio }
        ))?.permite_cuentas_cliente;
        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_cuentas_cliente = true WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } }
        );
    });

    afterAll(async () => {
        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_cuentas_cliente = :v WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio, v: Boolean(permiteOriginal) } }
        );
    });

    async function crearCuentaConSaldo(telefono, montoAbono) {
        const idPersona = await personaNegocioDao.resolverOCrear({
            idNegocio,
            telefono,
            nombre: 'BOT Cliente Cuenta',
        });
        const [cuenta] = await sequelize.query(
            `INSERT INTO restaurante.rest_cuenta (id_negocio, id_persona_negocio, modo, cupo, estado)
             VALUES (:n, :p, 'DINERO', 0, 'A') RETURNING id_cuenta;`,
            { replacements: { n: idNegocio, p: idPersona }, type: sequelize.QueryTypes.SELECT }
        );
        await sequelize.query(
            `INSERT INTO restaurante.rest_cuenta_movimiento (id_cuenta, id_negocio, tipo, monto, id_usuario, concepto)
             VALUES (:c, :n, 'ABONO', :monto, :u, 'BOT test abono');`,
            { replacements: { c: cuenta.id_cuenta, n: idNegocio, monto: montoAbono, u: principal.id_usuario } }
        );
    }

    it('el cliente ve su propio saldo a favor', async () => {
        await crearCuentaConSaldo(TEL_CUENTA, 50000);

        const { resultado } = await policyGate.ejecutar({
            capacidad: 'consultar_cuenta',
            principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_CUENTA }),
            idNegocio,
            args: {},
        });
        expect(resultado.modo).toBe('DINERO');
        expect(resultado.saldo).toBe(50000);
    });

    it('sin cuenta dice que no encuentra ninguna, no inventa un saldo en cero', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_cuenta',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_SIN_CUENTA }),
                idNegocio,
                args: {},
            })
        ).rejects.toMatchObject({ code: 'CUENTA_NO_ENCONTRADA' });
    });

    it('si el negocio no maneja cuentas de cliente, lo dice y no llega a buscar nada', async () => {
        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_cuentas_cliente = false WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } }
        );
        try {
            await expect(
                policyGate.ejecutar({
                    capacidad: 'consultar_cuenta',
                    principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_CUENTA }),
                    idNegocio,
                    args: {},
                })
            ).rejects.toMatchObject({ code: 'CUENTAS_NO_HABILITADAS' });
        } finally {
            await sequelize.query(
                `UPDATE general.gener_negocio SET permite_cuentas_cliente = true WHERE id_negocio = :n;`,
                { replacements: { n: idNegocio } }
            );
        }
    });

    it('sin teléfono probado por el canal (WebChat) no se puede saber de quién es', async () => {
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_cuenta',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: null }),
                idNegocio,
                args: {},
            })
        ).rejects.toMatchObject({ code: 'TELEFONO_NO_VERIFICADO' });
    });
});

describe('cancelar_pedido', () => {
    const TEL_CLIENTE = '+573005556677';

    async function crearOrdenCancelable(
        numero,
        { telefono = TEL_CLIENTE, estadoCocina = null, estadoPago = 'pendiente_pago', estado = 'ABIERTA' } = {}
    ) {
        await sequelize.query(
            `
            INSERT INTO restaurante.pedid_orden
                (id_negocio, numero_orden, id_usuario, estado, estado_cocina, estado_pago,
                 tipo_pedido, contacto_telefono, contacto_nombre, total)
            VALUES (:n, :num, :u, :estado, :cocina, :pago, 'DOMICILIO', :tel, 'BOT Cliente Cancelar', 30000);
            `,
            {
                replacements: {
                    n: idNegocio, num: numero, u: principal.id_usuario,
                    estado, cocina: estadoCocina, pago: estadoPago, tel: telefono,
                },
            }
        );
    }

    function cancelar(numeroOrden, { telefono = TEL_CLIENTE, confirmado = true } = {}) {
        return policyGate.ejecutar({
            capacidad: 'cancelar_pedido',
            principal: principalDeContacto(idNegocio, { telefonoVerificado: telefono }),
            idNegocio,
            args: { numero_orden: numeroOrden },
            ...(confirmado ? { confirmadoPor: { origen: 'test', texto: 'sí' } } : {}),
        });
    }

    it('el dueño cancela un pedido que la cocina todavía no ha tocado', async () => {
        await crearOrdenCancelable('ORD-9950');
        const { resultado } = await cancelar('ORD-9950');
        expect(resultado.estado).toBe('CANCELADA');

        const fila = await unaFila(
            `SELECT estado FROM restaurante.pedid_orden WHERE numero_orden = 'ORD-9950' AND id_negocio = :n;`,
            { n: idNegocio }
        );
        expect(fila.estado).toBe('CANCELADA');
    });

    it('otro número no lo puede cancelar, aunque acierte el número de orden', async () => {
        await crearOrdenCancelable('ORD-9951');
        await expect(cancelar('ORD-9951', { telefono: TEL_INTRUSO }))
            .rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('con la cocina ya preparándolo, no se cancela por aquí', async () => {
        await crearOrdenCancelable('ORD-9952', { estadoCocina: 'EN_PREPARACION' });
        await expect(cancelar('ORD-9952')).rejects.toMatchObject({ code: 'ORDEN_EN_PREPARACION' });
    });

    it('ya cobrado, no se cancela por aquí', async () => {
        await crearOrdenCancelable('ORD-9953', { estadoPago: 'pagado' });
        await expect(cancelar('ORD-9953')).rejects.toMatchObject({ code: 'ORDEN_NO_CANCELABLE' });
    });

    it('sin el sí explícito del cliente, el Gate no lo ejecuta', async () => {
        await crearOrdenCancelable('ORD-9954');
        await expect(cancelar('ORD-9954', { confirmado: false })).rejects.toBeDefined();

        const fila = await unaFila(
            `SELECT estado FROM restaurante.pedid_orden WHERE numero_orden = 'ORD-9954' AND id_negocio = :n;`,
            { n: idNegocio }
        );
        expect(fila.estado).toBe('ABIERTA');
    });

    it('cancelarlo dos veces no lo cancela dos veces: la segunda se rechaza', async () => {
        await crearOrdenCancelable('ORD-9955');
        await cancelar('ORD-9955');
        await expect(cancelar('ORD-9955')).rejects.toMatchObject({ code: 'ORDEN_YA_CANCELADA' });
    });
});

describe('agregar_items_pedido', () => {
    const TEL_CLIENTE = '+573005556688';
    let idProducto;
    let precioProducto;

    async function abrirCaja() {
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

    async function crearOrdenEditable(
        numero,
        { telefono = TEL_CLIENTE, estadoCocina = null, estadoPago = 'pendiente_pago', estado = 'ABIERTA' } = {}
    ) {
        await sequelize.query(
            `
            INSERT INTO restaurante.pedid_orden
                (id_negocio, numero_orden, id_usuario, estado, estado_cocina, estado_pago,
                 tipo_pedido, contacto_telefono, contacto_nombre, total)
            VALUES (:n, :num, :u, :estado, :cocina, :pago, 'DOMICILIO', :tel, 'BOT Cliente Agregar', 0);
            `,
            {
                replacements: {
                    n: idNegocio, num: numero, u: principal.id_usuario,
                    estado, cocina: estadoCocina, pago: estadoPago, tel: telefono,
                },
            }
        );
    }

    function agregar(numeroOrden, items, { telefono = TEL_CLIENTE, confirmado = true } = {}) {
        return policyGate.ejecutar({
            capacidad: 'agregar_items_pedido',
            principal: principalDeContacto(idNegocio, { telefonoVerificado: telefono }),
            idNegocio,
            args: { numero_orden: numeroOrden, items },
            ...(confirmado ? { confirmadoPor: { origen: 'test', texto: 'sí' } } : {}),
        });
    }

    beforeAll(async () => {
        const prod = await unaFila(
            `SELECT id_producto, precio FROM restaurante.carta_producto
              WHERE id_negocio = :n AND estado = 'A' AND disponible = true AND visible = true AND precio > 0
              LIMIT 1;`,
            { n: idNegocio }
        );
        idProducto = prod.id_producto;
        precioProducto = Number(prod.precio);
    });

    afterEach(cerrarCaja);

    it('agrega el producto y recalcula el total', async () => {
        await abrirCaja();
        await crearOrdenEditable('ORD-9970');

        const { resultado } = await agregar('ORD-9970', [{ id_producto: idProducto, cantidad: 2 }]);
        expect(resultado.items_agregados).toBe(1);
        expect(resultado.total).toBe(precioProducto * 2);

        const detalle = await unaFila(
            `SELECT COUNT(*)::int AS n FROM restaurante.pedid_detalle d
               JOIN restaurante.pedid_orden o USING (id_orden)
              WHERE o.numero_orden = 'ORD-9970' AND o.id_negocio = :neg AND d.id_producto = :p;`,
            { neg: idNegocio, p: idProducto }
        );
        expect(detalle.n).toBe(1);
    });

    it('otro número no le puede agregar nada, aunque acierte el número de orden', async () => {
        await abrirCaja();
        await crearOrdenEditable('ORD-9971');

        await expect(agregar('ORD-9971', [{ id_producto: idProducto, cantidad: 1 }], { telefono: TEL_INTRUSO }))
            .rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('un pedido que no existe dice que no existe', async () => {
        await abrirCaja();
        await expect(agregar('NO-EXISTE-9922', [{ id_producto: idProducto, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'PEDIDO_NO_ENCONTRADO' });
    });

    it('con la cocina ya preparándolo, no se le agrega nada', async () => {
        await abrirCaja();
        await crearOrdenEditable('ORD-9973', { estadoCocina: 'EN_PREPARACION' });
        await expect(agregar('ORD-9973', [{ id_producto: idProducto, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'ORDEN_EN_PREPARACION' });
    });

    it('ya cobrado, no se le agrega nada', async () => {
        await abrirCaja();
        await crearOrdenEditable('ORD-9974', { estadoPago: 'pagado' });
        await expect(agregar('ORD-9974', [{ id_producto: idProducto, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'ORDEN_NO_EDITABLE' });
    });

    it('con la caja cerrada, no se le agrega nada', async () => {
        await cerrarCaja();
        await crearOrdenEditable('ORD-9975');
        await expect(agregar('ORD-9975', [{ id_producto: idProducto, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'RESTAURANTE_CERRADO' });
    });

    it('un producto que ya no está en la carta se rechaza sin tocar el pedido', async () => {
        await abrirCaja();
        await crearOrdenEditable('ORD-9976');
        await expect(agregar('ORD-9976', [{ id_producto: 999999999, cantidad: 1 }]))
            .rejects.toMatchObject({ code: 'PRODUCTO_NO_DISPONIBLE' });

        const detalle = await unaFila(
            `SELECT COUNT(*)::int AS n FROM restaurante.pedid_detalle d
               JOIN restaurante.pedid_orden o USING (id_orden)
              WHERE o.numero_orden = 'ORD-9976' AND o.id_negocio = :neg;`,
            { neg: idNegocio }
        );
        expect(detalle.n).toBe(0);
    });

    it('sin el sí explícito del cliente, el Gate no lo ejecuta', async () => {
        await abrirCaja();
        await crearOrdenEditable('ORD-9977');
        await expect(agregar('ORD-9977', [{ id_producto: idProducto, cantidad: 1 }], { confirmado: false }))
            .rejects.toBeDefined();

        const detalle = await unaFila(
            `SELECT COUNT(*)::int AS n FROM restaurante.pedid_detalle d
               JOIN restaurante.pedid_orden o USING (id_orden)
              WHERE o.numero_orden = 'ORD-9977' AND o.id_negocio = :neg;`,
            { neg: idNegocio }
        );
        expect(detalle.n).toBe(0);
    });
});

describe('los textos que pidió el dueño (2026-09-21)', () => {
    const TEL_CLIENTE = '+573005556699';

    async function abrirCaja() {
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

    /** Un pedido REAL, con detalle de verdad — para leer los productos en la confirmación. */
    async function crearPedidoReal() {
        const { resultado: carta } = await ejecutar('buscar_producto', { termino: 'hamburguesa' });
        const prod = carta.productos[0];

        const { resultado } = await policyGate.ejecutar({
            capacidad: 'tomar_pedido',
            principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_CLIENTE }),
            idNegocio,
            args: {
                items: [{ id_producto: prod.id_producto, cantidad: 2 }],
                cliente_nombre: 'BOT Texto Confirmacion',
                tipo_entrega: 'LLEVAR',
            },
            confirmadoPor: { origen: 'test', texto: 'sí' },
        });
        return { numeroOrden: resultado.numero_orden, nombreProducto: prod.nombre };
    }

    afterEach(cerrarCaja);

    it('cancelar_pedido: la pregunta nombra los PRODUCTOS, no solo el número', async () => {
        await abrirCaja();
        const { numeroOrden, nombreProducto } = await crearPedidoReal();

        const texto = await registry.obtener('cancelar_pedido').confirmacion.pregunta({
            args: { numero_orden: numeroOrden },
            idNegocio,
        });
        expect(texto).toContain(nombreProducto);
        expect(texto).toMatch(/¿Estás seguro/i);
    });

    it('cancelar_pedido: sin detalle que mostrar, cae al número en vez de romperse', async () => {
        const texto = await registry.obtener('cancelar_pedido').confirmacion.pregunta({
            args: { numero_orden: 'ORD-NO-EXISTE-9999' },
            idNegocio,
        });
        expect(texto).toContain('ORD-NO-EXISTE-9999');
    });

    it('cancelar_pedido: el "hecho" es exactamente el texto pedido, sin el número', () => {
        const texto = registry.obtener('cancelar_pedido').confirmacion.hecho({
            resultado: { numero_orden: 'ORD-0043', estado: 'CANCELADA' },
        });
        expect(texto).toBe('Tu pedido fue cancelado.');
    });

    it('agregar_items_pedido: el "hecho" avisa que el precio puede variar', () => {
        const texto = registry.obtener('agregar_items_pedido').confirmacion.hecho({
            resultado: { numero_orden: 'ORD-0044', total: 45000 },
        });
        expect(texto).toContain('$45.000');
        expect(texto).toContain('empaques y domicilio');
    });
});
