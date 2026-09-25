/**
 * `tomar_pedido` con barrio (precio de domicilio) y con mesa («en el local»), 2026-09-24.
 *
 * Contra la base de verdad. Lo que se prueba es quién manda:
 *  - el valor del domicilio sale de la tabla de barrios, no de lo que diga el mensaje;
 *  - un barrio o una mesa de OTRO negocio (o borrados) se rechazan con error tipado;
 *  - un pedido de mesa no exige dirección ni teléfono y no entra a Despacho.
 *
 * Necesita `scripts/fixtures/dev_carta_restaurante.sql` (igual que capacidades_restaurante).
 */
'use strict';

require('dotenv').config();
process.env.FEATURES_FORZADAS = 'asistente_ia';

const { asegurarCajaPrincipal } = require('../../app_core/helpers/cajaPrincipal');
const Models = require('../../app_core/models/conection');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const { principalDeContacto } = require('../../intelligence/engine/identidad');
const intelligence = require('../../intelligence');
const policyGate = require('../../intelligence/core/policyGate');
const registry = require('../../intelligence/core/registry');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');

const sequelize = Models.sequelize;
const TEL = '+573005550101';

let idNegocio;
let idRival;
let principalAdmin;
let idProducto;
let idBarrio;
let idBarrioRival;
let idMesa;
let idMesaRival;
let rolDomiciliario;
let flagOriginal;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

const contacto = () => principalDeContacto(idNegocio, { telefonoVerificado: TEL });

function pedir(args) {
    return policyGate.ejecutar({
        capacidad: 'tomar_pedido',
        principal: contacto(),
        idNegocio,
        args: {
            items: [{ id_producto: idProducto, cantidad: 1 }],
            cliente_nombre: 'BOT Barrio',
            ...args,
        },
        confirmadoPor: { origen: 'test', texto: 'sí' },
    });
}

async function ordenDe(numero) {
    return unaFila(
        `SELECT tipo_pedido, id_mesa, valor_domicilio, total, subtotal, contacto_telefono, direccion_domicilio
           FROM restaurante.pedid_orden WHERE id_negocio = :n AND numero_orden = :num;`,
        { n: idNegocio, num: numero }
    );
}

async function abrirCaja() {
    await asegurarCajaPrincipal(idNegocio);
    await sequelize.query(
        `INSERT INTO restaurante.rest_caja (id_negocio, id_punto_caja, id_usuario, monto_apertura, estado, fecha_apertura)
         SELECT :n, (SELECT id_punto_caja FROM restaurante.rest_punto_caja
                      WHERE id_negocio = :n AND estado = 'A' ORDER BY orden LIMIT 1), :u, 0, 'A', now()
          WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A');`,
        { replacements: { n: idNegocio, u: principalAdmin.id_usuario } }
    );
}

beforeAll(async () => {
    intelligence.arrancar();
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idRival = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';`)).id_negocio;
    flagOriginal = (await unaFila(
        `SELECT permite_pago_domicilio AS f FROM general.gener_negocio WHERE id_negocio = :n;`, { n: idNegocio }
    )).f;

    const idUsuario = (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = '1000000002';`)).id_usuario;
    principalAdmin = await resolverPrincipalUsuario(idUsuario);

    await sequelize.query(
        `INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada)
         VALUES (:n, 'tomar_pedido', true)
         ON CONFLICT (id_negocio, capacidad) DO UPDATE SET habilitada = true;`,
        { replacements: { n: idNegocio } }
    );

    idProducto = (await unaFila(
        `SELECT id_producto FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND disponible AND visible ORDER BY id_producto LIMIT 1;`,
        { n: idNegocio }
    )).id_producto;

    // Hace falta un domiciliario para poder crear un DOMICILIO desde el bot.
    rolDomiciliario = await unaFila(
        `SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1;`
    );
    await sequelize.query(
        `INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
         VALUES (:u, :r, :n, 'A') ON CONFLICT DO NOTHING;`,
        { replacements: { u: principalAdmin.id_usuario, r: rolDomiciliario.id_rol, n: idNegocio } }
    );

    idBarrio = (await unaFila(
        `INSERT INTO restaurante.rest_barrio_domicilio (id_negocio, nombre, valor)
         VALUES (:n, 'TEST-Barrio Cobro', 4500) RETURNING id_barrio;`, { n: idNegocio }
    )).id_barrio;
    idBarrioRival = (await unaFila(
        `INSERT INTO restaurante.rest_barrio_domicilio (id_negocio, nombre, valor)
         VALUES (:n, 'TEST-Barrio Ajeno', 9999) RETURNING id_barrio;`, { n: idRival }
    )).id_barrio;
    idMesa = (await unaFila(
        `INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero) VALUES (:n, 'TEST-Mesa', 9001)
         RETURNING id_mesa;`, { n: idNegocio }
    )).id_mesa;
    idMesaRival = (await unaFila(
        `INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero) VALUES (:n, 'TEST-Mesa Ajena', 9002)
         RETURNING id_mesa;`, { n: idRival }
    )).id_mesa;
});

afterAll(async () => {
    await sequelize.query(
        `DELETE FROM restaurante.pedid_detalle WHERE id_orden IN (
            SELECT id_orden FROM restaurante.pedid_orden
             WHERE id_negocio = :n AND (contacto_nombre = 'BOT Barrio' OR nota LIKE 'WhatsApp: BOT Barrio%'));`,
        { replacements: { n: idNegocio } }
    );
    await sequelize.query(
        `DELETE FROM restaurante.pedid_orden
          WHERE id_negocio = :n AND (contacto_nombre = 'BOT Barrio' OR nota LIKE 'WhatsApp: BOT Barrio%');`,
        { replacements: { n: idNegocio } }
    );
    await sequelize.query(
        `DELETE FROM restaurante.pedid_detalle WHERE id_orden IN (
            SELECT id_orden FROM restaurante.pedid_orden WHERE id_mesa IN (
                SELECT id_mesa FROM restaurante.rest_mesa WHERE nombre LIKE 'TEST-%'));`
    );
    await sequelize.query(
        `DELETE FROM restaurante.pedid_orden WHERE id_mesa IN (
            SELECT id_mesa FROM restaurante.rest_mesa WHERE nombre LIKE 'TEST-%');`
    );
    await sequelize.query(`DELETE FROM restaurante.rest_barrio_domicilio WHERE nombre LIKE 'TEST-%';`);
    await sequelize.query(`DELETE FROM restaurante.rest_mesa WHERE nombre LIKE 'TEST-%';`);
    await sequelize.query(
        `DELETE FROM general.gener_usuario_rol WHERE id_usuario = :u AND id_negocio = :n AND id_rol = :r;`,
        { replacements: { u: principalAdmin.id_usuario, n: idNegocio, r: rolDomiciliario.id_rol } }
    );
    await sequelize.query(
        `UPDATE general.gener_negocio SET permite_pago_domicilio = :f WHERE id_negocio = :n;`,
        { replacements: { f: flagOriginal, n: idNegocio } }
    );
    await sequelize.query(
        `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_negocio = :n AND estado = 'A';`,
        { replacements: { n: idNegocio } }
    );
    intelligence._reiniciar();
    await sequelize.close();
});

beforeEach(abrirCaja);

describe('domicilio por barrio', () => {
    const domicilio = { tipo_entrega: 'DOMICILIO', direccion: 'Calle 10 # 5-30, apto 201' };

    it('con el cobro de domicilio encendido, el valor sale de la TABLA de barrios', async () => {
        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_pago_domicilio = true WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } }
        );
        const { resultado } = await pedir({ ...domicilio, id_barrio: idBarrio });
        const orden = await ordenDe(resultado.numero_orden);

        expect(Number(orden.valor_domicilio)).toBe(4500);
        expect(Number(orden.total)).toBe(Number(orden.subtotal) + 4500);
    });

    it('sin barrio («Otro barrio») el domicilio entra en 0 para que el cajero lo ajuste', async () => {
        const { resultado } = await pedir(domicilio);
        const orden = await ordenDe(resultado.numero_orden);
        expect(Number(orden.valor_domicilio)).toBe(0);
    });

    it('con el cobro de domicilio APAGADO no se cobra nada aunque llegue un barrio', async () => {
        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_pago_domicilio = false WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } }
        );
        const { resultado } = await pedir({ ...domicilio, id_barrio: idBarrio });
        expect(Number((await ordenDe(resultado.numero_orden)).valor_domicilio)).toBe(0);
    });

    it('un barrio de OTRO negocio o inexistente se rechaza con ZONA_INVALIDA', async () => {
        await expect(pedir({ ...domicilio, id_barrio: idBarrioRival }))
            .rejects.toMatchObject({ code: 'ZONA_INVALIDA', statusCode: 400 });
        await expect(pedir({ ...domicilio, id_barrio: 987654321 }))
            .rejects.toMatchObject({ code: 'ZONA_INVALIDA' });
    });

    it('un barrio borrado (estado E) ya no vale', async () => {
        const borrado = (await unaFila(
            `INSERT INTO restaurante.rest_barrio_domicilio (id_negocio, nombre, valor, estado)
             VALUES (:n, 'TEST-Borrado', 1000, 'E') RETURNING id_barrio;`, { n: idNegocio }
        )).id_barrio;
        await expect(pedir({ ...domicilio, id_barrio: borrado }))
            .rejects.toMatchObject({ code: 'ZONA_INVALIDA' });
    });

    it('la pregunta de confirmación enseña el domicilio y lo suma al total ANTES del sí', async () => {
        await sequelize.query(
            `UPDATE general.gener_negocio SET permite_pago_domicilio = true WHERE id_negocio = :n;`,
            { replacements: { n: idNegocio } }
        );
        const texto = await registry.obtener('tomar_pedido').confirmacion.pregunta({
            idNegocio,
            args: {
                items: [{ id_producto: idProducto, cantidad: 1 }],
                cliente_nombre: 'Ana',
                ...domicilio,
                id_barrio: idBarrio,
            },
        });
        expect(texto).toContain('Domicilio (TEST-Barrio Cobro)');
        expect(texto).toContain('4.500');
    });
});

describe('pedido en el local (MESA)', () => {
    it('entra como MESA con su id_mesa, sin dirección ni teléfono obligatorios', async () => {
        const { resultado } = await pedir({ tipo_entrega: 'MESA', id_mesa: idMesa });
        const orden = await ordenDe(resultado.numero_orden);

        expect(orden.tipo_pedido).toBe('MESA');
        expect(orden.id_mesa).toBe(idMesa);
        expect(orden.direccion_domicilio).toBeNull();
        expect(Number(orden.valor_domicilio)).toBe(0);
    });

    it('no entra a Despacho (que solo lista LLEVAR y DOMICILIO)', async () => {
        const { resultado } = await pedir({ tipo_entrega: 'MESA', id_mesa: idMesa });
        expect((await ordenDe(resultado.numero_orden)).tipo_pedido).not.toMatch(/LLEVAR|DOMICILIO/);
    });

    it('una mesa de OTRO negocio o inexistente se rechaza con MESA_INVALIDA', async () => {
        await expect(pedir({ tipo_entrega: 'MESA', id_mesa: idMesaRival }))
            .rejects.toMatchObject({ code: 'MESA_INVALIDA', statusCode: 400 });
        await expect(pedir({ tipo_entrega: 'MESA', id_mesa: 987654321 }))
            .rejects.toMatchObject({ code: 'MESA_INVALIDA' });
    });

    it('una mesa desactivada ya no vale', async () => {
        const off = (await unaFila(
            `INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero, estado)
             VALUES (:n, 'TEST-Mesa Off', 9003, 'I') RETURNING id_mesa;`, { n: idNegocio }
        )).id_mesa;
        await expect(pedir({ tipo_entrega: 'MESA', id_mesa: off }))
            .rejects.toMatchObject({ code: 'MESA_INVALIDA' });
    });

    it('sin id_mesa pide la mesa (MESA_REQUERIDA)', async () => {
        await expect(pedir({ tipo_entrega: 'MESA' }))
            .rejects.toMatchObject({ code: 'MESA_REQUERIDA' });
    });

    it('la pregunta de confirmación nombra la mesa', async () => {
        // Mesa propia: la compartida de este bloque ya tiene cuenta abierta por los pedidos de arriba.
        const idMesaLibre = (await unaFila(
            `INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero) VALUES (:n, 'TEST-Mesa Libre', 9050)
             RETURNING id_mesa;`, { n: idNegocio }
        )).id_mesa;
        const texto = await registry.obtener('tomar_pedido').confirmacion.pregunta({
            idNegocio,
            args: {
                items: [{ id_producto: idProducto, cantidad: 1 }],
                cliente_nombre: 'Ana',
                tipo_entrega: 'MESA',
                id_mesa: idMesaLibre,
            },
        });
        expect(texto).toContain('para tu mesa (TEST-Mesa Libre)');
    });
});

describe('pedido en el local sobre una mesa que YA tiene cuenta abierta', () => {
    // Mesas y cobro asumen UNA cuenta activa por mesa: una orden nueva quedaría huérfana.
    let n = 9100;
    const mesaNueva = async () =>
        (await unaFila(
            `INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero) VALUES (:n, :nom, :num)
             RETURNING id_mesa;`,
            { n: idNegocio, nom: `TEST-Cuenta ${++n}`, num: n }
        )).id_mesa;

    /** Lo que hace el mesero en el POS: abrir la cuenta de la mesa. */
    async function meseroAbreCuenta(idMesaX) {
        const { precio } = await unaFila(
            `SELECT precio FROM restaurante.carta_producto WHERE id_producto = :p;`, { p: idProducto }
        );
        return pedidoService.crearOrden({
            idNegocio,
            idUsuario: principalAdmin.id_usuario,
            idMesa: idMesaX,
            tipoPedido: 'MESA',
            nota: 'TEST-POS',
            items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: Number(precio) }],
        });
    }

    const abiertas = (idMesaX) =>
        unaFila(
            `SELECT count(*)::int AS n FROM restaurante.pedid_orden
              WHERE id_mesa = :m AND estado = 'ABIERTA';`, { m: idMesaX }
        ).then((f) => f.n);

    const unidades = (idOrden) =>
        unaFila(
            `SELECT COALESCE(SUM(cantidad),0)::int AS n FROM restaurante.pedid_detalle WHERE id_orden = :o;`,
            { o: idOrden }
        ).then((f) => f.n);

    it('se SUMA a la cuenta del mesero: sigue habiendo UNA orden abierta y con más productos', async () => {
        const m = await mesaNueva();
        const cuenta = await meseroAbreCuenta(m);

        const { resultado } = await pedir({
            tipo_entrega: 'MESA', id_mesa: m, items: [{ id_producto: idProducto, cantidad: 2 }],
        });

        expect(resultado.suma_a_cuenta).toBe(true);
        expect(resultado.numero_orden).toBe(cuenta.numero_orden);
        expect(await abiertas(m)).toBe(1);
        expect(await unidades(cuenta.id_orden)).toBe(3); // 1 del mesero + 2 del cliente
        // Lo del bot queda identificable por línea; la nota de la orden (del mesero) no se toca.
        const notas = await sequelize.query(
            `SELECT nota FROM restaurante.pedid_detalle WHERE id_orden = :o ORDER BY id_detalle;`,
            { replacements: { o: cuenta.id_orden }, type: sequelize.QueryTypes.SELECT }
        );
        expect(notas.map((x) => x.nota)).toContain('WhatsApp: BOT Barrio');
        expect(notas[0].nota).toBeNull(); // la línea del mesero, intacta
        const { nota } = await unaFila(
            `SELECT nota FROM restaurante.pedid_orden WHERE id_orden = :o;`, { o: cuenta.id_orden }
        );
        expect(nota).toBe('TEST-POS');
        const { total } = await unaFila(
            `SELECT total FROM restaurante.pedid_orden WHERE id_orden = :o;`, { o: cuenta.id_orden }
        );
        expect(Number(total)).toBeGreaterThan(Number(cuenta.total));
    });

    it('la nota especial del cliente («sin sal en todo») viaja en la marca de cada línea que suma', async () => {
        const m = await mesaNueva();
        const cuenta = await meseroAbreCuenta(m);

        await pedir({
            tipo_entrega: 'MESA',
            id_mesa: m,
            nota: 'sin sal en todo',
            items: [{ id_producto: idProducto, cantidad: 1 }],
        });

        const notas = await sequelize.query(
            `SELECT nota FROM restaurante.pedid_detalle WHERE id_orden = :o ORDER BY id_detalle;`,
            { replacements: { o: cuenta.id_orden }, type: sequelize.QueryTypes.SELECT }
        );
        // Sin esto la nota se perdía: la de la orden es del mesero y no se toca.
        expect(notas.map((x) => x.nota)).toContain('WhatsApp: BOT Barrio — sin sal en todo');
    });

    it('aunque la cocina ya esté preparando la cuenta de la mesa (el POS también lo permite)', async () => {
        const m = await mesaNueva();
        const cuenta = await meseroAbreCuenta(m);
        await sequelize.query(
            `UPDATE restaurante.pedid_orden SET estado_cocina = 'EN_PREPARACION' WHERE id_orden = :o;`,
            { replacements: { o: cuenta.id_orden } }
        );

        const { resultado } = await pedir({ tipo_entrega: 'MESA', id_mesa: m });
        expect(resultado.suma_a_cuenta).toBe(true);
        expect(await abiertas(m)).toBe(1);
    });

    it('dos pedidos seguidos por la misma mesa: el primero abre la cuenta y el segundo se suma', async () => {
        const m = await mesaNueva();
        const a = await pedir({ tipo_entrega: 'MESA', id_mesa: m });
        const b = await pedir({ tipo_entrega: 'MESA', id_mesa: m });

        expect(a.resultado.suma_a_cuenta).toBeUndefined();
        expect(b.resultado.suma_a_cuenta).toBe(true);
        expect(b.resultado.numero_orden).toBe(a.resultado.numero_orden);
        expect(await abiertas(m)).toBe(1);
    });

    it('una cuenta ya CERRADA no se toca: la mesa libre recibe una orden nueva', async () => {
        const m = await mesaNueva();
        const cuenta = await meseroAbreCuenta(m);
        await sequelize.query(
            `UPDATE restaurante.pedid_orden SET estado = 'CERRADA' WHERE id_orden = :o;`,
            { replacements: { o: cuenta.id_orden } }
        );

        const { resultado } = await pedir({ tipo_entrega: 'MESA', id_mesa: m });
        expect(resultado.suma_a_cuenta).toBeUndefined();
        expect(resultado.numero_orden).not.toBe(cuenta.numero_orden);
    });

    it('al abrir una cuenta nueva la mesa queda OCUPADA y con reloj, como en el POS', async () => {
        const m = await mesaNueva();
        await pedir({ tipo_entrega: 'MESA', id_mesa: m });

        const fila = await unaFila(
            `SELECT estado_servicio, fecha_inicio_servicio FROM restaurante.rest_mesa WHERE id_mesa = :m;`,
            { m }
        );
        expect(fila.estado_servicio).toBe('OCUPADA');
        expect(fila.fecha_inicio_servicio).not.toBeNull();
    });

    it('no pisa una mesa que ya estaba POR_COBRAR', async () => {
        const m = await mesaNueva();
        await meseroAbreCuenta(m);
        await sequelize.query(
            `UPDATE restaurante.rest_mesa SET estado_servicio = 'POR_COBRAR' WHERE id_mesa = :m;`,
            { replacements: { m } }
        );

        await pedir({ tipo_entrega: 'MESA', id_mesa: m });
        const { e } = await unaFila(
            `SELECT estado_servicio AS e FROM restaurante.rest_mesa WHERE id_mesa = :m;`, { m }
        );
        expect(e).toBe('POR_COBRAR');
    });

    it('la confirmación dice «sumarlo a la cuenta de tu mesa» solo si hay cuenta abierta', async () => {
        const conCuenta = await mesaNueva();
        await meseroAbreCuenta(conCuenta);
        const libre = await mesaNueva();
        const pregunta = (id) =>
            registry.obtener('tomar_pedido').confirmacion.pregunta({
                idNegocio,
                args: {
                    items: [{ id_producto: idProducto, cantidad: 1 }],
                    cliente_nombre: 'Ana',
                    tipo_entrega: 'MESA',
                    id_mesa: id,
                },
            });

        expect(await pregunta(conCuenta)).toContain('sumarlo a la cuenta de tu mesa');
        expect(await pregunta(libre)).not.toContain('sumarlo');
    });

    it('el dry-run (Gate) no deja rastro: ni orden ni productos añadidos', async () => {
        const m = await mesaNueva();
        const cuenta = await meseroAbreCuenta(m);
        await policyGate.ejecutar({
            capacidad: 'tomar_pedido',
            principal: contacto(),
            idNegocio,
            args: {
                items: [{ id_producto: idProducto, cantidad: 5 }],
                cliente_nombre: 'BOT Barrio',
                tipo_entrega: 'MESA',
                id_mesa: m,
            },
            dryRun: true,
        }).catch(() => null);

        expect(await unidades(cuenta.id_orden)).toBe(1);
        expect(await abiertas(m)).toBe(1);
    });
});
