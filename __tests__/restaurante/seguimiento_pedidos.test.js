/**
 * Sección «Movimientos» en Caja: el seguimiento del flujo mesero → caja
 * (`app_restaurante_api/services/seguimientoPedidoService.js`).
 *
 * Lo que se sostiene:
 *  1. El permiso `caja_ver_movimientos` se revalida en el servicio — apagado, ni
 *     el administrador entra (mismo criterio que `caja_eliminar_pedido`).
 *  2. Un pedido cobrado deja «tomado» (mesero) y «cobrado» (cajero, con método),
 *     y son personas DISTINTAS cuando de verdad lo son.
 *  3. Un pedido cancelado sin cobrar deja «cancelado» con el actor real —que NO
 *     sale de `pedid_orden` (esa columna se queda con el mesero), sino de
 *     `auditoria.audit_dato`—.
 *  4. Un pedido cobrado y luego anulado deja los tres pasos, cada uno con su
 *     propio actor.
 *  5. El resumen del rango cuenta bien: cobradas/canceladas/anuladas y sus montos.
 *
 * Corre contra la base de verdad. Necesita `Restaurante Demo` con carta y formas
 * de pago (`node scripts/seed_dev_local.js`).
 * Correr con: DB_PORT=5432 npx jest __tests__/restaurante/seguimiento_pedidos.test.js --forceExit
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const seguimientoService = require('../../app_restaurante_api/services/seguimientoPedidoService');
const { auditContext } = require('../../app_core/middleware/auditContext');

const sequelize = Models.sequelize;

let idNegocio;
let idMesero;
let idCajero;
let idProducto;
let precio;
let idMetodoPago;
let idCaja;
let cajaAbiertaPorLaSuite = false;
let idRolAdministrador;
let idNivelVerMovimientos;
let idNivelEliminarPedido;

const ordenesCreadas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

/** Ejecuta `fn` como si fuera un request del usuario `idUsuario` (mismo helper que auditoria_actor_restaurante.test.js). */
function comoRequest(idUsuario, fn) {
    return new Promise((resolve, reject) => {
        auditContext({ usuario: { id_usuario: idUsuario }, ip: '127.0.0.1' }, {}, () => {
            Promise.resolve().then(fn).then(resolve, reject);
        });
    });
}

async function fijarPermiso(idNivel, activo) {
    await sequelize.query(
        `INSERT INTO general.gener_nivel_negocio (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
         VALUES (:n, :r, :nv, :activo, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (id_negocio, id_rol, id_nivel)
         DO UPDATE SET puede_ver = :activo, fecha_actualizacion = CURRENT_TIMESTAMP;`,
        { replacements: { n: idNegocio, r: idRolAdministrador, nv: idNivel, activo } },
    );
}

async function crearPedido({ idUsuario = idMesero, tipoPedido = 'LLEVAR' } = {}) {
    const orden = await comoRequest(idUsuario, () => pedidoService.crearOrden({
        idNegocio, idUsuario, idMesa: null, nota: 'test seguimiento', tipoPedido,
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: precio, exclusiones: [] }],
    }));
    ordenesCreadas.push(orden.id_orden);
    return orden;
}

async function borrarOrden(idOrden) {
    for (const sql of [
        'DELETE FROM restaurante.rest_movimiento_caja WHERE id_orden = :o',
        'DELETE FROM restaurante.rest_pago_orden WHERE id_orden = :o',
        `DELETE FROM restaurante.pedid_detalle_exclu
          WHERE id_detalle IN (SELECT id_detalle FROM restaurante.pedid_detalle WHERE id_orden = :o)`,
        'DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o',
        `DELETE FROM auditoria.audit_dato WHERE esquema = 'restaurante' AND tabla = 'pedid_orden' AND pk_registro = :o::text`,
        'DELETE FROM restaurante.pedid_orden WHERE id_orden = :o',
    ]) {
        await sequelize.query(sql, { replacements: { o: idOrden } });
    }
}

beforeAll(async () => {
    const negocio = await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`);
    idNegocio = negocio?.id_negocio;

    const usuarios = await sequelize.query(
        `SELECT DISTINCT gu.id_usuario FROM general.gener_usuario_rol gnu
           JOIN general.gener_usuario gu ON gu.id_usuario = gnu.id_usuario
           JOIN general.gener_rol gr ON gr.id_rol = gnu.id_rol
          WHERE gnu.id_negocio = :n AND gnu.estado = 'A' AND gr.descripcion = 'ADMINISTRADOR'
          ORDER BY gu.id_usuario LIMIT 2;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    if (usuarios.length < 2) throw new Error('Hacen falta al menos 2 usuarios ADMINISTRADOR en Restaurante Demo.');
    [idMesero, idCajero] = usuarios.map((u) => u.id_usuario);

    idRolAdministrador = (await unaFila(`SELECT id_rol FROM general.gener_rol WHERE descripcion = 'ADMINISTRADOR' AND id_tipo_negocio = 1;`))?.id_rol;
    idNivelVerMovimientos = (await unaFila(`SELECT id_nivel FROM general.gener_nivel WHERE url = 'caja_ver_movimientos' AND id_tipo_negocio = 1 AND id_tipo_nivel = 4;`))?.id_nivel;
    idNivelEliminarPedido = (await unaFila(`SELECT id_nivel FROM general.gener_nivel WHERE url = 'caja_eliminar_pedido' AND id_tipo_negocio = 1 AND id_tipo_nivel = 4;`))?.id_nivel;
    if (!idNivelVerMovimientos) throw new Error('Falta el subnivel caja_ver_movimientos. Ejecuta npm run migrate:restaurante-caja-movimientos.');

    const producto = await unaFila(
        `SELECT id_producto, precio FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0 ORDER BY id_producto LIMIT 1;`,
        { n: idNegocio },
    );
    idProducto = producto?.id_producto;
    precio = Number(producto?.precio ?? 0);

    idMetodoPago = (await unaFila(
        `SELECT id_metodo_pago FROM restaurante.rest_metodo_pago WHERE id_negocio = :n AND estado = 'A' ORDER BY id_metodo_pago LIMIT 1;`,
        { n: idNegocio },
    ))?.id_metodo_pago;

    const abierta = await unaFila(`SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`, { n: idNegocio });
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({
            idNegocio, idUsuario: idMesero, montoApertura: 0, observaciones: 'test seguimiento',
        })).id_caja;
        cajaAbiertaPorLaSuite = true;
    }
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) await borrarOrden(idOrden);
    await sequelize.query(`DELETE FROM restaurante.rest_movimiento_caja WHERE id_caja = :c AND concepto LIKE 'test%';`, { replacements: { c: idCaja } });
    if (idNivelVerMovimientos) await fijarPermiso(idNivelVerMovimientos, false);
    if (idNivelEliminarPedido) await fijarPermiso(idNivelEliminarPedido, false);
    if (cajaAbiertaPorLaSuite) {
        await sequelize.query(`UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
    }
    await sequelize.close();
});

describe('el permiso se revalida en el servicio', () => {
    beforeAll(() => fijarPermiso(idNivelVerMovimientos, false));

    it('sin el permiso, ni el administrador puede ver el seguimiento', async () => {
        await expect(seguimientoService.listar({ idUsuario: idCajero, idNegocio }))
            .rejects.toMatchObject({ code: 'SIN_PERMISO_VER_MOVIMIENTOS', statusCode: 403 });
    });
});

describe('con el permiso concedido', () => {
    beforeAll(() => fijarPermiso(idNivelVerMovimientos, true));

    it('un pedido cobrado deja tomado (mesero) y cobrado (cajero), personas distintas', async () => {
        const orden = await crearPedido({ idUsuario: idMesero });
        await comoRequest(idCajero, () => pedidoService.cerrarOrden(orden.id_orden, { idUsuario: idCajero, idMetodoPago }));

        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, q: orden.numero_orden });
        const fila = r.rows.find((f) => f.id_orden === orden.id_orden);
        expect(fila.estado).toBe('CERRADA');

        const tomado = fila.eventos.find((e) => e.tipo === 'tomado');
        const cobrado = fila.eventos.find((e) => e.tipo === 'cobrado');
        expect(tomado.id_usuario).toBe(idMesero);
        expect(cobrado.id_usuario).toBe(idCajero);
        expect(cobrado.id_usuario).not.toBe(tomado.id_usuario);
        expect(Number(cobrado.monto)).toBeCloseTo(precio, 5);
        expect(cobrado.metodo_pago).toBeTruthy();
    });

    it('un pedido cancelado sin cobrar deja el actor REAL, no el mesero que lo creó', async () => {
        const orden = await crearPedido({ idUsuario: idMesero });
        // El mesero la toma; OTRA persona (el cajero) la cancela desde el panel.
        await comoRequest(idCajero, () => pedidoService.cancelarOrden(orden.id_orden, { idUsuario: idCajero }));

        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, q: orden.numero_orden });
        const fila = r.rows.find((f) => f.id_orden === orden.id_orden);
        expect(fila.estado).toBe('CANCELADA');

        const tomado = fila.eventos.find((e) => e.tipo === 'tomado');
        const cancelado = fila.eventos.find((e) => e.tipo === 'cancelado');
        expect(tomado.id_usuario).toBe(idMesero);
        // La prueba de verdad: pedid_orden.id_usuario NUNCA cambió (sigue siendo el mesero),
        // así que si esto pasa es porque el dato vino de auditoria.audit_dato.
        expect(cancelado.id_usuario).toBe(idCajero);
        expect(cancelado).toBeTruthy();
    });

    it('un pedido cobrado y luego anulado deja los tres pasos, cada uno con su actor', async () => {
        await fijarPermiso(idNivelEliminarPedido, true);
        const orden = await crearPedido({ idUsuario: idMesero });
        await comoRequest(idCajero, () => pedidoService.cerrarOrden(orden.id_orden, { idUsuario: idCajero, idMetodoPago }));

        const otroUsuario = idMesero; // un tercer rol no existe en el seed: reutiliza el mesero como "quien anula"
        await comoRequest(otroUsuario, () => cajaService.anularOrdenCobrada({ idNegocio, idOrden: orden.id_orden, idUsuario: otroUsuario }));

        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, q: orden.numero_orden });
        const fila = r.rows.find((f) => f.id_orden === orden.id_orden);
        expect(fila.estado).toBe('ANULADA');

        const tipos = fila.eventos.map((e) => e.tipo);
        expect(tipos).toEqual(['tomado', 'cobrado', 'anulado']);
        const anulado = fila.eventos.find((e) => e.tipo === 'anulado');
        expect(anulado.id_usuario).toBe(otroUsuario);
        expect(Number(anulado.monto)).toBeCloseTo(precio, 5);
    });

    it('el resumen del rango cuenta bien lo cobrado y lo no cobrado', async () => {
        const cobrada = await crearPedido();
        await comoRequest(idCajero, () => pedidoService.cerrarOrden(cobrada.id_orden, { idUsuario: idCajero, idMetodoPago }));

        const cancelada = await crearPedido();
        await comoRequest(idCajero, () => pedidoService.cancelarOrden(cancelada.id_orden, { idUsuario: idCajero }));

        const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, desde: hoy, hasta: hoy, limite: 100 });

        expect(r.resumen.cobradas).toBeGreaterThanOrEqual(1);
        expect(r.resumen.canceladas).toBeGreaterThanOrEqual(1);
        expect(Number(r.resumen.monto_cobrado)).toBeGreaterThanOrEqual(precio);
        expect(Number(r.resumen.monto_no_cobrado)).toBeGreaterThanOrEqual(precio);
    });

    it('filtra por estado', async () => {
        const orden = await crearPedido();
        await comoRequest(idCajero, () => pedidoService.cancelarOrden(orden.id_orden, { idUsuario: idCajero }));

        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, estado: 'CANCELADA', limite: 100 });
        expect(r.rows.every((f) => f.estado === 'CANCELADA')).toBe(true);
        expect(r.rows.some((f) => f.id_orden === orden.id_orden)).toBe(true);
    });

    it('busca por número de orden', async () => {
        const orden = await crearPedido();
        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, q: orden.numero_orden });
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].id_orden).toBe(orden.id_orden);
    });

    it('un pedido todavía abierto no tiene evento de cierre', async () => {
        const orden = await crearPedido();
        const r = await seguimientoService.listar({ idUsuario: idCajero, idNegocio, q: orden.numero_orden });
        const fila = r.rows.find((f) => f.id_orden === orden.id_orden);
        expect(fila.estado).toBe('ABIERTA');
        expect(fila.eventos.map((e) => e.tipo)).toEqual(['tomado']);
    });

    it('un rango de fechas invertido se rechaza', async () => {
        await expect(seguimientoService.listar({ idUsuario: idCajero, idNegocio, desde: '2026-01-10', hasta: '2026-01-01' }))
            .rejects.toMatchObject({ code: 'RANGO_FECHAS_INVALIDO' });
    });
});
