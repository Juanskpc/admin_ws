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

const CAPACIDADES = ['consultar_carta', 'buscar_producto', 'consultar_estado_pedido'];
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
    await sequelize.query(`DELETE FROM restaurante.pedid_orden WHERE numero_orden LIKE 'TEST-REST%';`);
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
        await crearOrdenDePrueba('TEST-REST-1', TEL_DUENO);
        const { resultado } = await policyGate.ejecutar({
            capacidad: 'consultar_estado_pedido',
            principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_DUENO }),
            idNegocio,
            args: { numero_orden: 'TEST-REST-1' },
        });
        expect(resultado.numero_orden).toBe('TEST-REST-1');
        expect(resultado.total).toBe(45000);
    });

    it('otro número no lo ve, aunque acierte el número de orden', async () => {
        await crearOrdenDePrueba('TEST-REST-2', TEL_DUENO);
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_estado_pedido',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_INTRUSO }),
                idNegocio,
                args: { numero_orden: 'TEST-REST-2' },
            })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('un pedido de mesa, sin teléfono, no se consulta desde el canal', async () => {
        await crearOrdenDePrueba('TEST-REST-3', null);
        await expect(
            policyGate.ejecutar({
                capacidad: 'consultar_estado_pedido',
                principal: principalDeContacto(idNegocio, { telefonoVerificado: TEL_DUENO }),
                idNegocio,
                args: { numero_orden: 'TEST-REST-3' },
            })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_DE_QUIEN_PIDE' });
    });

    it('el NEGOCIO sí puede consultar cualquiera', async () => {
        await crearOrdenDePrueba('TEST-REST-4', TEL_DUENO);
        const { resultado } = await ejecutar('consultar_estado_pedido', { numero_orden: 'TEST-REST-4' });
        expect(resultado.numero_orden).toBe('TEST-REST-4');
    });

    it('un número que no existe dice que no existe, y no revienta', async () => {
        await expect(
            ejecutar('consultar_estado_pedido', { numero_orden: 'NO-EXISTE-999' })
        ).rejects.toMatchObject({ code: 'PEDIDO_NO_ENCONTRADO' });
    });
});
