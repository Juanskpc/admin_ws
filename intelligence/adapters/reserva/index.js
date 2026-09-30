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
 * y el *hold* en el dominio. Falta `consultar_mis_citas` del manifiesto en papel.
 *
 * **Lo que la bloqueaba ya no la bloquea.** Estaba parada porque `reserva_cita.id_persona_negocio`
 * no existía —F0 solo adoptó `platform.persona` en `restaurante`—, y esa columna se añadió el
 * 2026-09-09 con `migrate:reserva-clientes`, junto con el enganche en `citaService.crearCita`
 * y el backfill histórico. El punto 1 del Contrato de Adopción (`capability-language.md` §5)
 * queda cumplido en esta vertical.
 *
 * Lo que sigue faltando es la capacidad en sí: declararla en el Registry, decidir su política
 * en el Policy Gate y escribir su adaptador. Es trabajo deliberado, no un enganche suelto.
 *
 * **Hasta entonces, la consecuencia práctica es la de siempre y es la segura:** el asistente
 * solo puede reagendar o cancelar citas cuyo código ya conoce —las que él mismo creó en esta
 * conversación—. No puede enumerar las citas de un cliente.
 *
 * ## Handles públicos, y desde 2026-08-24 también pertenencia
 *
 * El manifiesto en papel decía `cancelar_cita { id_cita }`. Aquí se usa `codigo_cita`, el
 * uuid que `reserva_cita` ya tiene como asa pública. Un entero secuencial dejaría que quien
 * hable con el asistente cancele la cita de otro cliente del mismo negocio contando hacia
 * arriba.
 *
 * Ese razonamiento tenía un agujero que se tapó el 2026-08-24: decía que «con un uuid,
 * adivinar no es una estrategia», lo cual es cierto **y no es autorización**. Estaba dejando
 * que la seguridad la diera la longitud del identificador — un accidente afortunado, no un
 * diseño, y uno que se rompe en cuanto el código se acorte para poder dictarlo por teléfono.
 *
 * Ahora `buscarCitaPorCodigo` comprueba además que la cita sea **de quien la pide**, usando el
 * teléfono que probó el canal (`principal.telefono_verificado`). Ver su comentario para el
 * porqué de cada decisión, incluida la de fallar cerrada.
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
const { TIPO } = require('../../../app_core/authz/principal');
const { normalizarE164 } = require('../../../app_core/helpers/telefono');
const { paisDeNegocio } = require('../../../app_core/helpers/paisNegocio');

/** Solo a un cliente final se le comprueba de quién es la cita; el negocio opera sobre todas. */
const TIPO_CONTACTO = TIPO.CONTACTO;

const servicioService = require('../../../app_reserva_api/services/servicioService');
const profesionalService = require('../../../app_reserva_api/services/profesionalService');
const disponibilidadService = require('../../../app_reserva_api/services/disponibilidadService');
const citaService = require('../../../app_reserva_api/services/citaService');
const holdService = require('../../../app_reserva_api/services/holdService');
const mascotaService = require('../../../app_reserva_api/services/mascotaService');
const perfiles = require('../../../app_reserva_api/perfiles');

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
/**
 * Quién es quien escribe, dentro de este negocio — **sin crearlo si no existe**.
 *
 * `personaNegocioDao.resolverOCrear` es el camino normal al crear una cita, pero aquí sería
 * exactamente el error que `exigirConfiguracion` documenta abajo: convertir una consulta en una
 * escritura. Preguntar «¿tengo mascotas registradas?» no puede dar de alta a un cliente, y menos
 * dentro de un `dry-run` que después no lo desharía.
 *
 * Devuelve `null` cuando no hay teléfono probado (WebChat, que no autentica a nadie) o cuando el
 * número no sirve para el país del negocio. Quien llama lo trata como «no te conozco todavía»,
 * que es la verdad y es inofensivo.
 */
async function personaDelCanal(idNegocio, principal, transaction = null) {
    const telefono = principal?.telefono_verificado;
    if (!telefono) return null;

    const pais = await paisDeNegocio(idNegocio, { transaction });
    const e164 = normalizarE164(telefono, pais);
    if (!e164) return null;

    const [fila] = await Models.sequelize.query(
        `SELECT id_persona_negocio
           FROM platform.persona_negocio
          WHERE id_negocio = :idNegocio AND telefono_e164 = :telefono
          LIMIT 1`,
        {
            replacements: { idNegocio, telefono: e164 },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        },
    );
    return fila?.id_persona_negocio || null;
}

/**
 * Las horas libres de UN día, fundiendo las agendas de quienes prestan el servicio.
 *
 * Anticorrupción: `calcularSlots` exige un profesional concreto, porque nació para un formulario
 * donde el usuario ya lo había elegido. La pregunta de negocio («¿hay hueco el martes?») no lo
 * tiene, así que se recorren los profesionales que prestan el servicio y se funden sus horas.
 *
 * Vive fuera de la capacidad porque la usan dos: `consultar_disponibilidad` (un día) y
 * `consultar_dias_con_horas` (varios). Si cada una calculara a su manera, un día podría
 * aparecer «con horas» en la segunda y vacío en la primera — que es exactamente el tipo de
 * contradicción que el cliente ve y no perdona.
 */
async function horasDelDia(idNegocio, args, profesionalesPrecargados = null) {
    const profesionales = profesionalesPrecargados
        || (args.id_profesional
            ? [{ id_profesional: args.id_profesional }]
            : await profesionalService.listar({
                  idNegocio,
                  idServicio: args.id_servicio,
                  soloActivos: true,
              }));

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
            // El mismo formato que acepta `composicionCita.normalizarVariantes` y que guarda el
            // hold: así las tres medidas —ofrecer, apartar y crear— salen de la misma cuenta.
            ...(args.id_variante ? { variantes: { [args.id_servicio]: args.id_variante } } : {}),
        });
        duracionMin = duracionMin ?? resultado.duracion_servicio_min;

        for (const slot of resultado.slots) {
            if (!slot.disponible) continue;
            // Todos los que la tienen libre, en orden. El primero es el que se propone por
            // defecto («me da igual»); la lista entera deja que el cliente elija persona
            // DESPUÉS de la hora, entre quienes de verdad pueden atenderle entonces.
            if (!porHora.has(slot.hora)) porHora.set(slot.hora, []);
            porHora.get(slot.hora).push(p.id_profesional);
        }
    }

    const horas = [...porHora.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([hora, ids]) => ({ hora, id_profesional: ids[0], id_profesionales: ids }));

    return { fecha: args.fecha, duracion_min: duracionMin, horas };
}

/** Cuántos días hacia delante se busca como máximo. Tres semanas cubren cualquier agenda viva. */
const DIAS_A_BUSCAR = 21;

/** `YYYY-MM-DD` de hoy en Bogotá, sin pasar por UTC (la trampa que el repo ya pagó dos veces). */
function hoyISO(ahora = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ahora);
}

function sumarDias(fechaISO, n) {
    const [a, m, d] = fechaISO.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Los próximos días que **de verdad tienen horas libres**, desde `desde`.
 *
 * ## El fallo que obliga a que esto exista (producción, D'ALEX, 2026-09-28)
 *
 * El flujo consultaba un día, y si estaba vacío proponía el siguiente **sin mirarlo**:
 *
 *   «No hay horas libres el 2026-09-29. ¿Probamos el 2026-09-30?» → vacío
 *   «No hay horas libres el 2026-09-30. ¿Probamos el 2026-10-01?» → vacío …
 *
 * Un cliente real hizo cuatro turnos para descubrir que no había agenda, y ninguno le sirvió.
 * El bot proponía días que no había comprobado. La regla nueva es simple: **nunca se ofrece un
 * día sin haber visto que tiene hueco**.
 *
 * ## Por qué es barato aunque mire tres semanas
 *
 * Primero se descartan los días cerrados con `diasDisponibles`, que solo lee horarios (una
 * consulta por día, sin citas ni holds). El cálculo caro de huecos —`calcularSlots`, por
 * profesional— solo se hace en los días que abren, y se para en cuanto hay `cuantos`. En una
 * agenda normal eso son tres o cuatro días calculados, no veintiuno.
 */
async function diasConHoras(idNegocio, args, ahora = new Date()) {
    const cuantos = Math.min(Math.max(Number(args.cuantos) || 3, 1), 5);
    const hoy = hoyISO(ahora);
    const desde = args.desde && args.desde > hoy ? args.desde : hoy;
    const hasta = sumarDias(desde, DIAS_A_BUSCAR - 1);

    const profesionales = args.id_profesional
        ? [{ id_profesional: args.id_profesional }]
        : await profesionalService.listar({ idNegocio, idServicio: args.id_servicio, soloActivos: true });

    if (profesionales.length === 0) {
        return { dias: [], desde, hasta, motivo: 'no hay profesionales que presten ese servicio' };
    }

    // Días en que ALGUIEN trabaja. Se consulta por profesional (su horario propio manda sobre
    // el del negocio) y se unen.
    const abiertos = new Set();
    for (const p of profesionales) {
        const calendario = await disponibilidadService.diasDisponibles({
            idNegocio, idProfesional: p.id_profesional, desde, hasta,
        });
        for (const d of calendario) if (d.abierto) abiertos.add(d.fecha);
    }

    const dias = [];
    for (const fecha of [...abiertos].sort()) {
        const { horas } = await horasDelDia(idNegocio, { ...args, fecha }, profesionales);
        if (horas.length === 0) continue;
        dias.push({ fecha, primera_hora: horas[0].hora, cuantas: horas.length });
        if (dias.length >= cuantos) break;
    }

    return {
        dias,
        desde,
        hasta,
        // Para que quien lea un vacío sepa por qué: no es lo mismo «nadie trabaja» que «está
        // todo lleno», y el negocio tiene que arreglar cosas distintas en cada caso.
        ...(dias.length === 0
            ? { motivo: abiertos.size === 0 ? 'nadie tiene horario en esas fechas' : 'la agenda está llena' }
            : {}),
    };
}

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
    // Las citas que crea el asistente avisan a la Agenda en vivo. Idempotente con el registro
    // que hacen las rutas de reserva: si el asistente corriera en otro proceso, también avisaría.
    require('../../../app_reserva_api/services/avisoService').registrarHooks();

    registry.registrar({
        nombre: 'consultar_servicios',
        descripcion:
            'Lista los servicios que el negocio ofrece, con su duración y su precio. Úsala ' +
            'cuando el cliente pregunte qué se hace en el negocio, cuánto cuesta algo o ' +
            'cuánto dura, y antes de consultar disponibilidad para saber qué servicio pide. ' +
            'Un servicio con `a_cotizar` NO tiene precio cerrado: su precio se acuerda antes de ' +
            'agendar, así que no prometas el que veas. Un servicio con `variantes` cuesta y dura ' +
            'distinto según cuál se elija (largo del cabello, tamaño de la mascota, zona).',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {},

        async ejecutar({ idNegocio }) {
            const [servicios, perfil] = await Promise.all([
                servicioService.listar({ idNegocio, soloActivos: true }),
                perfiles.perfilDeNegocio(idNegocio),
            ]);
            const activas = new Set(perfil.funciones);

            return {
                // Cómo llama este oficio a las cosas («terapeuta», «sesión», «groomer») y qué
                // tiene encendido. Viaja con los servicios y no en una capacidad aparte porque
                // quien pregunta por los servicios lo necesita en el mismo turno: es el primer
                // mensaje de la conversación y no merece dos viajes al Gate.
                negocio: {
                    terminos: perfil.terminos,
                    funciones: perfil.funciones,
                },
                servicios: servicios.map((s) => ({
                    id_servicio: s.id_servicio,
                    nombre: s.nombre,
                    duracion_min: s.duracion_min,
                    precio: s.precio != null ? Number(s.precio) : null,
                    // La categoría del portal. Con un catálogo largo el asistente pregunta primero
                    // el tipo («Cabello», «Uñas») y después enseña solo los de ése.
                    categoria: s.categoria
                        ? { id_categoria: s.categoria.id_categoria, nombre: s.categoria.nombre, orden: s.categoria.orden }
                        : null,
                    // Los tres campos que deciden si este servicio se puede agendar por chat y
                    // qué hay que preguntar antes. Solo se exponen si el negocio tiene la
                    // función encendida: un dato que el oficio no usa es ruido para el modelo.
                    a_cotizar: activas.has('a_cotizar') ? Boolean(s.a_cotizar) : false,
                    requiere_consentimiento: activas.has('consentimiento')
                        ? Boolean(s.requiere_consentimiento)
                        : false,
                    variantes: activas.has('variantes')
                        ? (s.variantes || []).map((v) => ({
                              id_variante: v.id_variante,
                              nombre: v.nombre,
                              // La clave empareja la variante con un atributo conocido —el
                              // tamaño de la mascota—, y es lo que permite elegirla sola.
                              clave: v.clave || null,
                              duracion_min: v.duracion_min,
                              precio: v.precio != null ? Number(v.precio) : null,
                          }))
                        : [],
                })),
            };
        },
    });

    registry.registrar({
        nombre: 'consultar_profesionales',
        descripcion:
            'Lista quién presta un servicio concreto en el negocio. Úsala cuando el cliente ' +
            'pregunte con quién puede ir, pida a alguien por su nombre, o antes de consultar ' +
            'disponibilidad si quiere elegir profesional. Si le da igual con quién, NO la ' +
            'necesitas: consulta la disponibilidad sin profesional y sale antes.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            // Obligatorio, y no por comodidad: listar los profesionales del negocio entero
            // ofrecería gente que no hace lo que el cliente pidió, y elegir a una de ellas
            // termina en un «esa persona no presta ese servicio» tres pasos más tarde.
            id_servicio: { tipo: 'entero', requerido: true, min: 1 },
        },

        async ejecutar({ idNegocio, args }) {
            const profesionales = await profesionalService.listar({
                idNegocio,
                idServicio: args.id_servicio,
                soloActivos: true,
            });

            return {
                profesionales: profesionales.map((p) => ({
                    id_profesional: p.id_profesional,
                    nombre: p.nombre,
                    especialidad: p.especialidad || null,
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
            /**
             * La variante, cuando ya se sabe cuál.
             *
             * ⚠️ **Sin esto las horas se miden con la duración equivocada.** Una coloración de
             * pelo largo dura 120 minutos y la de lista 60: preguntando sin variante, el bot
             * ofrece las 11:00 de un negocio que cierra a las 12:00, y al apartar la hora la
             * vertical la rechaza con «ese horario está fuera del horario de atención» — sobre
             * una hora que el propio bot acababa de ofrecer.
             *
             * Lo destapó la prueba de oficios; es el mismo desajuste que el del hold, un piso
             * más arriba, y por eso se arregla con la misma regla: **todo lo que mide tiempo
             * tiene que medirlo igual**.
             */
            id_variante: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args }) {
            await exigirConfiguracion(idNegocio);

            return horasDelDia(idNegocio, args);
        },
    });

    registry.registrar({
        nombre: 'consultar_dias_con_horas',
        descripcion:
            'Busca los próximos días que TIENEN horas libres para un servicio, desde una fecha. ' +
            'Úsala antes de preguntarle al cliente qué día quiere, y siempre que un día no tenga ' +
            'horas: nunca le propongas un día sin haber comprobado que tiene hueco. Si devuelve ' +
            'la lista vacía, no hay agenda en las próximas semanas y hay que decírselo.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            id_servicio: { tipo: 'entero', requerido: true, min: 1 },
            // Desde qué día buscar, incluido. Sin él, desde hoy.
            desde: { tipo: 'fecha', requerido: false },
            id_profesional: { tipo: 'entero', requerido: false, min: 1 },
            id_variante: { tipo: 'entero', requerido: false, min: 1 },
            // Cuántos días con horas devolver. Tres caben como botones y dejan elegir.
            cuantos: { tipo: 'entero', requerido: false, min: 1, max: 5 },
        },

        async ejecutar({ idNegocio, args }) {
            await exigirConfiguracion(idNegocio);
            return diasConHoras(idNegocio, args);
        },
    });

    registry.registrar({
        nombre: 'consultar_mis_mascotas',
        descripcion:
            'Lista las mascotas que este cliente ya tiene registradas en el negocio. Úsala en ' +
            'negocios de cuidado de mascotas antes de agendar, para no pedirle otra vez los ' +
            'datos de un peludo que ya conoces. Si devuelve la lista vacía, pregúntale el ' +
            'nombre y el tamaño de su mascota.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {},

        async ejecutar({ idNegocio, contexto }) {
            // Sin función de mascotas no hay nada que listar, y decirlo así evita que el modelo
            // se invente una pregunta sobre perros en una barbería.
            if (!(await perfiles.tieneFuncion(idNegocio, 'mascotas'))) {
                return { mascotas: [], motivo: 'este negocio no atiende mascotas' };
            }

            // El teléfono que **probó el canal**, nunca uno dictado: esto devuelve datos de un
            // cliente concreto, así que identificarlo por lo que alguien diga sería dejar que
            // cualquiera pidiera la lista de mascotas de otro.
            const idPersona = await personaDelCanal(idNegocio, contexto?.principal, contexto?.transaction);
            if (!idPersona) return { mascotas: [], motivo: 'no te tenemos registrado todavía' };

            const mascotas = await mascotaService.listarDeCliente(idNegocio, idPersona, {
                transaction: contexto?.transaction,
            });
            return {
                mascotas: mascotas.map((m) => ({
                    id_mascota: m.id_mascota,
                    nombre: m.nombre,
                    especie: m.especie || null,
                    raza: m.raza || null,
                    // El tamaño es a la vez dato de la mascota y variante del servicio: elegir
                    // la mascota elige el precio, sin preguntarlo aparte.
                    tamano: m.tamano || null,
                })),
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
            // La variante decide cuánto dura y cuánto cuesta, así que entra ya en el hold: sin
            // ella se apartaban 40 minutos para una cita de 90 y el choque salía después, en la
            // agenda del profesional. Ver `migrate_reserva_hold_variantes.js`.
            id_variante: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            await exigirConfiguracion(idNegocio);

            // Un servicio «a cotizar» no se aparta: su precio y su duración no existen todavía,
            // así que apartar un hueco sería inventarse cuánto va a durar. Se corta aquí —en la
            // puerta de la mutación— y no solo en el flujo, porque el modelo también puede
            // pedirla y la regla tiene que valer para los dos.
            const servicio = await servicioService.getById(args.id_servicio, idNegocio);
            if (!servicio) {
                const e = new Error('Ese servicio no existe en este negocio.');
                e.code = 'SERVICIO_NO_VALIDO';
                e.statusCode = 404;
                throw e;
            }
            if (servicio.a_cotizar && (await perfiles.tieneFuncion(idNegocio, 'a_cotizar'))) {
                const e = new Error(
                    `«${servicio.nombre}» se cotiza antes de agendarlo: el precio y la duración ` +
                        'los acuerda el negocio contigo. No lo apartes.'
                );
                e.code = 'SERVICIO_A_COTIZAR';
                e.statusCode = 409;
                throw e;
            }

            const idProfesional = args.id_profesional || (await elegirProfesional(idNegocio, args));
            const variantes = args.id_variante
                ? { [args.id_servicio]: args.id_variante }
                : null;

            // La transacción del Gate se pasa hacia abajo: sin ella el servicio confirmaría
            // por su cuenta y un dry-run dejaría el hold puesto de verdad.
            const hold = await holdService.tomar(
                {
                    idNegocio,
                    idProfesional,
                    idServicios: [args.id_servicio],
                    fechaHoraInicioISO: args.inicio,
                    variantes,
                },
                { transaction: contexto.transaction }
            );

            const profesional = await profesionalService.getById(idProfesional, idNegocio);
            // Lo que se le dice al cliente sale de la variante apartada, no del precio de lista:
            // prometer el de lista y cobrar el de la variante es la queja en la puerta.
            const elegida = args.id_variante
                ? (servicio.variantes || []).find((v) => v.id_variante === args.id_variante)
                : null;

            return {
                codigo_hold: hold.codigo,
                expira_en: hold.expira_en,
                inicio: args.inicio,
                duracion_min: elegida ? elegida.duracion_min : servicio.duracion_min,
                precio: elegida
                    ? (elegida.precio != null ? Number(elegida.precio) : null)
                    : (servicio.precio != null ? Number(servicio.precio) : null),
                servicio: servicio.nombre,
                variante: elegida ? elegida.nombre : null,
                profesional: profesional?.nombre ?? null,
                // Para que el flujo pueda avisar «trae tu documento» al confirmar.
                requiere_consentimiento: Boolean(servicio.requiere_consentimiento)
                    && (await perfiles.tieneFuncion(idNegocio, 'consentimiento')),
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
            // ── Mascota (negocios de cuidado de mascotas) ──────────────────────────────────
            //
            // Dos formas, y las dos hacen falta: `id_mascota` para quien vuelve con un peludo ya
            // registrado, y el nombre suelto para quien llega por primera vez. Sin esto, en una
            // peluquería canina la cita se rechazaba con `MASCOTA_REQUERIDA` **después** de que
            // el cliente ya había dicho que sí.
            //
            // No viajan en el hold porque no cambian cuánto dura el hueco: son datos de la cita,
            // igual que el nombre del cliente.
            id_mascota: { tipo: 'entero', requerido: false, min: 1 },
            mascota_nombre: { tipo: 'string', requerido: false, max_longitud: 60 },
            mascota_tamano: { tipo: 'string', requerido: false, max_longitud: 10 },
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

            // El teléfono que se guarda es el que **el canal probó**, y solo si no hay ninguno
            // se cae al que el modelo haya recogido de la conversación.
            //
            // El orden importa y es lo que hace que la comprobación de `buscarCitaPorCodigo`
            // sirva de algo: si aquí mandara `args.cliente_telefono`, un cliente podría dictar
            // el número de otro —o el modelo entenderlo mal— y la cita quedaría a nombre de
            // quien no es. Entonces «solo el dueño puede cancelarla» protegería a la persona
            // equivocada. La plataforma impone la identidad, igual que impone el `id_negocio`
            // (ADR-010).
            const telefonoDelCanal = contexto.principal?.telefono_verificado || null;

            const cita = await citaService.crearCita(
                {
                    idNegocio,
                    idProfesional: hold.id_profesional,
                    idServicios: hold.id_servicios,
                    fechaHoraInicioISO: formatearWallTime(hold.fecha_hora_inicio),
                    clienteNombre: args.cliente_nombre,
                    clienteTelefono: telefonoDelCanal || args.cliente_telefono || null,
                    notas: args.notas || null,
                    consumirHoldId: hold.id_hold,
                    // La variante sale **del hold**, no de los argumentos: es lo que se apartó, y
                    // el hueco se midió con ella. Si viniera de la conversación, una cita podría
                    // durar más que el hueco que la estaba protegiendo (ADR-010: el contexto es
                    // una pista, el hold es el hecho).
                    variantes: hold.variantes || null,
                    // La mascota sí viene de la conversación, porque no afecta al hueco. La
                    // vertical valida que sea de este cliente (`MASCOTA_DE_OTRO_CLIENTE`).
                    idMascota: args.id_mascota || null,
                    mascota: args.mascota_nombre
                        ? { nombre: args.mascota_nombre, tamano: args.mascota_tamano || null }
                        : null,
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
            const cita = await buscarCitaPorCodigo(
                args.codigo_cita, idNegocio, contexto.transaction, contexto.principal
            );
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
        politica: ['ventana_cancelacion_min'],
        parametros: {
            codigo_cita: { tipo: 'string', requerido: true, max_longitud: 40 },
            motivo: { tipo: 'string', requerido: false, max_longitud: 300 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            await buscarCitaPorCodigo(
                args.codigo_cita, idNegocio, contexto.transaction, contexto.principal
            );

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
/**
 * Busca la cita por código **y comprueba que sea de quien la pide**.
 *
 * ## Por qué esta comprobación existe (2026-08-24)
 *
 * Hasta hoy esto solo filtraba por `codigo_publico` + `id_negocio`. Es decir: **el código ERA la
 * autorización**. Quien tuviera un código podía cancelar o mover esa cita, fuese quien fuese.
 *
 * No se explotaba porque `codigo_publico` era entonces un UUID v4, que no se adivina — o sea que
 * la seguridad la estaba dando la *longitud* del identificador, sin que nadie lo hubiera
 * decidido. Eso es un accidente afortunado, no un diseño, y **ya se rompió**: el código se
 * acortó para poder dictarlo por teléfono (`migrate:reserva-codigo-corto`), así que hoy lo único
 * que sostiene esto es la comprobación de abajo. Cancelar es además la operación irreversible
 * del catálogo: una cita cancelada por error no se «descancela».
 *
 * Así que la pertenencia se comprueba **antes** de acortar nada, y vale por sí sola.
 *
 * ## Qué se compara, y por qué eso y no otra cosa
 *
 * `principal.telefono_verificado` — el número que **el canal probó**, no el que alguien dijo. En
 * WhatsApp viene del `from` de un webhook firmado por Meta. Nunca se compara contra
 * `args.cliente_telefono` ni contra las variables de la conversación: los rellena el modelo o el
 * propio cliente, y pedirle a un atacante que declare quién es no es una comprobación.
 *
 * ## Falla cerrada, y eso tiene un coste que se acepta a sabiendas
 *
 * Si no hay teléfono probado (WebChat, que no autentica a nadie) o la cita no guarda teléfono
 * (creada en mostrador sin pedirlo), **se deniega**. Consecuencia real: un cliente cuya cita
 * apuntó el negocio a mano no podrá cancelarla por WhatsApp y tendrá que llamar. Es el lado
 * correcto en el que equivocarse — la alternativa es dejar que un desconocido con un código
 * acertado cancele citas ajenas.
 *
 * El mensaje lo dice sin tecnicismos y ofrece la salida (llamar al negocio), porque quien lo va
 * a leer es un cliente al que acabamos de decir que no.
 */
async function buscarCitaPorCodigo(codigo, idNegocio, transaction = null, principal = null) {
    const cita = await Models.ReservaCita.findOne({
        where: { codigo_publico: codigo, id_negocio: idNegocio },
        attributes: ['id_cita', 'estado', 'cliente_telefono'],
        transaction,
    });
    if (!cita) {
        const e = new Error('No encuentro esa cita.');
        e.code = 'CITA_NO_ENCONTRADA';
        e.statusCode = 404;
        throw e;
    }

    // `principal` llega en null desde la CLI de capacidades y los arneses, que operan como el
    // negocio y no como un cliente. Ahí no hay dueño que comprobar.
    if (principal && principal.tipo === TIPO_CONTACTO) {
        // ⚠️ Con el país del NEGOCIO, no con Colombia fija (2026-09-29).
        //
        // Hasta hoy esto usaba `normalizarE164Colombia`, así que en un negocio chileno los dos
        // teléfonos salían `null` y la comparación fallaba siempre. El efecto no era un error
        // visible: era que **ningún cliente de D'ALEX podía cancelar por WhatsApp**, porque esta
        // función falla cerrada a propósito. Un fallo de seguridad correcto convertido en una
        // puerta tapiada para un cliente entero.
        const pais = await paisDeNegocio(idNegocio, { transaction });
        const deQuienPide = normalizarE164(principal.telefono_verificado, pais);
        const deLaCita = normalizarE164(cita.cliente_telefono, pais);

        if (!deQuienPide || !deLaCita || deQuienPide !== deLaCita) {
            const e = new Error(
                'No puedo comprobar que esa cita sea tuya, así que no la voy a tocar. ' +
                    'Llama al negocio y te la gestionan enseguida.'
            );
            e.code = 'CITA_NO_ES_DE_QUIEN_PIDE';
            e.statusCode = 403;
            throw e;
        }
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

/**
 * Los tipos de negocio que atiende el flujo de citas.
 *
 * El flujo de citas vive en `./flujoCita.js` desde el 2026-09-29. Vivía en `engine/` «por
 * historia —era el único que había—», lo que dejaba al núcleo sabiendo qué es un servicio y qué
 * es un profesional, justo lo que ADR-009 manda que viva aquí. Se movió antes de enseñarle los
 * oficios (variantes, mascotas, cotizaciones): meter eso en `engine/` habría hecho que el núcleo
 * supiera de peluquerías caninas. Lo que sí se declara aquí es a QUIÉN atiende.
 *
 * Basta con `RESERVA`: `contextoNegocio` ya traduce el tipo guardado en el negocio a su módulo,
 * así que un rubro nuevo (spa, tatuajes, peluquería canina…) llega aquí como `RESERVA` sin que
 * nadie tenga que acordarse de listarlo. `BARBERIA` y `SALON DE BELLEZA` se quedan solo como
 * red de seguridad para una base a la que todavía no se le haya corrido `migrate:rubros-negocio`.
 *
 * Los alojamientos NO entran: usan el módulo de reserva pero reservan noches, y los atiende su
 * propio flujo (`flujoEstancia.js`), que `contextoNegocio` elige con el tipo `ALOJAMIENTO`.
 */
const TIPOS_NEGOCIO = ['RESERVA', 'BARBERIA', 'SALON DE BELLEZA'];

function registrarFlujo({ flujos }) {
    const { manejarDeterminista } = require('./flujoCita');
    // `abreConversacion`: el primer mensaje siempre saluda y enseña los servicios (o sus tipos)
    // como menú, diga lo que diga el cliente. Ver `flujos.abreLaConversacion`.
    flujos.registrar({
        vertical: VERTICAL, tipos: TIPOS_NEGOCIO, manejar: manejarDeterminista, abreConversacion: true,
    });
    // Alojamientos: mismo módulo, otro flujo (reservan noches, no citas).
    require('./flujoEstancia').registrarFlujo({ flujos });
}

module.exports = {
    TIPOS_NEGOCIO,
    registrarFlujo,
    registrarCapacidades,
    /** Los recordatorios de F8-B viven en su propio archivo: aquí solo se publican. */
    registrarRecordatorios: require('./recordatorios').registrar,
    VERTICAL,
};
