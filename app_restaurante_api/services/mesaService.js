const Models = require('../../app_core/models/conection');
const { avisar, TEMAS } = require('./avisoService');

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
        attributes: ['id_mesa', 'nombre', 'numero', 'capacidad', 'seccion', 'estado', 'estado_servicio', 'fecha_inicio_servicio'],
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
            'seccion',
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
            attributes: ['id_orden', 'numero_orden', 'total', 'fecha_creacion', 'estado_cocina', 'id_metodo_pago', 'id_cuenta', 'nota', 'descuento', 'estado_pago'],
            include: [{
                model: Models.PedidDetalle,
                as: 'detalles',
                attributes: ['id_detalle', 'cantidad', 'nota'],
                include: [{
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['nombre', 'precio'],
                }, {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    required: false,
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                }],
            }, {
                // Desglose de multipago elegido al tomar el pedido: la mesa lo muestra
                // al cobrar para poder revisarlo y ajustarlo antes de cerrar la cuenta.
                model: Models.RestPagoOrden,
                as: 'pagos',
                attributes: ['id_pago', 'id_metodo_pago', 'valor'],
                required: false,
            }, {
                // Quien tomó el pedido — la factura impresa desde Mesas lo mostraba como
                // "Atiende", pero con el nombre de quien la imprimía, no de quien atendió.
                model: Models.GenerUsuario,
                as: 'usuario',
                attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
                required: false,
            }],
        }],
    });

    return mesas.map((mesa) => {
        const ordenActiva = mesa.ordenes?.[0] ?? null;
        const total = ordenActiva ? Number(ordenActiva.total ?? 0) : 0;
        const items = (ordenActiva?.detalles ?? []).flatMap((d) => {
            const nombre = d.producto?.nombre;
            if (!nombre) return [];
            return [{
                name: nombre,
                price: Number(d.producto.precio ?? 0),
                cantidad: Number(d.cantidad ?? 1),
                nota: d.nota ?? null,
                // «Sin cebolla»: lo que el cliente pidió quitar. La cocina ya lo veía; la mesa, no.
                sin: (d.exclusiones ?? [])
                    .map((e) => e.ingrediente?.nombre)
                    .filter(Boolean),
            }];
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
            seccion: mesa.seccion ?? null,
            estado: mesa.estado,
            estado_servicio: mesa.estado_servicio,
            status,
            time,
            order: ordenActiva ? {
                id_orden: ordenActiva.id_orden,
                // «ORD-1052»: la comanda impresa la identifica junto a la mesa, igual que en Despacho.
                numero_orden: ordenActiva.numero_orden ?? null,
                total,
                // La rebaja ya viene restada del total; se manda aparte para poder
                // mostrarla y corregirla desde el cobro de la mesa.
                descuento: Number(ordenActiva.descuento ?? 0),
                estado_pago: ordenActiva.estado_pago ?? null,
                id_metodo_pago: ordenActiva.id_metodo_pago ?? null,
                // De quién es la tiquetera, elegida al tomar el pedido. Viaja para que el
                // cobro de la mesa no vuelva a preguntar lo que el cajero ya dijo.
                id_cuenta: ordenActiva.id_cuenta ?? null,
                pagos: (ordenActiva.pagos ?? []).map((p) => ({
                    id_metodo_pago: p.id_metodo_pago,
                    valor: Number(p.valor ?? 0),
                })),
                nota: ordenActiva.nota ?? null,
                usuario: ordenActiva.usuario ? {
                    id_usuario: ordenActiva.usuario.id_usuario,
                    primer_nombre: ordenActiva.usuario.primer_nombre,
                    primer_apellido: ordenActiva.usuario.primer_apellido,
                } : null,
                items,
            } : { total: 0, items: [], pagos: [], descuento: 0 },
        };
    });
}

async function crearMesa({ idNegocio, nombre, numero, capacidad, seccion }) {
    let nextNumero = Number(numero);
    if (!Number.isInteger(nextNumero) || nextNumero < 1) {
        const maxNumero = await Models.RestMesa.max('numero', {
            where: { id_negocio: idNegocio },
        });
        nextNumero = (Number(maxNumero) || 0) + 1;
    }

    const mesa = await Models.RestMesa.create({
        id_negocio: idNegocio,
        nombre,
        numero: nextNumero,
        capacidad: capacidad || 4,
        seccion: seccion || null,
        estado: 'A',
        estado_servicio: 'DISPONIBLE',
        fecha_inicio_servicio: null,
    });

    avisar(idNegocio, TEMAS.MESAS);
    return mesa;
}

async function actualizarMesa(idMesa, { nombre, numero, capacidad, seccion }) {
    const mesa = await Models.RestMesa.findByPk(idMesa);
    if (!mesa) return null;

    await mesa.update({
        nombre: nombre ?? mesa.nombre,
        numero: numero ?? mesa.numero,
        capacidad: capacidad ?? mesa.capacidad,
        // `undefined` = no tocar; texto vacio = quitarle la seccion (NULL).
        seccion: seccion === undefined ? mesa.seccion : (seccion || null),
    });

    avisar(mesa.id_negocio, TEMAS.MESAS);
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
    avisar(mesa.id_negocio, TEMAS.MESAS);
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
    avisar(mesa.id_negocio, TEMAS.MESAS);
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
        avisar(mesa.id_negocio, TEMAS.MESAS);
        return mesa;
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

/**
 * Elimina una mesa de forma permanente.
 *
 * Solo si está deshabilitada (estado 'I') y sin un pedido abierto: hacerlo desde
 * 'A' o con una cuenta a medio cobrar es exactamente el tipo de "se me fue la mano"
 * que este candado evita. El pedido histórico no se pierde — `pedid_orden.id_mesa`
 * es ON DELETE SET NULL y la orden ya guarda el nombre de la mesa por separado
 * (columna `mesa`), así que reportes y tickets viejos se siguen viendo igual.
 */
async function eliminarMesa(idMesa) {
    const mesa = await Models.RestMesa.findByPk(idMesa);
    if (!mesa) return null;

    if (mesa.estado !== 'I') {
        const error = new Error('Solo se puede eliminar una mesa deshabilitada.');
        error.code = 'MESA_ACTIVA';
        error.statusCode = 409;
        throw error;
    }

    const ordenAbierta = await Models.PedidOrden.findOne({
        where: { id_mesa: idMesa, estado: 'ABIERTA' },
        attributes: ['id_orden'],
    });
    if (ordenAbierta) {
        const error = new Error('La mesa tiene un pedido abierto. Ciérralo o cancélalo antes de eliminarla.');
        error.code = 'MESA_CON_PEDIDO_ABIERTO';
        error.statusCode = 409;
        throw error;
    }

    const idNegocio = mesa.id_negocio;
    await mesa.destroy();
    avisar(idNegocio, TEMAS.MESAS);
    return true;
}

module.exports = {
    getMesas,
    getMesasDashboard,
    crearMesa,
    actualizarMesa,
    setMesaEstado,
    setMesaEstadoServicio,
    liberarMesa,
    eliminarMesa,
};
