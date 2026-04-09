const Models = require('../../app_core/models/conection');

/**
 * mesaService — Lógica de negocio para las mesas del restaurante.
 */

async function getMesas(idNegocio) {
    return Models.RestMesa.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_mesa', 'nombre', 'numero', 'capacidad', 'estado', 'estado_servicio'],
        order: [['numero', 'ASC']],
    });
}

async function getMesasDashboard(idNegocio) {
    const mesas = await Models.RestMesa.findAll({
        where: { id_negocio: idNegocio },
        attributes: ['id_mesa', 'nombre', 'numero', 'capacidad', 'estado', 'estado_servicio'],
        order: [['numero', 'ASC']],
        include: [{
            model: Models.PedidOrden,
            as: 'ordenes',
            where: { estado: 'ABIERTA' },
            required: false,
            attributes: ['id_orden', 'total', 'fecha_creacion', 'estado_cocina'],
            include: [{
                model: Models.PedidDetalle,
                as: 'detalles',
                attributes: ['id_detalle', 'cantidad'],
                include: [{
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['nombre', 'precio'],
                }],
            }],
        }],
    });

    return mesas.map((mesa) => {
        const ordenActiva = mesa.ordenes?.[0] ?? null;
        const total = ordenActiva ? Number(ordenActiva.total ?? 0) : 0;
        const items = (ordenActiva?.detalles ?? []).flatMap((d) => {
            const nombre = d.producto?.nombre;
            if (!nombre) return [];
            return [{ name: nombre, price: Number(d.producto.precio ?? 0), cantidad: Number(d.cantidad ?? 1) }];
        });

        let status = 'available';
        if (mesa.estado !== 'A') status = 'disabled';
        else if (mesa.estado_servicio === 'POR_COBRAR') status = 'payment';
        else if (ordenActiva || mesa.estado_servicio === 'OCUPADA') status = 'occupied';

        const msElapsed = ordenActiva
            ? Math.max(0, Date.now() - new Date(ordenActiva.fecha_creacion).getTime())
            : 0;
        const min = Math.floor(msElapsed / 60000);
        const time = ordenActiva ? (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min} min`) : '';

        return {
            id_mesa: mesa.id_mesa,
            nombre: mesa.nombre,
            numero: mesa.numero,
            capacidad: mesa.capacidad,
            estado: mesa.estado,
            estado_servicio: mesa.estado_servicio,
            status,
            time,
            order: ordenActiva ? {
                id_orden: ordenActiva.id_orden,
                total,
                items,
            } : { total: 0, items: [] },
        };
    });
}

async function crearMesa({ idNegocio, nombre, numero, capacidad }) {
    return Models.RestMesa.create({
        id_negocio: idNegocio,
        nombre,
        numero,
        capacidad: capacidad || 4,
        estado: 'A',
        estado_servicio: 'DISPONIBLE',
    });
}

async function actualizarMesa(idMesa, { nombre, numero, capacidad }) {
    const mesa = await Models.RestMesa.findByPk(idMesa);
    if (!mesa) return null;

    await mesa.update({
        nombre: nombre ?? mesa.nombre,
        numero: numero ?? mesa.numero,
        capacidad: capacidad ?? mesa.capacidad,
    });
    return mesa;
}

async function setMesaEstado(idMesa, estado) {
    const mesa = await Models.RestMesa.findByPk(idMesa);
    if (!mesa) return null;
    await mesa.update({ estado });
    return mesa;
}

async function setMesaEstadoServicio(idMesa, estadoServicio) {
    const mesa = await Models.RestMesa.findByPk(idMesa);
    if (!mesa) return null;
    await mesa.update({ estado_servicio: estadoServicio });
    return mesa;
}

async function liberarMesa(idMesa) {
    const t = await Models.sequelize.transaction();
    try {
        const mesa = await Models.RestMesa.findByPk(idMesa, { transaction: t });
        if (!mesa) {
            await t.rollback();
            return null;
        }

        const ordenAbierta = await Models.PedidOrden.findOne({
            where: {
                id_mesa: idMesa,
                estado: 'ABIERTA',
            },
            attributes: ['id_orden'],
            transaction: t,
        });

        if (ordenAbierta) {
            const error = new Error('No se puede liberar la mesa porque tiene una cuenta pendiente de cobro.');
            error.code = 'MESA_NO_COBRADA';
            error.statusCode = 409;
            throw error;
        }

        await mesa.update({ estado_servicio: 'DISPONIBLE' }, { transaction: t });

        await t.commit();
        return mesa;
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

module.exports = {
    getMesas,
    getMesasDashboard,
    crearMesa,
    actualizarMesa,
    setMesaEstado,
    setMesaEstadoServicio,
    liberarMesa,
};
