'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Registra una venta completa: cabecera + detalles + descuento atómico de stock.
 *
 * @param {object} params
 * @param {number} params.idNegocio
 * @param {number|null} params.idCliente
 * @param {number|null} params.idUsuario
 * @param {string} params.metodoPago
 * @param {number} [params.descuentoGlobal] - Descuento aplicado al total de la venta
 * @param {string} [params.notas]
 * @param {Array<{id_producto:number, cantidad:number, precio_unitario?:number, descuento?:number}>} params.items
 */
async function crear({ idNegocio, idCliente, idUsuario, metodoPago, descuentoGlobal = 0, notas, items }) {
    if (!Array.isArray(items) || items.length === 0) {
        const e = new Error('Items requeridos'); e.statusCode = 422; throw e;
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

        // Verificar stock antes de operar (omite servicios)
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

        // Crear cabecera con totales en 0 (se actualizan abajo)
        const venta = await Models.TiendaVenta.create({
            id_negocio: idNegocio,
            id_cliente: idCliente || null,
            id_usuario: idUsuario || null,
            metodo_pago: metodoPago,
            descuento: Math.round(Number(descuentoGlobal) * 100) / 100,
            subtotal: 0,
            total: 0,
            estado: 'COMPLETADA',
            notas: notas || null,
        }, { transaction: t });

        let subtotal = 0;
        for (const item of items) {
            const p = mapProductos.get(Number(item.id_producto));
            const cantidad = Number(item.cantidad);
            const precioUnit = item.precio_unitario != null ? Number(item.precio_unitario) : Number(p.precio_venta);
            const descItem = item.descuento != null ? Number(item.descuento) : 0;
            const subItem = Math.round((cantidad * precioUnit - descItem) * 100) / 100;
            subtotal += subItem;

            await Models.TiendaVentaDetalle.create({
                id_venta: venta.id_venta,
                id_producto: p.id_producto,
                id_negocio: idNegocio,
                cantidad,
                precio_unitario: precioUnit,
                descuento: descItem,
            }, { transaction: t });

            // Descontar stock (solo productos físicos)
            if (!p.es_servicio) {
                await p.update({
                    stock_actual: Number(p.stock_actual) - cantidad,
                    fecha_actualizacion: new Date(),
                }, { transaction: t });
            }
        }

        const total = Math.round((subtotal - Number(descuentoGlobal)) * 100) / 100;
        await venta.update({ subtotal: Math.round(subtotal * 100) / 100, total }, { transaction: t });
        await t.commit();

        return getById(venta.id_venta, idNegocio);
    } catch (err) {
        if (!t.finished) { try { await t.rollback(); } catch { /* */ } }
        throw err;
    }
}

async function getById(idVenta, idNegocio) {
    return Models.TiendaVenta.findOne({
        where: { id_venta: idVenta, id_negocio: idNegocio },
        include: [
            { model: Models.TiendaCliente, as: 'cliente', attributes: ['id_cliente', 'nombre', 'num_doc'], required: false },
            { model: Models.GenerUsuario,  as: 'usuario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'], required: false },
            {
                model: Models.TiendaVentaDetalle, as: 'detalles',
                include: [{ model: Models.TiendaProducto, as: 'producto', attributes: ['id_producto', 'nombre', 'sku', 'unidad_medida'] }],
            },
        ],
    });
}

async function listar({ idNegocio, desde, hasta, idCliente, page = 1, pageSize = 50 }) {
    const where = { id_negocio: idNegocio };
    if (idCliente) where.id_cliente = idCliente;
    if (desde || hasta) {
        where.fecha_venta = {};
        if (desde) where.fecha_venta[Op.gte] = new Date(desde);
        if (hasta) {
            const d = new Date(hasta);
            d.setDate(d.getDate() + 1);
            where.fecha_venta[Op.lt] = d;
        }
    }
    const offset = (page - 1) * pageSize;
    const { rows, count } = await Models.TiendaVenta.findAndCountAll({
        where, offset, limit: pageSize, order: [['fecha_venta', 'DESC']],
        include: [
            { model: Models.TiendaCliente, as: 'cliente', attributes: ['id_cliente', 'nombre'], required: false },
            {
                model: Models.TiendaVentaDetalle, as: 'detalles', required: false,
                include: [{ model: Models.TiendaProducto, as: 'producto', attributes: ['id_producto', 'nombre'] }],
            },
        ],
    });
    return { rows, total: count, page, page_size: pageSize };
}

async function anular({ idVenta, idNegocio }) {
    const t = await Models.sequelize.transaction();
    try {
        const v = await Models.TiendaVenta.findOne({
            where: { id_venta: idVenta, id_negocio: idNegocio, estado: 'COMPLETADA' },
            include: [{ model: Models.TiendaVentaDetalle, as: 'detalles' }],
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!v) { await t.rollback(); return null; }

        // Devolver stock
        for (const det of v.detalles) {
            const p = await Models.TiendaProducto.findByPk(det.id_producto, { transaction: t, lock: t.LOCK.UPDATE });
            if (p && !p.es_servicio) {
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

module.exports = { crear, getById, listar, anular };
