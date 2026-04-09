const Models = require('../../app_core/models/conection');

/**
 * pedidoService — Lógica de negocio para órdenes / pedidos del restaurante.
 */

/**
 * Genera el siguiente número de orden para un negocio.
 */
async function generarNumeroOrden(idNegocio) {
    const [result] = await Models.sequelize.query(`
        SELECT COALESCE(MAX(CAST(SUBSTRING(numero_orden FROM 5) AS INTEGER)), 0) + 1 AS siguiente
        FROM restaurante.pedid_orden
        WHERE id_negocio = :idNegocio
    `, {
        replacements: { idNegocio },
        type: Models.sequelize.QueryTypes.SELECT,
    });
    const num = String(result.siguiente).padStart(4, '0');
    return `ORD-${num}`;
}

async function consumirIngredientesPorItems({ idNegocio, items, transaction }) {
    const ingredientesNecesarios = new Map();

    for (const item of items) {
        const receta = await Models.CartaProductoIngred.findAll({
            where: {
                id_producto: item.id_producto,
                estado: 'A',
            },
            attributes: ['id_ingrediente', 'porcion'],
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                where: { id_negocio: idNegocio, estado: 'A' },
                required: true,
                attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
            }],
            transaction,
        });

        const excluidas = new Set(item.exclusiones || []);
        receta.forEach((recetaIng) => {
            if (excluidas.has(recetaIng.id_ingrediente)) return;

            const porcion = Number(recetaIng.porcion || 0);
            if (porcion <= 0) return;

            const consumo = porcion * Number(item.cantidad || 1);
            const entry = ingredientesNecesarios.get(recetaIng.id_ingrediente);

            if (entry) {
                entry.consumo += consumo;
            } else {
                ingredientesNecesarios.set(recetaIng.id_ingrediente, {
                    id_ingrediente: recetaIng.id_ingrediente,
                    nombre: recetaIng.ingrediente?.nombre || 'Ingrediente',
                    consumo,
                });
            }
        });
    }

    if (ingredientesNecesarios.size === 0) return;

    const idsIngredientes = Array.from(ingredientesNecesarios.keys());
    const ingredientesStock = await Models.CartaIngrediente.findAll({
        where: {
            id_negocio: idNegocio,
            id_ingrediente: idsIngredientes,
            estado: 'A',
        },
        attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
        transaction,
        lock: transaction.LOCK.UPDATE,
    });

    const stockMap = new Map(ingredientesStock.map((i) => [
        i.id_ingrediente,
        Number(i.stock_actual ?? 0),
    ]));

    for (const reqIng of ingredientesNecesarios.values()) {
        const stock = stockMap.get(reqIng.id_ingrediente);
        if (stock === undefined) {
            throw new Error(`Ingrediente no encontrado en inventario: ${reqIng.nombre}`);
        }
        if (stock < reqIng.consumo) {
            throw new Error(`Stock insuficiente para ${reqIng.nombre}`);
        }
    }

    for (const ing of ingredientesStock) {
        const consumo = ingredientesNecesarios.get(ing.id_ingrediente)?.consumo || 0;
        if (consumo <= 0) continue;

        const nuevoStock = Math.max(Number(ing.stock_actual ?? 0) - consumo, 0);
        await ing.update({ stock_actual: nuevoStock }, { transaction });
    }
}

async function crearDetallesOrden({ idOrden, items, transaction }) {
    for (const item of items) {
        const detalle = await Models.PedidDetalle.create({
            id_orden: idOrden,
            id_producto: item.id_producto,
            cantidad: item.cantidad,
            precio_unitario: item.precio_unitario,
            subtotal: item.precio_unitario * item.cantidad,
            nota: item.nota || null,
            estado: 'PENDIENTE',
        }, { transaction });

        if (item.exclusiones && item.exclusiones.length > 0) {
            const exclusiones = item.exclusiones.map(idIng => ({
                id_detalle: detalle.id_detalle,
                id_ingrediente: idIng,
            }));
            await Models.PedidDetalleExclu.bulkCreate(exclusiones, { transaction });
        }
    }
}

async function recalcularTotalesOrden({ idOrden, porcentajeImpuesto = 0, transaction }) {
    const subtotalRaw = await Models.PedidDetalle.sum('subtotal', {
        where: { id_orden: idOrden },
        transaction,
    });
    const subtotal = Number(subtotalRaw ?? 0);
    const impuesto = Math.round(subtotal * porcentajeImpuesto * 100) / 100;
    const total = subtotal + impuesto;

    await Models.PedidOrden.update(
        { subtotal, impuesto, total },
        { where: { id_orden: idOrden }, transaction }
    );
}

/**
 * Crea una orden completa con sus detalles y exclusiones.
 *
 * @param {Object} params
 * @param {number} params.idNegocio
 * @param {number} params.idUsuario
 * @param {number|null} params.idMesa
 * @param {string} [params.nota]
 * @param {Array}  params.items — [{ id_producto, cantidad, precio_unitario, nota, exclusiones: [id_ingrediente] }]
 * @param {number} params.porcentajeImpuesto — ej: 0.19
 */
async function crearOrden({ idNegocio, idUsuario, idMesa, nota, items, porcentajeImpuesto = 0 }) {
    const t = await Models.sequelize.transaction();
    try {
        const numeroOrden = await generarNumeroOrden(idNegocio);

        await consumirIngredientesPorItems({
            idNegocio,
            items,
            transaction: t,
        });

        // Calcular totales
        let subtotal = 0;
        items.forEach(item => {
            subtotal += item.precio_unitario * item.cantidad;
        });
        const impuesto = Math.round(subtotal * porcentajeImpuesto * 100) / 100;
        const total = subtotal + impuesto;

        // 1. Crear la orden
        const orden = await Models.PedidOrden.create({
            id_negocio: idNegocio,
            id_usuario: idUsuario,
            numero_orden: numeroOrden,
            id_mesa: idMesa || null,
            nota,
            subtotal,
            impuesto,
            total,
            estado: 'ABIERTA',
        }, { transaction: t });

        await crearDetallesOrden({
            idOrden: orden.id_orden,
            items,
            transaction: t,
        });

        await t.commit();

        // Retornar orden con detalles
        return getOrdenById(orden.id_orden);
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/**
 * Agrega items a una orden ABIERTA existente (flujo de ajuste POS por mesa).
 */
async function agregarItemsOrden({ idOrden, idNegocio, nota, items, porcentajeImpuesto = 0 }) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findOne({
            where: {
                id_orden: idOrden,
                id_negocio: idNegocio,
                estado: 'ABIERTA',
            },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!orden) {
            throw new Error('ORDEN_NO_ENCONTRADA');
        }

        await consumirIngredientesPorItems({
            idNegocio,
            items,
            transaction: t,
        });

        await crearDetallesOrden({
            idOrden,
            items,
            transaction: t,
        });

        if (typeof nota === 'string') {
            await orden.update({ nota: nota.trim() || null }, { transaction: t });
        }

        await recalcularTotalesOrden({
            idOrden,
            porcentajeImpuesto,
            transaction: t,
        });

        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/**
 * Obtiene una orden por su ID, con detalles, exclusiones, producto e ingrediente.
 */
async function getOrdenById(idOrden) {
    return Models.PedidOrden.findByPk(idOrden, {
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono', 'precio'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }, {
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }, {
            model: Models.RestMesa,
            as: 'mesaRef',
            attributes: ['id_mesa', 'nombre', 'numero'],
            required: false,
        }],
    });
}

/**
 * Lista órdenes abiertas de un negocio.
 */
async function getOrdenesAbiertas(idNegocio) {
    return Models.PedidOrden.findAll({
        where: { id_negocio: idNegocio, estado: 'ABIERTA' },
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [{
                model: Models.CartaProducto,
                as: 'producto',
                attributes: ['id_producto', 'nombre', 'icono'],
            }],
        }],
        order: [['fecha_creacion', 'DESC']],
    });
}

/**
 * Envía una orden a cocina (cambia estado_cocina → PENDIENTE y detalles → EN_COCINA).
 */
async function enviarACocina(idOrden) {
    await Models.PedidDetalle.update(
        { estado: 'EN_COCINA' },
        { where: { id_orden: idOrden, estado: 'PENDIENTE' } }
    );
    await Models.PedidOrden.update(
        { estado_cocina: 'PENDIENTE' },
        { where: { id_orden: idOrden } }
    );
    return getOrdenById(idOrden);
}

/**
 * Cambia el estado del KDS para una orden (flujo kanban).
 * PENDIENTE → EN_PREPARACION → LISTO → ENTREGADO.
 * Al pasar a LISTO, los detalles EN_COCINA se marcan LISTO.
 */
async function cambiarEstadoCocina(idOrden, nuevoEstado) {
    const updateOrden = { estado_cocina: nuevoEstado };
    await Models.PedidOrden.update(updateOrden, { where: { id_orden: idOrden } });
    if (nuevoEstado === 'LISTO') {
        await Models.PedidDetalle.update(
            { estado: 'LISTO' },
            { where: { id_orden: idOrden, estado: 'EN_COCINA' } }
        );
    } else if (nuevoEstado === 'EN_PREPARACION') {
        // Si se deshace desde LISTO → EN_PREPARACION, revertir detalles LISTO → EN_COCINA
        await Models.PedidDetalle.update(
            { estado: 'EN_COCINA' },
            { where: { id_orden: idOrden, estado: 'LISTO' } }
        );
    }
    return getOrdenById(idOrden);
}

/**
 * Lista órdenes activas en el KDS (estado_cocina IN [PENDIENTE, EN_PREPARACION, LISTO]).
 */
async function getOrdenesCocina(idNegocio) {
    const { Op } = Models.Sequelize;
    return Models.PedidOrden.findAll({
        where: {
            id_negocio: idNegocio,
            estado_cocina: { [Op.in]: ['PENDIENTE', 'EN_PREPARACION', 'LISTO'] },
        },
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }, {
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }, {
            model: Models.RestMesa,
            as: 'mesaRef',
            attributes: ['id_mesa', 'nombre', 'numero'],
            required: false,
        }],
        order: [['fecha_creacion', 'ASC']],
    });
}

/**
 * Marca un detalle como LISTO (lo elimina de la vista de cocina).
 */
async function marcarDetalleCompleto(idDetalle) {
    const detalle = await Models.PedidDetalle.findByPk(idDetalle);
    if (!detalle) return null;
    await detalle.update({ estado: 'LISTO' });
    return detalle;
}

/**
 * Cierra / cobra una orden.
 */
async function cerrarOrden(idOrden) {
    await Models.PedidOrden.update(
        { estado: 'CERRADA', fecha_cierre: new Date() },
        { where: { id_orden: idOrden } }
    );
    return getOrdenById(idOrden);
}

module.exports = {
    crearOrden,
    agregarItemsOrden,
    getOrdenById,
    getOrdenesAbiertas,
    getOrdenesCocina,
    enviarACocina,
    cambiarEstadoCocina,
    marcarDetalleCompleto,
    cerrarOrden,
};
