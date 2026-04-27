'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, tipo, desde, hasta, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (tipo) where.tipo = tipo;
    if (desde || hasta) {
        where.fecha_movimiento = {};
        if (desde) where.fecha_movimiento[Op.gte] = new Date(desde);
        if (hasta) {
            const d = new Date(hasta);
            d.setDate(d.getDate() + 1);
            where.fecha_movimiento[Op.lt] = d;
        }
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.TiendaMovimiento.findAndCountAll({
        where, offset, limit: pageSize,
        order: [['fecha_movimiento', 'DESC']],
        include: [
            { model: Models.GenerUsuario, as: 'usuario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'], required: false },
            {
                model: Models.TiendaMovDetalle, as: 'detalles', required: false,
                include: [{ model: Models.TiendaProducto, as: 'producto', attributes: ['id_producto', 'nombre', 'sku', 'unidad_medida'] }],
            },
        ],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function getById(idMovimiento, idNegocio) {
    return Models.TiendaMovimiento.findOne({
        where: { id_movimiento: idMovimiento, id_negocio: idNegocio },
        include: [
            { model: Models.GenerUsuario, as: 'usuario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'], required: false },
            {
                model: Models.TiendaMovDetalle, as: 'detalles',
                include: [{ model: Models.TiendaProducto, as: 'producto', attributes: ['id_producto', 'nombre', 'sku', 'unidad_medida'] }],
            },
        ],
    });
}

/**
 * Crea un movimiento y actualiza el stock según el tipo:
 *   ENTRADA   → suma stock
 *   SALIDA    → resta stock (falla si insuficiente)
 *   AJUSTE    → fija el stock al valor de cantidad en el detalle
 *   DEVOLUCION → suma stock (igual que ENTRADA)
 *   TRASLADO  → resta stock (igual que SALIDA)
 *
 * @param {object} params
 * @param {number} params.idNegocio
 * @param {string} params.tipo
 * @param {string} [params.referencia]
 * @param {string} [params.observacion]
 * @param {number} [params.idUsuario]
 * @param {Array<{id_producto:number, cantidad:number, costo_unitario?:number}>} params.items
 */
async function crear({ idNegocio, tipo, referencia, observacion, idUsuario, items }) {
    if (!Array.isArray(items) || items.length === 0) {
        const e = new Error('Items requeridos'); e.statusCode = 422; throw e;
    }

    const tiposPermitidos = ['ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION', 'TRASLADO'];
    if (!tiposPermitidos.includes(tipo)) {
        const e = new Error(`Tipo de movimiento inválido: ${tipo}`); e.statusCode = 422; throw e;
    }

    const t = await Models.sequelize.transaction();
    try {
        const idsProducto = [...new Set(items.map(i => Number(i.id_producto)))];
        const productos = await Models.TiendaProducto.findAll({
            where: { id_producto: idsProducto, id_negocio: idNegocio, estado: 'A' },
            transaction: t, lock: t.LOCK.UPDATE,
        });

        const mapProductos = new Map(productos.map(p => [p.id_producto, p]));
        if (mapProductos.size !== idsProducto.length) {
            await t.rollback();
            const e = new Error('Algún producto no existe o está inactivo'); e.statusCode = 404; throw e;
        }

        // Para SALIDA y TRASLADO verificar stock
        if (tipo === 'SALIDA' || tipo === 'TRASLADO') {
            const faltantes = [];
            for (const item of items) {
                const p = mapProductos.get(Number(item.id_producto));
                if (!p.es_servicio && Number(p.stock_actual) < Number(item.cantidad)) {
                    faltantes.push({
                        id_producto: p.id_producto,
                        nombre: p.nombre,
                        stock_actual: Number(p.stock_actual),
                        requerido: Number(item.cantidad),
                    });
                }
            }
            if (faltantes.length > 0) {
                await t.rollback();
                const e = new Error('Stock insuficiente para uno o más productos.');
                e.statusCode = 409; e.code = 'STOCK_INSUFICIENTE'; e.faltantes = faltantes;
                throw e;
            }
        }

        // Crear cabecera del movimiento
        const movimiento = await Models.TiendaMovimiento.create({
            id_negocio: idNegocio,
            tipo,
            referencia: referencia || null,
            observacion: observacion || null,
            id_usuario: idUsuario || null,
            total_items: items.length,
            estado: 'CONFIRMADO',
        }, { transaction: t });

        // Crear detalles y actualizar stock
        for (const item of items) {
            const p = mapProductos.get(Number(item.id_producto));
            const cantidad = Number(item.cantidad);

            await Models.TiendaMovDetalle.create({
                id_movimiento: movimiento.id_movimiento,
                id_producto: p.id_producto,
                id_negocio: idNegocio,
                cantidad,
                costo_unitario: item.costo_unitario != null ? Number(item.costo_unitario) : null,
            }, { transaction: t });

            // Actualizar stock según tipo
            let nuevoStock;
            if (tipo === 'AJUSTE') {
                nuevoStock = cantidad; // SET al valor indicado
            } else if (tipo === 'ENTRADA' || tipo === 'DEVOLUCION') {
                nuevoStock = Number(p.stock_actual) + cantidad;
            } else {
                // SALIDA, TRASLADO
                nuevoStock = Number(p.stock_actual) - cantidad;
            }

            await p.update({ stock_actual: nuevoStock, fecha_actualizacion: new Date() }, { transaction: t });
        }

        await t.commit();
        return getById(movimiento.id_movimiento, idNegocio);
    } catch (err) {
        if (!t.finished) { try { await t.rollback(); } catch { /* */ } }
        throw err;
    }
}

async function confirmar(idMovimiento, idNegocio) {
    const m = await Models.TiendaMovimiento.findOne({
        where: { id_movimiento: idMovimiento, id_negocio: idNegocio, estado: 'BORRADOR' },
    });
    if (!m) return null;
    return m.update({ estado: 'CONFIRMADO' });
}

async function anular(idMovimiento, idNegocio) {
    const t = await Models.sequelize.transaction();
    try {
        const m = await Models.TiendaMovimiento.findOne({
            where: { id_movimiento: idMovimiento, id_negocio: idNegocio, estado: 'CONFIRMADO' },
            include: [{ model: Models.TiendaMovDetalle, as: 'detalles' }],
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!m) { await t.rollback(); return null; }

        // Revertir stock
        for (const det of m.detalles) {
            const p = await Models.TiendaProducto.findByPk(det.id_producto, { transaction: t, lock: t.LOCK.UPDATE });
            if (p) {
                let nuevoStock;
                if (m.tipo === 'AJUSTE') {
                    // No podemos revertir un ajuste con certeza; solo marcamos anulado
                    nuevoStock = Number(p.stock_actual);
                } else if (m.tipo === 'ENTRADA' || m.tipo === 'DEVOLUCION') {
                    nuevoStock = Number(p.stock_actual) - Number(det.cantidad);
                } else {
                    // SALIDA, TRASLADO
                    nuevoStock = Number(p.stock_actual) + Number(det.cantidad);
                }
                if (nuevoStock < 0) nuevoStock = 0;
                await p.update({ stock_actual: nuevoStock, fecha_actualizacion: new Date() }, { transaction: t });
            }
        }

        await m.update({ estado: 'ANULADO' }, { transaction: t });
        await t.commit();
        return getById(idMovimiento, idNegocio);
    } catch (err) {
        if (!t.finished) { try { await t.rollback(); } catch { /* */ } }
        throw err;
    }
}

module.exports = { listar, getById, crear, confirmar, anular };
