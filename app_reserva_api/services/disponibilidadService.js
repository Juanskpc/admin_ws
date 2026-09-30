'use strict';
const Models = require('../../app_core/models/conection');
const Reglas = require('./reglasAgenda');
const ConfigService = require('./configService');
const Composicion = require('./composicionCita');
const Perfiles = require('../perfiles');

/**
 * Calcula los slots disponibles para unos servicios + profesional + fecha.
 *
 * Desde F3 **no implementa las reglas de la agenda**: las consume de `reglasAgenda`, que es
 * el mismo módulo que usa la creación de citas. Antes había dos implementaciones de la misma
 * regla y divergieron —el buffer se aplicaba a medias aquí y entero al crear—, así que este
 * servicio ofrecía horas que después se rechazaban con un 409. Su trabajo ahora es solo el
 * que le corresponde: **partir los huecos reservables en slots**.
 *
 * Algoritmo:
 *   1. Config del negocio (anticipación, buffer, paso de slot).
 *   2. Servicios (duración total) y profesional, todos del negocio.
 *   3. `Reglas.huecosReservables` → horario laboral − bloqueos − (citas y holds ± buffer).
 *   4. Genera slots cada `paso_slot_min` que quepan enteros en un hueco.
 *   5. Marca como no disponibles los que no cumplen la anticipación mínima.
 *
 * **Garantía de F3:** todo slot marcado `disponible: true` pasa la verificación de
 * `Reglas.verificarReservable`. Si eso deja de ser cierto, es un bug, no una diferencia de
 * criterio.
 *
 * ## Por qué acepta varios servicios
 *
 * `crearCita` reserva la **suma** de las duraciones de todos los servicios de la cita
 * (`citaService`: `duracionTotal = servicios.reduce(...)`). Este servicio solo sabía de uno,
 * así que al pedir corte + peinado ofrecía slots del tamaño del primero y la creación los
 * rechazaba por solaparse: la misma divergencia que F3 vino a cerrar, en el otro eje.
 * `idServicios` es ahora la entrada natural; `idServicio` se mantiene porque el enlace público
 * de reserva lo sigue enviando.
 *
 * Devuelve: { fecha, duracion_servicio_min, buffer_min, paso_slot_min, slots: [{ hora, disponible, motivo? }] }
 */
/**
 * @param {number} [params.excluirCita] — id de cita que NO debe contar como ocupada.
 *        Al editar una cita, su propia hora tiene que seguir ofreciéndose: sin esto el
 *        formulario de edición mostraría como tomado justo el hueco que ya es suyo.
 * @param {Object|Array} [params.variantes] — variante elegida por servicio (`{ id_servicio:
 *        id_variante }`). Cambia la duración, y con ella las horas que caben.
 * @param {Array} [params.ajustes] — duración acordada de un servicio «a cotizar».
 * @param {string[]} [params.funciones] — funciones activas del negocio. Si no llega se lee del
 *        perfil; quien calcula para varios profesionales la pasa para no releerla cada vez.
 *
 * ## Dos caminos, y por qué el viejo sigue intacto
 *
 * Si la cita no tiene tiempo de proceso ni necesita cabina —siempre, en una barbería— se
 * generan los slots **exactamente como antes**: huecos reservables partidos en pasos. Solo
 * cuando hay tramos de espera o recurso se usa el camino nuevo, que comprueba cada hora contra
 * los trozos en que el profesional trabaja y contra las cabinas libres. La prueba dorada
 * (`__tests__/reserva/motor_dorado.test.js`) vigila que el primero no cambie.
 */
async function calcularSlots({
    idNegocio, idServicio, idServicios, idProfesional, fechaISO, excluirCita = null,
    variantes = null, ajustes = null, funciones = null,
}) {
    const ids = normalizarIdsServicio(idServicios, idServicio);
    if (!idNegocio || ids.length === 0 || !idProfesional || !fechaISO) {
        const e = new Error('Parámetros incompletos'); e.statusCode = 400; throw e;
    }

    const cfg = await getConfig(idNegocio);
    const filas = await Models.ReservaServicio.findAll({
        where: { id_servicio: ids, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'nombre', 'duracion_min', 'precio', 'proceso_desde_min',
                     'proceso_min', 'a_cotizar', 'id_tipo_recurso', 'requiere_consentimiento'],
    });
    if (filas.length !== ids.length) {
        const e = new Error('Servicio no encontrado'); e.statusCode = 404; throw e;
    }
    // En el orden pedido: con tiempo de proceso, dónde cae la espera depende de qué va primero.
    const servicios = ids.map((id) => filas.find((s) => s.id_servicio === id));

    const profesional = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_profesional'],
    });
    if (!profesional) {
        const e = new Error('Profesional no encontrado'); e.statusCode = 404; throw e;
    }

    const activas = funciones ?? (await Perfiles.perfilDeNegocio(idNegocio)).funciones;
    const comp = Composicion.componer(servicios, {
        funciones: activas,
        variantes: await variantesElegidas(idNegocio, Composicion.normalizarVariantes(variantes)),
        ajustes: Composicion.normalizarAjustes(ajustes),
    });
    const duracion = comp.duracion;

    const vacio = {
        fecha: fechaISO,
        duracion_servicio_min: duracion,
        buffer_min: cfg.buffer_limpieza_min,
        paso_slot_min: cfg.paso_slot_min,
        slots: [],
    };

    const minimoInicio = Reglas.addMinutes(new Date(), Number(cfg.anticipacion_min_minutos || 0));
    const paso = cfg.paso_slot_min;
    const slots = [];
    const empujar = (t) => {
        const disponible = t >= minimoInicio;
        slots.push({
            hora: formatearHoraLocal(t),
            disponible,
            ...(disponible ? {} : { motivo: 'anticipacion' }),
        });
    };

    if (!comp.tramos && !comp.idTipoRecurso) {
        // ── Camino de siempre ──
        const huecos = await Reglas.huecosReservables(
            {
                idNegocio,
                idProfesional,
                fechaISO,
                bufferMin: cfg.buffer_limpieza_min,
            },
            { excluirCita },
        );
        if (huecos.length === 0) return vacio;

        for (const [desde, hasta] of huecos) {
            let t = redondearHaciaArriba(desde, paso);
            while (Reglas.addMinutes(t, duracion) <= hasta) {
                empujar(t);
                t = Reglas.addMinutes(t, paso);
            }
        }
    } else {
        // ── Con espera o con cabina ──
        const laborales = await Reglas.intervalosLaborales({ idNegocio, idProfesional, fechaISO });
        if (laborales.length === 0) return vacio;
        const ocupados = await Reglas.intervalosOcupados(
            { idNegocio, idProfesional, fechaISO, bufferMin: cfg.buffer_limpieza_min },
            { excluirCita },
        );

        let idsRecurso = [];
        let ocupacionRecursos = new Map();
        if (comp.idTipoRecurso) {
            idsRecurso = (await Reglas.recursosDelTipo(idNegocio, comp.idTipoRecurso)).map((r) => r.id_recurso);
            if (idsRecurso.length === 0) return { ...vacio, motivo: 'sin_recurso' };
            ocupacionRecursos = await Reglas.intervalosRecursos({
                idNegocio,
                idRecursos: idsRecurso,
                desde: laborales[0][0],
                hasta: laborales[laborales.length - 1][1],
                bufferMin: cfg.buffer_limpieza_min,
            }, { excluirCita });
        }

        for (const [desde, hasta] of laborales) {
            let t = redondearHaciaArriba(desde, paso);
            while (Reglas.addMinutes(t, duracion) <= hasta) {
                const fin = Reglas.addMinutes(t, duracion);
                const partes = Reglas.partesOcupadas(t, fin, comp.tramos);
                let libre = partes.every((p) => !ocupados.some((o) => Reglas.seSolapan(p, o)));
                if (libre && idsRecurso.length) {
                    libre = Reglas.recursoLibreEn(ocupacionRecursos, idsRecurso, t, fin) != null;
                }
                if (libre) empujar(t);
                t = Reglas.addMinutes(t, paso);
            }
        }
    }

    // Dos huecos distintos no pueden producir la misma hora, pero sí llegan desordenados
    // cuando un bloqueo parte la jornada. El cliente espera la lista en orden.
    slots.sort((a, b) => a.hora.localeCompare(b.hora));

    return { ...vacio, slots };
}

/**
 * Las filas de variante elegidas, validadas contra el negocio. Una variante inactiva o de otro
 * negocio se descarta aquí y `componer` usa el precio de lista: ofrecer horas no debe fallar por
 * un enlace viejo.
 */
async function variantesElegidas(idNegocio, mapa) {
    if (!mapa || mapa.size === 0) return new Map();
    const filas = await Models.ReservaServicioVariante.findAll({
        where: { id_variante: [...mapa.values()], id_negocio: idNegocio, estado: 'A' },
    });
    const porId = new Map(filas.map((v) => [v.id_variante, v]));
    const salida = new Map();
    for (const [idServicio, idVariante] of mapa) {
        const v = porId.get(idVariante);
        if (v && Number(v.id_servicio) === idServicio) salida.set(idServicio, v);
    }
    return salida;
}

/**
 * Qué días de un rango tienen jornada laboral, y de qué hora a qué hora.
 *
 * Responde a la pregunta que el formulario de cita hacía **antes** de pedir slots y que hasta
 * ahora nadie contestaba: el selector de fecha ofrecía cualquier día del calendario y el
 * usuario descubría que el negocio no abre los lunes solo tras elegir el lunes y ver la lista
 * de horas vacía. Un día cerrado no debería ser seleccionable.
 *
 * Se apoya en `Reglas.intervalosLaborales`, la misma primitiva que usan slots y creación, así
 * que «el día está abierto» aquí significa exactamente lo mismo que allí: hay horario para ese
 * día de la semana y ningún bloqueo se lo ha comido entero.
 *
 * `idProfesional` es opcional: sin él responde por el horario general del negocio, que es lo
 * que se quiere mostrar antes de que el usuario elija profesional.
 *
 * Devuelve: [{ fecha, abierto, minutos, rangos: [{ inicio, fin }] }]
 */
async function diasDisponibles({ idNegocio, idProfesional = null, desde, hasta }) {
    if (!idNegocio || !desde || !hasta) {
        const e = new Error('Parámetros incompletos'); e.statusCode = 400; throw e;
    }

    const fechas = enumerarFechas(desde, hasta);
    if (fechas.length === 0) {
        const e = new Error('Rango de fechas inválido'); e.statusCode = 400; throw e;
    }
    // Consultar una tabla por día es una consulta por día. 92 (un trimestre) es holgado para
    // un selector de fechas y acota el coste.
    if (fechas.length > 92) {
        const e = new Error('El rango no puede superar 92 días'); e.statusCode = 400; throw e;
    }

    return Promise.all(fechas.map(async (fechaISO) => {
        const laborales = await Reglas.intervalosLaborales({ idNegocio, idProfesional, fechaISO });
        const minutos = laborales.reduce((acc, [i, f]) => acc + (f - i) / 60_000, 0);
        return {
            fecha: fechaISO,
            abierto: laborales.length > 0,
            minutos,
            rangos: laborales.map(([i, f]) => ({
                inicio: formatearHoraLocal(i),
                fin: formatearHoraLocal(f),
            })),
        };
    }));
}

// ────────────────────────── Helpers propios de la vista de slots ──────────────────────────

/**
 * Acepta `[1,2]`, `"1,2"`, `"[1,2]"` o un único id, y devuelve ids únicos.
 *
 * El multipart del flujo público manda los arrays como string, así que la normalización vive
 * donde se usa en vez de depender de que cada llamante la haya hecho bien.
 */
function normalizarIdsServicio(idServicios, idServicio) {
    let bruto = idServicios;
    if (typeof bruto === 'string') {
        const s = bruto.trim();
        try { bruto = s.startsWith('[') ? JSON.parse(s) : s.split(','); }
        catch { bruto = s.split(','); }
    }
    if (bruto == null) bruto = idServicio == null ? [] : [idServicio];
    if (!Array.isArray(bruto)) bruto = [bruto];

    const ids = bruto
        .map((v) => Number(String(v).trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    return [...new Set(ids)];
}

function formatearHoraLocal(date) {
    const opts = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false };
    return new Intl.DateTimeFormat('en-GB', opts).format(date);
}

/** Redondea `date` hacia arriba al múltiplo más cercano de `pasoMin`. */
function redondearHaciaArriba(date, pasoMin) {
    const ms = pasoMin * 60_000;
    return new Date(Math.ceil(date.getTime() / ms) * ms);
}

/** `YYYY-MM-DD` de cada día entre `desde` y `hasta`, ambos inclusive. */
function enumerarFechas(desde, hasta) {
    const ini = Reglas.inicioDelDia(desde);
    const fin = Reglas.inicioDelDia(hasta);
    if (Number.isNaN(ini.getTime()) || Number.isNaN(fin.getTime()) || fin < ini) return [];
    const out = [];
    for (let d = ini; d <= fin; d = Reglas.addMinutes(d, 24 * 60)) {
        out.push(Reglas.fechaISOLocal(d));
    }
    return out;
}

/**
 * La configuración del negocio como objeto plano.
 *
 * Delega en `configService.get`, que es el **único** sitio donde nace la fila: antes había dos
 * `create` (aquí y allí), y los valores de arranque de cada rubro se habrían aplicado en uno y
 * no en el otro según qué pantalla abriera el negocio primero.
 */
async function getConfig(idNegocio) {
    const cfg = await ConfigService.get(idNegocio);
    return cfg.toJSON();
}

module.exports = { calcularSlots, diasDisponibles, getConfig, variantesElegidas };
