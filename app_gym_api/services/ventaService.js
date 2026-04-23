'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Registra una venta completa: cabecera + detalles + descuento atómico de stock.
 *
 * @param {object} params
 * @param {number} params.idNegocio
 * @param {number|null} params.idMiembro
 * @param {number|null} params.idUsuarioCobro
 * @param {string} params.metodo
 * @param {Array<{id_producto:number, cantidad:number}>} params.items
 *
 * Si algún producto no tiene stock suficiente, retorna { error: 'STOCK_INSUFICIENTE', faltantes: [...] }.
 */
async function registrar({ idNegocio, idMiembro, idUsuarioCobro, metodo, items }) {
    if (!Array.isArray(items) || items.length === 0) {
        const e = new Error('Items requeridos'); e.statusCode = 422; throw e;
    }

    const t = await Models.sequelize.transaction();
    try {
        const idsProducto = [...new Set(items.map(i => Number(i.id_producto)))];
        const productos = await Models.GymProducto.findAll({
            where: { id_producto: idsProducto, id_negocio: idNegocio, estado: 'A' },
            transaction: t, lock: t.LOCK.UPDATE,
        });

        const mapProductos = new Map(productos.map(p => [p.id_producto, p]));
        if (mapProductos.size !== idsProducto.length) {
            await t.rollback();
            const e = new Error('Algún producto no existe o está inactivo'); e.statusCode = 404; throw e;
        }

        // Verificar stock antes de tocar nada
        const faltantes = [];
        for (const item of items) {
            const p = mapProductos.get(Number(item.id_producto));
            if (Number(p.stock_actual) < Number(item.cantidad)) {
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

        // Crear cabecera (total se calcula abajo)
        const venta = await Models.GymVenta.create({
            id_negocio: idNegocio,
            id_miembro: idMiembro || null,
            id_usuario_cobro: idUsuarioCobro || null,
            metodo, total: 0, estado: 'PAGADA',
        }, { transaction: t });

        let total = 0;
        for (const item of items) {
            const p = mapProductos.get(Number(item.id_producto));
            const cantidad = Number(item.cantidad);
            const precio = Number(p.precio);
            const subtotal = Math.round(cantidad * precio * 100) / 100;
            total += subtotal;

            await Models.GymVentaDetalle.create({
                id_venta: venta.id_venta,
                id_producto: p.id_producto,
                cantidad, precio_unitario: precio, subtotal,
            }, { transaction: t });

            await p.update({
                stock_actual: Number(p.stock_actual) - cantidad,
                fecha_actualizacion: new Date(),
            }, { transaction: t });
        }

        await venta.update({ total: Math.round(total * 100) / 100 }, { transaction: t });
        await t.commit();

        return getById(venta.id_venta, idNegocio);
    } catch (err) {
        if (!t.finished) { try { await t.rollback(); } catch { /* */ } }
        throw err;
    }
}

async function getById(idVenta, idNegocio) {
    return Models.GymVenta.findOne({
        where: { id_venta: idVenta, id_negocio: idNegocio },
        include: [
            { model: Models.GymMiembro, as: 'miembro', attributes: ['id_miembro', 'primer_nombre', 'primer_apellido'] },
            { model: Models.GymVentaDetalle, as: 'detalles',
              include: [{ model: Models.GymProducto, as: 'producto', attributes: ['id_producto', 'nombre', 'sku'] }] },
            { model: Models.GenerUsuario, as: 'usuarioCobro', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'] },
        ],
    });
}

async function listar({ idNegocio, desde, hasta, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (desde || hasta) {
        where.fecha_venta = {};
        if (desde) where.fecha_venta[Op.gte] = new Date(desde);
        if (hasta) where.fecha_venta[Op.lt] = (() => { const d = new Date(hasta); d.setDate(d.getDate() + 1); return d; })();
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.GymVenta.findAndCountAll({
        where, offset, limit: pageSize, order: [['fecha_venta', 'DESC']],
        include: [
            { model: Models.GymMiembro, as: 'miembro', attributes: ['id_miembro', 'primer_nombre', 'primer_apellido'] },
            { model: Models.GymVentaDetalle, as: 'detalles',
              include: [{ model: Models.GymProducto, as: 'producto', attributes: ['id_producto', 'nombre'] }] },
        ],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function anular({ idVenta, idNegocio }) {
    const t = await Models.sequelize.transaction();
    try {
        const v = await Models.GymVenta.findOne({
            where: { id_venta: idVenta, id_negocio: idNegocio, estado: 'PAGADA' },
            include: [{ model: Models.GymVentaDetalle, as: 'detalles' }],
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!v) { await t.rollback(); return null; }

        // Devolver stock
        for (const det of v.detalles) {
            const p = await Models.GymProducto.findByPk(det.id_producto, { transaction: t, lock: t.LOCK.UPDATE });
            if (p) {
                await p.update({
                    stock_actual: Number(p.stock_actual) + Number(det.cantidad),
                    fecha_actualizacion: new Date(),
                }, { transaction: t });
            }
        }

        await v.update({ estado: 'ANULADA' }, { transaction: t });
        await t.commit();
        return getById(idVenta, idNegocio);
    } catch (err) {
        if (!t.finished) { try { await t.rollback(); } catch { /* */ } }
        throw err;
    }
}

module.exports = { registrar, getById, listar, anular };
