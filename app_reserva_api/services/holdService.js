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

const { duracionLegible } = require('./duracionTexto');
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;
const Disponibilidad = require('./disponibilidadService');
const Reglas = require('./reglasAgenda');
const Composicion = require('./composicionCita');
const Perfiles = require('../perfiles');

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
    { idNegocio, idProfesional, idServicios = [], fechaHoraInicioISO, ttlMinutos, variantes = null },
    { transaction: transaccionExterna = null } = {}
) {
    if (!idNegocio || !idProfesional || !idServicios.length || !fechaHoraInicioISO) {
        throw error('DATOS_INCOMPLETOS', 'Faltan datos para reservar el hueco.', 400);
    }

    const ttl = Math.min(Number(ttlMinutos) || TTL_MINUTOS_POR_DEFECTO, TTL_MINUTOS_MAXIMO);
    const cfg = await Disponibilidad.getConfig(idNegocio);

    const servicios = await Models.ReservaServicio.findAll({
        where: { id_servicio: { [Op.in]: idServicios }, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'nombre', 'duracion_min', 'precio', 'proceso_desde_min', 'proceso_min',
                     'a_cotizar', 'id_tipo_recurso', 'requiere_consentimiento'],
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

    // Misma composición que al crear la cita: si el hold midiera distinto, apartaría un hueco
    // que la confirmación después rechazaría. Sin funciones (la barbería) es la suma de siempre.
    //
    // ⚠️ Las variantes entran en la cuenta, y por eso están aquí. Una coloración de pelo largo
    // dura el doble que la de lista: sin esto el hold apartaba 40 minutos para una cita de 90 y
    // el choque no aparecía aquí, sino después, en la agenda del profesional.
    const { funciones } = await Perfiles.perfilDeNegocio(idNegocio);
    const ordenados = idServicios.map((id) => servicios.find((s) => s.id_servicio === Number(id)));
    const variantesPedidas = Composicion.normalizarVariantes(variantes);
    const comp = Composicion.componer(ordenados, {
        funciones,
        // La misma función que usa `crearCita`, y no una copia: si el hold resolviera las
        // variantes por su cuenta acabarían divergiendo, que es el fallo que este arreglo cierra.
        variantes: await Disponibilidad.variantesElegidas(idNegocio, variantesPedidas),
    });
    const inicio = parsearInicio(fechaHoraInicioISO);
    const duracion = comp.duracion;
    const fin = Reglas.addMinutes(inicio, duracion);

    // La anticipación mínima se exige AQUÍ, al apartar, y no solo al crear la cita. Antes solo
    // la miraba `crearCita`: el asistente ofrecía las 16:00 a las 14:59, apartaba a las 15:02 y
    // al confirmar (58 min antes) la cita se rechazaba con ANTICIPACION_INSUFICIENTE después de
    // haberle dicho al cliente «te aparté». Con la regla en el hold, el rechazo llega antes del
    // resumen, y una hora ya apartada se respeta al confirmar (ver `crearCita`).
    const minimoInicio = Reglas.addMinutes(new Date(), Number(cfg.anticipacion_min_minutos || 0));
    if (inicio.getTime() < minimoInicio.getTime()) {
        throw error(
            'ANTICIPACION_INSUFICIENTE',
            `Debe reservar con al menos ${duracionLegible(cfg.anticipacion_min_minutos)} de anticipación`,
            400,
        );
    }

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
            { idNegocio, idProfesional, inicio, fin, bufferMin: cfg.buffer_limpieza_min, tramos: comp.tramos },
            { transaction: t }
        );

        // La cabina también se aparta: sin esto, el hold protegería al profesional pero no la
        // sala, y otra terapeuta podría llevársela mientras el cliente confirma.
        let idRecurso = null;
        if (comp.idTipoRecurso) {
            await Models.sequelize.query('SELECT pg_advisory_xact_lock(:espacio, :tipo);', {
                replacements: { espacio: Reglas.ESPACIO_BLOQUEO_RECURSO, tipo: comp.idTipoRecurso },
                transaction: t,
            });
            idRecurso = await Reglas.asignarRecurso(
                { idNegocio, idTipoRecurso: comp.idTipoRecurso, inicio, fin, bufferMin: cfg.buffer_limpieza_min },
                { transaction: t },
            );
        }

        const hold = await Models.ReservaHold.create(
            {
                id_negocio: idNegocio,
                id_profesional: idProfesional,
                fecha_hora_inicio: inicio,
                fecha_hora_fin: fin,
                expira_en: new Date(Date.now() + ttl * 60_000),
                estado: 'activo',
                id_servicios: idServicios,
                id_recurso: idRecurso,
                // Se guarda lo que se APARTÓ, para que confirmar cree exactamente esa cita y no
                // otra. Releerlo de aquí es lo que ADR-010 pide: el contexto de la conversación
                // es una pista, el hold es el hecho.
                variantes: variantesPedidas.size ? Object.fromEntries(variantesPedidas) : null,
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
