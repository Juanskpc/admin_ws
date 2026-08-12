/**
 * Reservas temporales (*holds*) sobre la agenda.
 *
 * ## Qué resuelve
 *
 * «Este hueco es tuyo mientras terminamos de hablar.» Entre que se calcula la
 * disponibilidad y se crea la cita pasan segundos en un formulario y varios minutos en una
 * conversación. En ese intervalo la recepcionista puede dar el mismo hueco desde el panel.
 * El hold convierte «te propongo las 10:00» en un compromiso con fecha de caducidad, que es
 * lo que [ADR-010](../../docs/adr/ADR-010-ejecucion-segura.md) llama el paso *hold* de
 * `propose → hold → confirm`.
 *
 * ## Por qué vive en la vertical y no en Intelligence
 *
 * Es un concepto de la agenda, no de la IA: sirve igual al formulario web el día que quiera
 * sostener el slot mientras el cliente sube el comprobante de pago. `reserva` no sabe que
 * Intelligence existe y sigue sin saberlo ([ADR-005](../../docs/adr/ADR-005-independencia-verticales.md)).
 *
 * ## El TTL se cumple solo
 *
 * No hay cron de limpieza. `reglasAgenda.intervalosOcupados` solo cuenta holds con
 * `estado='activo'` y `expira_en > now()`, así que un hold caducado deja de estorbar en el
 * instante exacto en que caduca. Borrar las filas viejas es housekeeping, no correctitud.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;
const Disponibilidad = require('./disponibilidadService');
const Reglas = require('./reglasAgenda');

/** Cuánto dura un hold si nadie dice otra cosa. */
const TTL_MINUTOS_POR_DEFECTO = 10;

/**
 * Cuánto se puede estirar un hold. Un hold largo es una denegación de servicio educada:
 * quien pida holds de un día bloquea la agenda entera sin reservar nada.
 */
const TTL_MINUTOS_MAXIMO = 60;

function error(code, mensaje, statusCode = 409) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/**
 * Toma un hold sobre `[inicio, inicio + duración de los servicios]`.
 *
 * Pasa por **la misma** verificación que `crearCita`: si el hueco no es reservable, tampoco
 * se puede sostener. Un hold que se pudiera tomar sobre un domingo sería una promesa que la
 * confirmación no puede cumplir.
 *
 * @returns {Promise<Object>} el hold, con su `codigo` público y `expira_en`.
 */
async function tomar(
    { idNegocio, idProfesional, idServicios = [], fechaHoraInicioISO, ttlMinutos },
    { transaction: transaccionExterna = null } = {}
) {
    if (!idNegocio || !idProfesional || !idServicios.length || !fechaHoraInicioISO) {
        throw error('DATOS_INCOMPLETOS', 'Faltan datos para reservar el hueco.', 400);
    }

    const ttl = Math.min(Number(ttlMinutos) || TTL_MINUTOS_POR_DEFECTO, TTL_MINUTOS_MAXIMO);
    const cfg = await Disponibilidad.getConfig(idNegocio);

    const servicios = await Models.ReservaServicio.findAll({
        where: { id_servicio: { [Op.in]: idServicios }, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'duracion_min'],
    });
    if (servicios.length !== idServicios.length) {
        throw error('SERVICIO_NO_VALIDO', 'Algún servicio no es válido para este negocio.', 400);
    }

    const profesional = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_profesional'],
    });
    if (!profesional) {
        throw error('PROFESIONAL_NO_VALIDO', 'Profesional no válido.', 404);
    }

    const inicio = parsearInicio(fechaHoraInicioISO);
    const duracion = servicios.reduce((acc, s) => acc + s.duracion_min, 0);
    const fin = Reglas.addMinutes(inicio, duracion);

    // Si quien llama ya tiene una transacción abierta, se trabaja dentro de la suya y NO se
    // confirma: la decisión de commit es de quien la abrió. Es lo que hace que el dry-run
    // del Policy Gate pueda deshacer esto de verdad — si este servicio confirmara por su
    // cuenta, «ejecutar en seco» dejaría holds reales bloqueando la agenda.
    const propia = !transaccionExterna;
    const t = transaccionExterna || (await Models.sequelize.transaction());

    try {
        // Mismo lock por profesional que `crearCita`: dos holds simultáneos sobre el mismo
        // hueco vacío no tienen ninguna fila que bloquear y los dos pasarían la comprobación.
        await Models.sequelize.query('SELECT pg_advisory_xact_lock(:clave);', {
            replacements: { clave: idProfesional },
            transaction: t,
        });

        await Reglas.verificarReservable(
            { idNegocio, idProfesional, inicio, fin, bufferMin: cfg.buffer_limpieza_min },
            { transaction: t }
        );

        const hold = await Models.ReservaHold.create(
            {
                id_negocio: idNegocio,
                id_profesional: idProfesional,
                fecha_hora_inicio: inicio,
                fecha_hora_fin: fin,
                expira_en: new Date(Date.now() + ttl * 60_000),
                estado: 'activo',
                id_servicios: idServicios,
            },
            { transaction: t }
        );

        if (propia) await t.commit();
        return hold;
    } catch (err) {
        if (propia) await t.rollback();
        throw err;
    }
}

/**
 * Busca un hold vigente por su código público.
 *
 * Devuelve `null` si no existe, ya se usó o caducó — las tres son «ese hueco ya no es tuyo»
 * y quien llama no necesita distinguirlas para actuar.
 */
async function vigentePorCodigo(codigo, idNegocio, { transaction = null } = {}) {
    return Models.ReservaHold.findOne({
        where: {
            codigo,
            id_negocio: idNegocio,
            estado: 'activo',
            expira_en: { [Op.gt]: new Date() },
        },
        transaction,
    });
}

/**
 * Libera un hold antes de tiempo (el cliente cambió de idea).
 *
 * Es idempotente: liberar algo ya liberado o ya caducado no es un error, porque el efecto
 * que se pedía —que ese hueco no esté retenido— se cumple igual.
 */
async function liberar(codigo, idNegocio) {
    const [filas] = await Models.ReservaHold.update(
        { estado: 'liberado' },
        { where: { codigo, id_negocio: idNegocio, estado: 'activo' } }
    );
    return filas > 0;
}

/**
 * Housekeeping opcional: borra holds terminados o caducados hace tiempo.
 *
 * **No hace falta para que la agenda funcione** — un hold caducado ya no cuenta. Existe solo
 * para que la tabla no crezca sin límite, y por eso no hay ningún cron que la llame: se
 * ejecuta a mano si algún día la tabla molesta.
 */
async function purgar({ diasDeGracia = 7 } = {}) {
    const corte = new Date(Date.now() - diasDeGracia * 24 * 3600_000);
    return Models.ReservaHold.destroy({
        where: {
            [Op.or]: [{ estado: { [Op.ne]: 'activo' } }, { expira_en: { [Op.lt]: corte } }],
            creado_en: { [Op.lt]: corte },
        },
    });
}

/** Mismo criterio que `crearCita`: sin huso explícito, es hora de pared de Bogotá. */
function parsearInicio(fechaHoraInicioISO) {
    const traeHuso = fechaHoraInicioISO.includes('+') || fechaHoraInicioISO.endsWith('Z');
    const inicio = new Date(`${fechaHoraInicioISO}${traeHuso ? '' : '-05:00'}`);
    if (Number.isNaN(inicio.getTime())) {
        throw error('FECHA_INVALIDA', 'fecha_hora_inicio inválida.', 400);
    }
    return inicio;
}

module.exports = {
    tomar,
    vigentePorCodigo,
    liberar,
    purgar,
    TTL_MINUTOS_POR_DEFECTO,
    TTL_MINUTOS_MAXIMO,
};
