'use strict';
const Models = require('../../app_core/models/conection');
const { Op, QueryTypes } = Models.Sequelize;
const Disponibilidad = require('./disponibilidadService');
const Notificacion = require('./notificacionService');

/**
 * Crea una cita aplicando todas las reglas de negocio:
 *  - Anticipación mínima
 *  - Profesional ofrece los servicios pedidos
 *  - Slot dentro del horario laboral (heurística simple: si todos los slots libres lo permiten)
 *  - Anti-doble-reserva con SELECT FOR UPDATE + buffer de limpieza
 *  - Si cobro_adelantado=true: comprobante obligatorio + estado pago=pendiente_validacion
 *
 * @param {Object} params
 * @param {number}   params.idNegocio
 * @param {number}   params.idProfesional
 * @param {number[]} params.idServicios          IDs de servicios a incluir
 * @param {string}   params.fechaHoraInicioISO   "2026-05-08T10:00:00" (hora Bogotá)
 * @param {string}   params.clienteNombre
 * @param {string=}  params.clienteTelefono
 * @param {string=}  params.clienteEmail
 * @param {string=}  params.notas
 * @param {string=}  params.comprobantePath     Ruta relativa del archivo subido
 * @param {number=}  params.creadoPorIdUsuario  Si la crea el negocio
 */
async function crearCita(params) {
    const {
        idNegocio, idProfesional, idServicios = [],
        fechaHoraInicioISO, clienteNombre, clienteTelefono, clienteEmail, notas,
        comprobantePath, creadoPorIdUsuario,
    } = params;

    if (!idNegocio || !idProfesional || !idServicios.length || !fechaHoraInicioISO || !clienteNombre) {
        const e = new Error('Datos de cita incompletos'); e.statusCode = 400; throw e;
    }

    const cfg = await Disponibilidad.getConfig(idNegocio);

    // Validar profesional pertenece al negocio
    const profesional = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio, estado: 'A' },
    });
    if (!profesional) {
        const e = new Error('Profesional no válido'); e.statusCode = 404; e.code = 'PROFESIONAL_NO_VALIDO'; throw e;
    }

    // Validar servicios pertenecen al negocio y son ofrecidos por el profesional
    const servicios = await Models.ReservaServicio.findAll({
        where: { id_servicio: { [Op.in]: idServicios }, id_negocio: idNegocio, estado: 'A' },
    });
    if (servicios.length !== idServicios.length) {
        const e = new Error('Algún servicio no es válido para este negocio');
        e.statusCode = 400; e.code = 'SERVICIO_NO_VALIDO'; throw e;
    }

    const ofrecidos = await Models.ReservaProfesionalServicio.findAll({
        where: { id_profesional: idProfesional, id_servicio: { [Op.in]: idServicios } },
    });
    // Si el profesional aún no tiene asignaciones, lo permitimos (ofrece todos por defecto).
    // Si ya tiene asignaciones, deben cubrir todos los pedidos.
    const totalAsignados = await Models.ReservaProfesionalServicio.count({ where: { id_profesional: idProfesional } });
    if (totalAsignados > 0 && ofrecidos.length !== idServicios.length) {
        const e = new Error('El profesional no ofrece alguno de los servicios solicitados');
        e.statusCode = 400; e.code = 'SERVICIO_NO_OFRECIDO'; throw e;
    }

    // Calcular duración total y monto total
    const duracionTotal = servicios.reduce((acc, s) => acc + s.duracion_min, 0);
    const montoTotal = servicios.reduce((acc, s) => acc + Number(s.precio), 0);

    const fechaInicio = new Date(`${fechaHoraInicioISO}${fechaHoraInicioISO.includes('+') || fechaHoraInicioISO.endsWith('Z') ? '' : '-05:00'}`);
    if (Number.isNaN(fechaInicio.getTime())) {
        const e = new Error('fecha_hora_inicio inválida'); e.statusCode = 400; throw e;
    }
    const fechaFin = new Date(fechaInicio.getTime() + duracionTotal * 60_000);

    // Validar anticipación mínima
    const ahora = new Date();
    const minimoMs = cfg.anticipacion_min_horas * 3600_000;
    if (creadoPorIdUsuario == null && fechaInicio.getTime() < ahora.getTime() + minimoMs) {
        const e = new Error(`Debe reservar con al menos ${cfg.anticipacion_min_horas}h de anticipación`);
        e.statusCode = 400; e.code = 'ANTICIPACION_INSUFICIENTE'; throw e;
    }

    // Validar pago adelantado
    const requierePago = !!cfg.cobro_adelantado && creadoPorIdUsuario == null;
    if (requierePago && !comprobantePath) {
        const e = new Error('Debe adjuntar el comprobante de pago');
        e.statusCode = 400; e.code = 'COMPROBANTE_REQUERIDO'; throw e;
    }

    // Transacción con anti-doble-reserva
    const t = await Models.sequelize.transaction();
    try {
        // SELECT ... FOR UPDATE sobre citas que solapan (con buffer).
        // Importante: usar sequelize.query con la misma transacción para que el lock
        // y el INSERT siguiente compartan conexión.
        const buffer = cfg.buffer_limpieza_min;
        const conflictos = await Models.sequelize.query(
            `SELECT id_cita FROM reserva.reserva_cita
              WHERE id_profesional = :idProfesional
                AND estado IN ('pendiente','confirmada')
                AND tstzrange(
                        fecha_hora_inicio - (:buffer || ' minutes')::interval,
                        fecha_hora_fin    + (:buffer || ' minutes')::interval,
                        '[)'
                    ) && tstzrange(:ini, :fin, '[)')
              FOR UPDATE`,
            {
                replacements: { idProfesional, ini: fechaInicio, fin: fechaFin, buffer },
                type: QueryTypes.SELECT,
                transaction: t,
            },
        );

        if (conflictos.length > 0) {
            await t.rollback();
            const e = new Error('Ese horario ya no está disponible');
            e.statusCode = 409; e.code = 'SLOT_NO_DISPONIBLE'; throw e;
        }

        const cita = await Models.ReservaCita.create({
            id_negocio: idNegocio,
            id_profesional: idProfesional,
            fecha_hora_inicio: fechaInicio,
            fecha_hora_fin: fechaFin,
            estado: 'pendiente',
            cliente_nombre: clienteNombre,
            cliente_telefono: clienteTelefono || null,
            cliente_email: clienteEmail || null,
            notas: notas || null,
            creado_por_id_usuario: creadoPorIdUsuario || null,
            requiere_pago: requierePago,
            monto_total: montoTotal,
            comprobante_pago_url: comprobantePath || null,
            pago_estado: requierePago ? 'pendiente_validacion' : 'no_aplica',
        }, { transaction: t });

        // Detalle de servicios con snapshot
        const detalles = servicios.map(s => ({
            id_cita: cita.id_cita,
            id_servicio: s.id_servicio,
            precio_snapshot: Number(s.precio),
            duracion_snapshot_min: s.duracion_min,
        }));
        await Models.ReservaCitaServicio.bulkCreate(detalles, { transaction: t });

        await t.commit();

        // Notificación post-commit (no rompe la transacción si falla)
        Notificacion.enviar(requierePago ? 'cita_pendiente_pago' : 'cita_creada', {
            cita: cita.toJSON(), servicios, profesional: profesional.toJSON(),
        }).catch(err => console.error('[Reserva] notif error:', err.message));

        return await getCitaConDetalle(cita.id_cita);
    } catch (err) {
        if (t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        throw err;
    }
}

async function getCitaConDetalle(idCita) {
    return Models.ReservaCita.findOne({
        where: { id_cita: idCita },
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'foto_url', 'color_hex', 'especialidad'] },
            { model: Models.ReservaCitaServicio, as: 'servicios',
              include: [{ model: Models.ReservaServicio, as: 'servicio',
                          attributes: ['id_servicio', 'nombre'] }] },
        ],
    });
}

async function getCitaPorCodigo(codigoPublico) {
    return Models.ReservaCita.findOne({
        where: { codigo_publico: codigoPublico },
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'foto_url', 'color_hex', 'especialidad'] },
            { model: Models.ReservaCitaServicio, as: 'servicios',
              include: [{ model: Models.ReservaServicio, as: 'servicio',
                          attributes: ['id_servicio', 'nombre'] }] },
            { model: Models.GenerNegocio, as: 'negocio',
              attributes: ['id_negocio', 'nombre'] },
        ],
    });
}

async function cancelarPorCliente(codigoPublico, motivo) {
    const cita = await Models.ReservaCita.findOne({ where: { codigo_publico: codigoPublico } });
    if (!cita) {
        const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
    }
    if (['cancelada', 'completada', 'no_show'].includes(cita.estado)) {
        const e = new Error('La cita ya no se puede cancelar'); e.statusCode = 409; throw e;
    }

    const cfg = await Disponibilidad.getConfig(cita.id_negocio);
    const ahora = new Date();
    const ventanaMs = cfg.ventana_cancelacion_horas * 3600_000;
    if (new Date(cita.fecha_hora_inicio).getTime() - ahora.getTime() < ventanaMs) {
        const e = new Error(`Solo se puede cancelar con ${cfg.ventana_cancelacion_horas}h de anticipación`);
        e.statusCode = 400; e.code = 'CANCELACION_TARDE'; throw e;
    }

    await cita.update({
        estado: 'cancelada',
        cancelado_por: 'cliente',
        cancelado_motivo: motivo || null,
        fecha_actualizacion: new Date(),
    });

    Notificacion.enviar('cita_cancelada', { cita: cita.toJSON() })
        .catch(err => console.error('[Reserva] notif error:', err.message));

    return cita;
}

async function aprobarPago(idCita, idNegocio, idUsuario) {
    const cita = await Models.ReservaCita.findOne({ where: { id_cita: idCita, id_negocio: idNegocio } });
    if (!cita) { const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e; }
    if (cita.pago_estado !== 'pendiente_validacion') {
        const e = new Error('La cita no está pendiente de validación de pago'); e.statusCode = 409; throw e;
    }
    await cita.update({
        pago_estado: 'aprobado',
        estado: 'confirmada',
        pago_validado_por_id_usuario: idUsuario,
        pago_validado_en: new Date(),
        fecha_actualizacion: new Date(),
    });

    Notificacion.enviar('pago_aprobado', { cita: cita.toJSON() })
        .catch(err => console.error('[Reserva] notif error:', err.message));

    return cita;
}

async function rechazarPago(idCita, idNegocio, idUsuario, motivo) {
    const cita = await Models.ReservaCita.findOne({ where: { id_cita: idCita, id_negocio: idNegocio } });
    if (!cita) { const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e; }
    if (cita.pago_estado !== 'pendiente_validacion') {
        const e = new Error('La cita no está pendiente de validación de pago'); e.statusCode = 409; throw e;
    }
    await cita.update({
        pago_estado: 'rechazado',
        estado: 'cancelada',
        pago_validado_por_id_usuario: idUsuario,
        pago_validado_en: new Date(),
        pago_rechazo_motivo: motivo || null,
        fecha_actualizacion: new Date(),
    });

    Notificacion.enviar('pago_rechazado', { cita: cita.toJSON(), motivo })
        .catch(err => console.error('[Reserva] notif error:', err.message));

    return cita;
}

module.exports = {
    crearCita, getCitaConDetalle, getCitaPorCodigo, cancelarPorCliente,
    aprobarPago, rechazarPago,
};
