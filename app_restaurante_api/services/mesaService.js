const Models = require('../../app_core/models/conection');

/**
 * mesaService — Lógica de negocio para las mesas del restaurante.
 */

function formatElapsedMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return '';
    if (minutes >= 60) {
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    return `${minutes} min`;
}

async function inferMesaServiceStart(idMesa, { transaction, allowLastOrderFallback = false } = {}) {
    const ordenAbierta = await Models.PedidOrden.findOne({
        where: { id_mesa: idMesa, estado: 'ABIERTA' },
        attributes: ['fecha_creacion'],
        order: [['fecha_creacion', 'ASC']],
        transaction,
    });

    if (ordenAbierta?.fecha_creacion) {
        return ordenAbierta.fecha_creacion;
    }

    if (!allowLastOrderFallback) {
        return null;
    }

    const ultimaOrden = await Models.PedidOrden.findOne({
        where: { id_mesa: idMesa },
        attributes: ['fecha_creacion'],
        order: [['fecha_creacion', 'DESC']],
        transaction,
    });

    return ultimaOrden?.fecha_creacion ?? null;
}

async function getMesas(idNegocio) {
    return Models.RestMesa.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_mesa', 'nombre', 'numero', 'capacidad', 'estado', 'estado_servicio', 'fecha_inicio_servicio'],
        order: [['numero', 'ASC']],
    });
}

async function getMesasDashboard(idNegocio) {
    const serviceStartExpr = `COALESCE(
        "RestMesa"."fecha_inicio_servicio",
        (
            SELECT MIN(o.fecha_creacion)
            FROM restaurante.pedid_orden o
            WHERE o.id_mesa = "RestMesa"."id_mesa"
              AND o.estado = 'ABIERTA'
        )
    )`;

    const elapsedMinutesExpr = `CASE
        WHEN ${serviceStartExpr} IS NULL THEN NULL
        ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - (${serviceStartExpr}))) / 60)
        )
    END`;

    const mesas = await Models.RestMesa.findAll({
        where: { id_negocio: idNegocio },
        attributes: [
            'id_mesa',
            'nombre',
            'numero',
            'capacidad',
            'estado',
            'estado_servicio',
            'fecha_inicio_servicio',
            [Models.Sequelize.literal(elapsedMinutesExpr), 'minutos_servicio'],
        ],
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

        const minutesRaw = Number(mesa.get('minutos_servicio'));
        const hasServiceClock = Number.isFinite(minutesRaw) && minutesRaw >= 0;
        const time = (status === 'occupied' || status === 'payment')
            ? (hasServiceClock ? formatElapsedMinutes(minutesRaw) : '0 min')
            : '';

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
    let nextNumero = Number(numero);
    if (!Number.isInteger(nextNumero) || nextNumero < 1) {
        const maxNumero = await Models.RestMesa.max('numero', {
            where: { id_negocio: idNegocio },
        });
        nextNumero = (Number(maxNumero) || 0) + 1;
    }

    return Models.RestMesa.create({
        id_negocio: idNegocio,
        nombre,
        numero: nextNumero,
        capacidad: capacidad || 4,
        estado: 'A',
        estado_servicio: 'DISPONIBLE',
        fecha_inicio_servicio: null,
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

    const updates = { estado };
    if (estado !== 'A') {
        updates.estado_servicio = 'DISPONIBLE';
        updates.fecha_inicio_servicio = null;
    }

    await mesa.update(updates);
    return mesa;
}

async function setMesaEstadoServicio(idMesa, estadoServicio) {
    const mesa = await Models.RestMesa.findByPk(idMesa);
    if (!mesa) return null;

    const updates = { estado_servicio: estadoServicio };

    if (estadoServicio === 'DISPONIBLE') {
        updates.fecha_inicio_servicio = null;
    } else if (!mesa.fecha_inicio_servicio) {
        const inferredStart = await inferMesaServiceStart(idMesa, {
            allowLastOrderFallback: mesa.estado_servicio !== 'DISPONIBLE',
        });
        updates.fecha_inicio_servicio = inferredStart || new Date();
    }

    await mesa.update(updates);
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

        await mesa.update({
            estado_servicio: 'DISPONIBLE',
            fecha_inicio_servicio: null,
        }, { transaction: t });

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
