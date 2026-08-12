'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;
const Disponibilidad = require('./disponibilidadService');
const Notificacion = require('./notificacionService');
const Reglas = require('./reglasAgenda');
const EstadoCita = require('./estadoCita');

/**
 * Crea una cita aplicando todas las reglas de negocio:
 *  - Anticipación mínima
 *  - Profesional ofrece los servicios pedidos
 *  - **Dentro del horario laboral y fuera de todo bloqueo** (F3: antes no se comprobaba)
 *  - Anti-doble-reserva contra citas y holds, con el buffer de limpieza
 *  - Si cobro_adelantado=true: comprobante obligatorio + estado pago=pendiente_validacion
 *
 * Desde F3 las tres últimas las decide `reglasAgenda`, el mismo módulo que usa
 * `disponibilidadService` para ofrecer horas. Antes cada uno tenía su propia versión y
 * divergieron: se ofrecían horas que aquí se rechazaban con un 409, y aquí se aceptaban
 * citas un domingo a las 3 de la mañana porque nadie miraba el horario. Estaba tapado
 * porque el único cliente era un formulario que solo ofrecía lo válido.
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
 * @param {number=}  params.consumirHoldId      Hold que esta cita viene a materializar
 * @param {Object=}  opciones.transaction       Transacción de quien llama. Si viene, este
 *                   servicio NO confirma: la decisión de commit es de quien la abrió.
 */
async function crearCita(params, { transaction: transaccionExterna = null } = {}) {
    const {
        idNegocio, idProfesional, idServicios = [],
        fechaHoraInicioISO, clienteNombre, clienteTelefono, clienteEmail, notas,
        comprobantePath, creadoPorIdUsuario, consumirHoldId = null,
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

    // Transacción con anti-doble-reserva. Si quien llama trae la suya, se trabaja dentro:
    // es lo que permite que el dry-run del Policy Gate deshaga esto de verdad. Un servicio
    // que confirma por su cuenta convierte «ejecutar en seco» en «ejecutar».
    const propia = !transaccionExterna;
    const t = transaccionExterna || (await Models.sequelize.transaction());
    try {
        // Lock pesimista sobre la agenda de ESTE profesional. Es un advisory lock y no un
        // `SELECT ... FOR UPDATE` sobre las citas que solapan porque las filas conflictivas
        // pueden no existir todavía: dos peticiones simultáneas para el mismo hueco vacío no
        // tienen ninguna fila que bloquear, y las dos pasarían la comprobación. El lock
        // serializa por profesional, que es el grano al que se reserva.
        await Models.sequelize.query('SELECT pg_advisory_xact_lock(:clave);', {
            replacements: { clave: idProfesional },
            transaction: t,
        });

        await Reglas.verificarReservable(
            {
                idNegocio,
                idProfesional,
                inicio: fechaInicio,
                fin: fechaFin,
                bufferMin: cfg.buffer_limpieza_min,
            },
            // Si esta cita viene de un hold, su propio hold no cuenta como conflicto: es
            // precisamente el hueco que estaba guardando.
            { transaction: t, excluirHold: consumirHoldId }
        );

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

        // El hold se consume en la MISMA transacción que la cita: o existen los dos, o
        // ninguno. Si se marcara después, un fallo entre medias dejaría un hold activo
        // bloqueando un hueco que ya tiene cita.
        if (consumirHoldId) {
            await Models.ReservaHold.update(
                { estado: 'confirmado', id_cita: cita.id_cita },
                { where: { id_hold: consumirHoldId, id_negocio: idNegocio }, transaction: t }
            );
        }

        if (propia) {
            await t.commit();

            // Notificación post-commit (no rompe la transacción si falla).
            //
            // Solo cuando la transacción es nuestra: con una externa todavía no sabemos si
            // la cita va a existir. Notificar antes del commit ajeno es prometerle al
            // cliente una cita que un rollback puede borrar — y un correo enviado no se
            // deshace. Quien abra la transacción notifica después de confirmarla.
            Notificacion.enviar(requierePago ? 'cita_pendiente_pago' : 'cita_creada', {
                cita: cita.toJSON(), servicios, profesional: profesional.toJSON(),
            }).catch(err => console.error('[Reserva] notif error:', err.message));
        }

        return await getCitaConDetalle(cita.id_cita, { transaction: propia ? null : t });
    } catch (err) {
        if (propia && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        throw err;
    }
}

async function getCitaConDetalle(idCita, { transaction = null } = {}) {
    return Models.ReservaCita.findOne({
        transaction,
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

/**
 * Cancela una cita a petición del cliente, identificándola por su código público.
 *
 * `idNegocio` es opcional porque el enlace público de cancelación no sabe a qué negocio
 * pertenece la cita: el código uuid es toda su credencial. Quien SÍ conoce el negocio —el
 * panel, y el asistente a través del Policy Gate— debe pasarlo, y entonces la búsqueda queda
 * acotada al inquilino. Sin ese filtro, un código de otro negocio se cancelaría igual: la
 * probabilidad de acertar un uuid es despreciable, pero el aislamiento no debe depender de
 * una probabilidad (ADR-002).
 */
async function cancelarPorCliente(codigoPublico, motivo, { idNegocio = null, transaction = null } = {}) {
    const where = { codigo_publico: codigoPublico };
    if (idNegocio) where.id_negocio = idNegocio;

    const cita = await Models.ReservaCita.findOne({ where, transaction });
    if (!cita) {
        const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
    }
    // Antes esta comprobación estaba escrita a mano aquí y en ningún otro sitio. Ahora es la
    // misma máquina de estados que usan el panel y (en F4-B) el asistente.
    EstadoCita.exigirTransicion(cita.estado, EstadoCita.ESTADO.CANCELADA);

    const cfg = await Disponibilidad.getConfig(cita.id_negocio);
    const ahora = new Date();
    const ventanaMs = cfg.ventana_cancelacion_horas * 3600_000;
    if (new Date(cita.fecha_hora_inicio).getTime() - ahora.getTime() < ventanaMs) {
        const e = new Error(`Solo se puede cancelar con ${cfg.ventana_cancelacion_horas}h de anticipación`);
        e.statusCode = 400; e.code = 'CANCELACION_TARDE'; throw e;
    }

    await cita.update(
        {
            estado: 'cancelada',
            cancelado_por: 'cliente',
            cancelado_motivo: motivo || null,
            fecha_actualizacion: new Date(),
        },
        { transaction }
    );

    // Con transacción externa todavía no se sabe si la cancelación va a existir: notificar
    // antes del commit ajeno es avisar de algo que un rollback puede deshacer, y un correo
    // enviado no se deshace.
    if (!transaction) {
        Notificacion.enviar('cita_cancelada', { cita: cita.toJSON() })
            .catch(err => console.error('[Reserva] notif error:', err.message));
    }

    return cita;
}

/**
 * Mueve una cita a otra hora, del mismo o de otro profesional.
 *
 * Pasa por la **misma puerta** que crear (`reglasAgenda.verificarReservable`): reagendar es
 * crear en otro sitio, y sería absurdo que se pudiera mover una cita a un domingo por el
 * hecho de que ya existía.
 *
 * Se relee y revalida el estado **dentro de la transacción**, sin fiarse de lo que sepa
 * quien llama: entre que alguien decide reagendar y lo ejecuta, la cita pudo cancelarse
 * desde el panel (ADR-010, «el contexto es una pista, nunca un hecho»).
 *
 * La duración se recalcula desde los servicios ya asociados a la cita, no se hereda del
 * intervalo anterior: si un servicio cambió de duración, la cita movida debe ocupar lo que
 * ocupa hoy, no lo que ocupaba el día que se creó.
 */
async function reagendarCita(
    { idCita, idNegocio, nuevaFechaHoraInicioISO, idProfesional = null, consumirHoldId = null },
    { transaction: transaccionExterna = null } = {}
) {
    if (!idCita || !idNegocio || !nuevaFechaHoraInicioISO) {
        const e = new Error('Datos incompletos para reagendar'); e.statusCode = 400; throw e;
    }

    const cfg = await Disponibilidad.getConfig(idNegocio);
    const propia = !transaccionExterna;
    const t = transaccionExterna || (await Models.sequelize.transaction());

    try {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) {
            const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
        }
        if (EstadoCita.esTerminal(cita.estado)) {
            const e = new Error(`Una cita "${cita.estado}" ya está cerrada y no se puede reagendar.`);
            e.statusCode = 409; e.code = 'TRANSICION_INVALIDA'; throw e;
        }

        const lineas = await Models.ReservaCitaServicio.findAll({
            where: { id_cita: idCita },
            attributes: ['id_servicio'],
            transaction: t,
        });
        const servicios = await Models.ReservaServicio.findAll({
            where: { id_servicio: lineas.map(l => l.id_servicio), id_negocio: idNegocio },
            attributes: ['duracion_min'],
            transaction: t,
        });
        const duracionTotal = servicios.reduce((acc, s) => acc + s.duracion_min, 0);

        const traeHuso = nuevaFechaHoraInicioISO.includes('+') || nuevaFechaHoraInicioISO.endsWith('Z');
        const inicio = new Date(`${nuevaFechaHoraInicioISO}${traeHuso ? '' : '-05:00'}`);
        if (Number.isNaN(inicio.getTime())) {
            const e = new Error('fecha_hora_inicio inválida'); e.statusCode = 400; throw e;
        }
        const fin = new Date(inicio.getTime() + duracionTotal * 60_000);
        const profesionalDestino = idProfesional || cita.id_profesional;

        await Models.sequelize.query('SELECT pg_advisory_xact_lock(:clave);', {
            replacements: { clave: profesionalDestino },
            transaction: t,
        });

        await Reglas.verificarReservable(
            { idNegocio, idProfesional: profesionalDestino, inicio, fin, bufferMin: cfg.buffer_limpieza_min },
            // La propia cita no cuenta como conflicto consigo misma: mover una cita 15
            // minutos dentro de su propio buffer es legítimo y si no se excluyera fallaría.
            { transaction: t, excluirCita: idCita, excluirHold: consumirHoldId }
        );

        await cita.update(
            {
                id_profesional: profesionalDestino,
                fecha_hora_inicio: inicio,
                fecha_hora_fin: fin,
                fecha_actualizacion: new Date(),
            },
            { transaction: t }
        );

        if (consumirHoldId) {
            await Models.ReservaHold.update(
                { estado: 'confirmado', id_cita: idCita },
                { where: { id_hold: consumirHoldId, id_negocio: idNegocio }, transaction: t }
            );
        }

        if (propia) {
            await t.commit();
            Notificacion.enviar('cita_reagendada', { cita: cita.toJSON() })
                .catch(err => console.error('[Reserva] notif error:', err.message));
        }

        return await getCitaConDetalle(idCita, { transaction: propia ? null : t });
    } catch (err) {
        if (propia && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        throw err;
    }
}

async function aprobarPago(idCita, idNegocio, idUsuario) {
    const cita = await Models.ReservaCita.findOne({ where: { id_cita: idCita, id_negocio: idNegocio } });
    if (!cita) { const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e; }
    if (cita.pago_estado !== 'pendiente_validacion') {
        const e = new Error('La cita no está pendiente de validación de pago'); e.statusCode = 409; throw e;
    }
    EstadoCita.exigirTransicion(cita.estado, EstadoCita.ESTADO.CONFIRMADA);
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
    EstadoCita.exigirTransicion(cita.estado, EstadoCita.ESTADO.CANCELADA);
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
    crearCita, reagendarCita, getCitaConDetalle, getCitaPorCodigo, cancelarPorCliente,
    aprobarPago, rechazarPago,
};
