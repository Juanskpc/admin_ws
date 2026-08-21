/**
 * Capability Adapter de `reserva` — capa anticorrupción (ADR-009).
 *
 * ## Dónde vive esto y por qué
 *
 * Este archivo **sabe qué es una cita**. El núcleo de Intelligence no lo sabe y nunca debe
 * saberlo; la vertical no sabe que Intelligence existe. La flecha es siempre
 * Intelligence → Vertical. Por eso el acoplamiento vive aquí: para eso existen los
 * adaptadores.
 *
 * Consume el **contrato público** que la vertical ya expone —sus servicios de dominio—, no
 * sus internals. Si mañana `reserva` cambia ese contrato, se actualiza este archivo y nada
 * más: el acoplamiento es real, pero está localizado y es explícito.
 *
 * ## Alcance: seis capacidades, y una que sigue bloqueada
 *
 * F4-A trajo las dos consultas; F4-B las cuatro mutaciones, una vez F3 puso las invariantes
 * y el *hold* en el dominio. Falta `consultar_mis_citas` del manifiesto en papel, y no es un
 * olvido: necesita `reserva_cita.id_persona_negocio`, que no existe. F0 solo adoptó
 * `platform.persona` en `restaurante`; es el punto 1 del Contrato de Adopción
 * (`capability-language.md` §5) y sigue sin cumplirse en esta vertical.
 *
 * **Consecuencia práctica, y es la segura:** el asistente solo puede reagendar o cancelar
 * citas cuyo código ya conoce —las que él mismo creó en esta conversación—. No puede
 * enumerar las citas de un cliente. Hasta que `reserva` adopte `persona`, eso no es una
 * carencia que haya que tapar: es el límite correcto.
 *
 * ## Handles públicos, no ids secuenciales
 *
 * El manifiesto en papel decía `cancelar_cita { id_cita }`. Aquí se usa `codigo_cita`, el
 * uuid que `reserva_cita` ya tiene como asa pública. Un entero secuencial dejaría que quien
 * hable con el asistente cancele la cita de otro cliente del mismo negocio contando hacia
 * arriba: el Policy Gate impone el `id_negocio`, pero dentro del negocio no distingue
 * clientes porque todavía no hay identidad. Con un uuid, adivinar no es una estrategia.
 *
 * ## Propose → hold → confirm, en dos capacidades
 *
 * ADR-010 exige que una mutación proponga, sostenga y luego confirme. Aquí son
 * `proponer_turno` (crea el hold y devuelve el resumen) y `reservar_turno` (lo consume y
 * crea la cita). Cortarlo en dos pasa el test que el propio plan impone —«si una capacidad
 * obliga a llamar a otra después para dejar el sistema consistente, están mal cortadas»—
 * porque **no obliga a nada**: si `reservar_turno` no llega nunca, el hold expira solo y la
 * agenda queda como estaba.
 */
'use strict';
const Models = require('../../../app_core/models/conection');
const registry = require('../../core/registry');
const { FEATURE } = require('../../core/features');

const servicioService = require('../../../app_reserva_api/services/servicioService');
const profesionalService = require('../../../app_reserva_api/services/profesionalService');
const disponibilidadService = require('../../../app_reserva_api/services/disponibilidadService');
const citaService = require('../../../app_reserva_api/services/citaService');
const holdService = require('../../../app_reserva_api/services/holdService');

const VERTICAL = 'reserva';

/**
 * Precondición anticorrupción: `disponibilidadService.getConfig` **crea** la configuración
 * por defecto si no existe. Es un comportamiento razonable para un formulario que acaba de
 * abrirse, pero convierte una lectura en una escritura — y una escritura que ocurre fuera
 * de nuestra transacción, así que un `dry-run` no la desharía.
 *
 * En vez de tocar la vertical (que serviría a la IA, invirtiendo la flecha de dependencia),
 * el adaptador comprueba la precondición antes y falla limpio si no se cumple. Es
 * exactamente el trabajo de una capa anticorrupción: absorber aquí la imperfección del
 * modelo de al lado.
 */
async function exigirConfiguracion(idNegocio) {
    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    if (!cfg) {
        const e = new Error('Este negocio todavía no tiene configurada la agenda de reservas.');
        e.code = 'RESERVA_SIN_CONFIGURAR';
        e.statusCode = 409;
        throw e;
    }
    return cfg;
}

function registrarCapacidades() {
    registry.registrar({
        nombre: 'consultar_servicios',
        descripcion:
            'Lista los servicios que el negocio ofrece, con su duración y su precio. Úsala ' +
            'cuando el cliente pregunte qué se hace en el negocio, cuánto cuesta algo o ' +
            'cuánto dura, y antes de consultar disponibilidad para saber qué servicio pide.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {},

        async ejecutar({ idNegocio }) {
            const servicios = await servicioService.listar({ idNegocio, soloActivos: true });
            return {
                servicios: servicios.map((s) => ({
                    id_servicio: s.id_servicio,
                    nombre: s.nombre,
                    duracion_min: s.duracion_min,
                    precio: s.precio != null ? Number(s.precio) : null,
                })),
            };
        },
    });

    registry.registrar({
        nombre: 'consultar_disponibilidad',
        descripcion:
            'Devuelve las horas libres de un servicio en una fecha concreta. Úsala cuando el ' +
            'cliente pregunte si hay hueco, a qué horas puede venir, o antes de proponerle una ' +
            'hora. Nunca inventes horas: las horas válidas son solo las que devuelve esta capacidad.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            id_servicio: { tipo: 'entero', requerido: true, min: 1 },
            fecha: { tipo: 'fecha', requerido: true },
            // Opcional a propósito: el cliente rara vez sabe con quién quiere ir, y obligarle
            // a elegir profesional para poder preguntar "¿tienen hueco el martes?" es
            // convertir una pregunta de negocio en un formulario.
            id_profesional: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args }) {
            await exigirConfiguracion(idNegocio);

            // Anticorrupción: `calcularSlots` exige un profesional concreto, porque nació
            // para un formulario donde el usuario ya lo había elegido. La pregunta de
            // negocio ("¿hay hueco el martes?") no lo tiene, así que el adaptador recorre
            // los profesionales que prestan el servicio y funde sus horas.
            const profesionales = args.id_profesional
                ? [{ id_profesional: args.id_profesional }]
                : await profesionalService.listar({
                      idNegocio,
                      idServicio: args.id_servicio,
                      soloActivos: true,
                  });

            if (profesionales.length === 0) {
                return { fecha: args.fecha, horas: [], motivo: 'no hay profesionales que presten ese servicio' };
            }

            const porHora = new Map();
            let duracionMin = null;

            for (const p of profesionales) {
                const resultado = await disponibilidadService.calcularSlots({
                    idNegocio,
                    idServicio: args.id_servicio,
                    idProfesional: p.id_profesional,
                    fechaISO: args.fecha,
                });
                duracionMin = duracionMin ?? resultado.duracion_servicio_min;

                for (const slot of resultado.slots) {
                    if (!slot.disponible) continue;
                    // Una hora la ofrece quien la tenga libre; se guarda el primero para que
                    // la capacidad de reserva de F4-B no tenga que volver a calcularlo.
                    if (!porHora.has(slot.hora)) porHora.set(slot.hora, p.id_profesional);
                }
            }

            const horas = [...porHora.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([hora, idProfesional]) => ({ hora, id_profesional: idProfesional }));

            return {
                fecha: args.fecha,
                duracion_min: duracionMin,
                horas,
            };
        },
    });

    // ── Mutaciones (F4-B) ───────────────────────────────────────────────────────────────

    registry.registrar({
        nombre: 'proponer_turno',
        descripcion:
            'Aparta temporalmente una hora concreta y devuelve el resumen para confirmar con ' +
            'el cliente: profesional, duración y precio. Úsala justo antes de decirle al ' +
            'cliente "te propongo las 10:00, ¿te va bien?". La hora queda apartada unos ' +
            'minutos; si el cliente no confirma, se libera sola.',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        // Volver a proponer el mismo hueco NO devuelve el mismo hold: el primero sigue vivo
        // y el segundo choca con él. Repetir tiene efecto distinto, así que no es idempotente.
        idempotente: false,
        // Ésta **es** la mitad *propose* del ciclo de ADR-010: existe precisamente para poder
        // preguntarle al cliente antes de comprometer nada. Exigirle confirmación a ella sería
        // preguntar «¿confirmas que aparte la hora?» para luego preguntar «¿confirmo la cita?»
        // — dos preguntas para una decisión. Y su efecto se deshace solo: el hold caduca.
        confirmacion: registry.CONFIRMACION.NO_REQUIERE,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            id_servicio: { tipo: 'entero', requerido: true, min: 1 },
            inicio: { tipo: 'string', requerido: true, max_longitud: 25 },
            id_profesional: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            await exigirConfiguracion(idNegocio);

            const idProfesional = args.id_profesional || (await elegirProfesional(idNegocio, args));

            // La transacción del Gate se pasa hacia abajo: sin ella el servicio confirmaría
            // por su cuenta y un dry-run dejaría el hold puesto de verdad.
            const hold = await holdService.tomar(
                {
                    idNegocio,
                    idProfesional,
                    idServicios: [args.id_servicio],
                    fechaHoraInicioISO: args.inicio,
                },
                { transaction: contexto.transaction }
            );

            const servicio = await servicioService.getById(args.id_servicio, idNegocio);
            const profesional = await profesionalService.getById(idProfesional, idNegocio);

            return {
                codigo_hold: hold.codigo,
                expira_en: hold.expira_en,
                inicio: args.inicio,
                duracion_min: servicio.duracion_min,
                precio: servicio.precio != null ? Number(servicio.precio) : null,
                servicio: servicio.nombre,
                profesional: profesional?.nombre ?? null,
            };
        },
    });

    registry.registrar({
        nombre: 'reservar_turno',
        descripcion:
            'Confirma la hora apartada con proponer_turno y crea la cita definitiva. Úsala ' +
            'cuando el cliente haya elegido hora y te haya dado su nombre. Devuelve el ' +
            'código de la cita, que hace falta para reagendarla o cancelarla después. ' +
            'Al pedirla, el negocio le enseña al cliente una pregunta de confirmación y no se ' +
            'ejecuta hasta que diga sí: no le digas que ya está hecha.',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        // Sí: el hold se consume al confirmarlo, así que una segunda llamada con el mismo
        // código no encuentra hold vigente y no crea una segunda cita.
        idempotente: true,
        // Aquí nace una cita en la agenda de un negocio real. No se ejecuta sin un sí explícito
        // del cliente en el canal (ADR-010, paso 5 del Policy Gate).
        confirmacion: {
            pregunta: ({ args }) =>
                `¿Confirmo la cita a nombre de ${args.cliente_nombre}?`,
            hecho: ({ resultado }) =>
                `¡Listo! Tu cita quedó agendada. El código es ${resultado.codigo_cita} — ` +
                'guárdalo por si quieres cambiarla o cancelarla.',
        },
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            codigo_hold: { tipo: 'string', requerido: true, max_longitud: 40 },
            cliente_nombre: { tipo: 'string', requerido: true, min_longitud: 2, max_longitud: 150 },
            cliente_telefono: { tipo: 'string', requerido: false, max_longitud: 30 },
            notas: { tipo: 'string', requerido: false, max_longitud: 500 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            // Se relee el hold del dominio en vez de fiarse de lo que la conversación crea
            // recordar. Si expiró o ya se usó, aquí se descubre — que es exactamente lo que
            // ADR-010 pide de una mutación.
            const hold = await holdService.vigentePorCodigo(args.codigo_hold, idNegocio, {
                transaction: contexto.transaction,
            });
            if (!hold) {
                const e = new Error(
                    'Esa hora ya no está apartada: caducó o se usó. Vuelve a consultar la ' +
                        'disponibilidad antes de prometer nada.'
                );
                e.code = 'HOLD_NO_VIGENTE';
                e.statusCode = 409;
                throw e;
            }

            const cita = await citaService.crearCita(
                {
                    idNegocio,
                    idProfesional: hold.id_profesional,
                    idServicios: hold.id_servicios,
                    fechaHoraInicioISO: formatearWallTime(hold.fecha_hora_inicio),
                    clienteNombre: args.cliente_nombre,
                    clienteTelefono: args.cliente_telefono || null,
                    notas: args.notas || null,
                    consumirHoldId: hold.id_hold,
                },
                { transaction: contexto.transaction }
            );

            return {
                codigo_cita: cita.codigo_publico,
                inicio: cita.fecha_hora_inicio,
                fin: cita.fecha_hora_fin,
                estado: cita.estado,
                monto_total: Number(cita.monto_total),
            };
        },
    });

    registry.registrar({
        nombre: 'reagendar_cita',
        descripcion:
            'Mueve una cita existente a otra hora ya apartada con proponer_turno. Úsala ' +
            'cuando el cliente quiera cambiar la hora de una cita que ya tiene. Necesitas el ' +
            'código de la cita y el código de la nueva hora apartada. Al pedirla, el negocio ' +
            'le enseña al cliente una pregunta de confirmación y no se ejecuta hasta que diga ' +
            'sí: no le digas que ya está hecha.',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        idempotente: true,
        // Mover una cita le quita la hora a quien la tenía y se la da a otra: dos efectos, y el
        // cliente solo pidió uno. Con confirmación.
        confirmacion: {
            pregunta: ({ args }) =>
                `¿Confirmo que muevo tu cita ${args.codigo_cita} a la hora nueva que aparté?`,
            hecho: ({ resultado }) => `Hecho, tu cita ${resultado.codigo_cita} quedó movida.`,
        },
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            codigo_cita: { tipo: 'string', requerido: true, max_longitud: 40 },
            codigo_hold: { tipo: 'string', requerido: true, max_longitud: 40 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            const cita = await buscarCitaPorCodigo(args.codigo_cita, idNegocio, contexto.transaction);
            const hold = await holdService.vigentePorCodigo(args.codigo_hold, idNegocio, {
                transaction: contexto.transaction,
            });
            if (!hold) {
                const e = new Error('La hora nueva ya no está apartada: caducó o se usó.');
                e.code = 'HOLD_NO_VIGENTE';
                e.statusCode = 409;
                throw e;
            }

            const movida = await citaService.reagendarCita(
                {
                    idCita: cita.id_cita,
                    idNegocio,
                    nuevaFechaHoraInicioISO: formatearWallTime(hold.fecha_hora_inicio),
                    idProfesional: hold.id_profesional,
                    consumirHoldId: hold.id_hold,
                },
                { transaction: contexto.transaction }
            );

            return {
                codigo_cita: movida.codigo_publico,
                inicio: movida.fecha_hora_inicio,
                fin: movida.fecha_hora_fin,
            };
        },
    });

    registry.registrar({
        nombre: 'cancelar_cita',
        descripcion:
            'Cancela una cita del cliente. Úsala cuando pida anular su reserva; necesitas el ' +
            'código de la cita y si no lo tienes, pídeselo. El negocio tiene una ventana ' +
            'mínima de cancelación: si ya pasó, la cancelación se rechaza y hay que decirle al ' +
            'cliente que llame. Al pedirla, el negocio le enseña al cliente una pregunta de ' +
            'confirmación y no se ejecuta hasta que diga sí: no le digas que ya está hecha.',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        // Cancelar algo ya cancelado no cambia nada; la máquina de estados lo distingue con
        // TRANSICION_REDUNDANTE en vez de crear un segundo efecto.
        idempotente: true,
        // La irreversible de las cuatro: una cita cancelada por error no se «descancela», hay
        // que volver a buscar hueco y puede que ya no esté. La pregunta nombra el código y no
        // la hora porque el asistente no tiene ninguna capacidad para consultar una cita: decir
        // «tu cita del martes a las 10» sería recitar lo que el modelo cree recordar, y el
        // contexto es una pista, nunca un hecho (ADR-010).
        confirmacion: {
            pregunta: ({ args }) => `¿Confirmo que cancelo tu cita ${args.codigo_cita}?`,
            hecho: ({ resultado }) => `Tu cita ${resultado.codigo_cita} quedó cancelada.`,
        },
        feature: FEATURE.ASISTENTE_IA,
        // El único límite económico real del proyecto hoy (ADR-011). Lo aplica el dominio
        // dentro de su transacción, no el Gate: aquí solo se declara para que la auditoría
        // registre bajo qué regla se ejecutó.
        politica: ['ventana_cancelacion_horas'],
        parametros: {
            codigo_cita: { tipo: 'string', requerido: true, max_longitud: 40 },
            motivo: { tipo: 'string', requerido: false, max_longitud: 300 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            await buscarCitaPorCodigo(args.codigo_cita, idNegocio, contexto.transaction);

            const cita = await citaService.cancelarPorCliente(args.codigo_cita, args.motivo || null, {
                idNegocio,
                transaction: contexto.transaction,
            });

            return {
                codigo_cita: cita.codigo_publico,
                estado: cita.estado,
            };
        },
    });
}

/**
 * Elige un profesional que preste el servicio cuando el cliente no ha dicho ninguno.
 *
 * Coge el primero disponible por orden alfabético. Es una regla arbitraria y está bien que
 * lo sea: el reparto justo de carga entre profesionales es una decisión de negocio que nadie
 * ha tomado todavía, y elegir aquí una heurística sofisticada sería inventarse un requisito.
 */
async function elegirProfesional(idNegocio, args) {
    const profesionales = await profesionalService.listar({
        idNegocio,
        idServicio: args.id_servicio,
        soloActivos: true,
    });
    if (profesionales.length === 0) {
        const e = new Error('No hay ningún profesional que preste ese servicio.');
        e.code = 'SIN_PROFESIONAL';
        e.statusCode = 409;
        throw e;
    }
    return profesionales[0].id_profesional;
}

/** Busca una cita por su código público, acotada al negocio que impuso el Policy Gate. */
async function buscarCitaPorCodigo(codigo, idNegocio, transaction = null) {
    const cita = await Models.ReservaCita.findOne({
        where: { codigo_publico: codigo, id_negocio: idNegocio },
        attributes: ['id_cita', 'estado'],
        transaction,
    });
    if (!cita) {
        const e = new Error('No encuentro esa cita.');
        e.code = 'CITA_NO_ENCONTRADA';
        e.statusCode = 404;
        throw e;
    }
    return cita;
}

/**
 * `Date` → `"YYYY-MM-DDTHH:mm:ss"` en hora de pared de Bogotá.
 *
 * Anticorrupción pura: los servicios de la vertical reciben la hora como cadena sin huso y
 * la interpretan como Bogotá, mientras que el hold ya salió de la base como `Date`. Volver a
 * formatearla evita que el instante se desplace cinco horas al pasar por el ISO en UTC, que
 * es el error clásico de este viaje de ida y vuelta.
 */
function formatearWallTime(fecha) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(new Date(fecha));
    const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

module.exports = {
    registrarCapacidades,
    /** Los recordatorios de F8-B viven en su propio archivo: aquí solo se publican. */
    registrarRecordatorios: require('./recordatorios').registrar,
    VERTICAL,
};
