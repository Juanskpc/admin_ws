/**
 * Motor determinista — Nivel 1 de la escalera de costo (F5-D, ADR-015, ADR-018).
 *
 * Sustituye al andamio de eco. Agenda una cita entera —servicio, fecha, hora, confirmación—
 * con menús y reglas, **sin un solo token de LLM**. Ese cero es criterio de aceptación de F5,
 * no una casualidad: si esto necesitara un modelo para funcionar, no serviría como banco de
 * pruebas de la espina dorsal, que es para lo que existe.
 *
 * ## Por qué menús y no "entender lo que escribe"
 *
 * Un bot de menús numerados parece un paso atrás y no lo es. ADR-015: lo que se está validando
 * es el cableado —canal → gateway → identidad → motor → Policy Gate → capacidad → dominio—, y
 * eso se prueba mejor con un conductor **predecible** que con uno que alucina. Inventar aquí
 * reglas de intención («si dice "quiero" y "corte" entonces…») sería escribir en Nivel 1 el
 * trabajo que F6 hace mejor y va a reemplazar igualmente.
 *
 * El Nivel 1 tampoco es desechable: se queda como el peldaño que nunca falla, nunca cuesta y
 * nunca alucina, atendiendo saludos, menús y confirmaciones para siempre.
 *
 * ## Conversación y tarea, que no son lo mismo (ADR-014)
 *
 *   - `variables` es la memoria de la **conversación**, que es infinita: el nombre, el teléfono
 *     y el código de la última cita. Sobrevive a que la tarea termine.
 *   - `tarea` es el agendamiento **en curso**, que es acotado y retomable: en qué paso va, qué
 *     servicio eligió, qué hora tiene apartada. Vive en la fila de la conversación, así que un
 *     reinicio del proceso no se la lleva — ése es el «lo dejamos a medias el martes».
 *
 * ⚠️ `variables` **reemplaza, no fusiona** (ver el contrato en `motor.js#registrarManejador`).
 * Cada retorno lleva el objeto completo; por eso existe `conMemoria()` y por eso no se hace
 * `{ ...algo }` a mano en cada rama, que es donde se perderían datos sin que nadie lo note.
 *
 * ## Tres reglas que salen de leer el código, no de la teoría
 *
 * 1. **Una capacidad, como mucho una vez por turno.** El Policy Gate guarda la idempotencia
 *    por `(negocio, capacidad, clave)` y la clave que usamos es el id del turno. Si un mismo
 *    turno invocara dos veces la misma capacidad, la segunda recibiría el resultado de la
 *    primera. Por eso la FSM avanza **un paso por turno** y nunca encadena dos mutaciones.
 *    A cambio, un turno reintentado no crea dos citas, que es justo lo que se buscaba.
 *
 * 2. **El hold caduca solo, y eso es un camino normal.** `proponer_turno` aparta la hora unos
 *    minutos; quien tarda en confirmar vuelve y ya no la tiene. `reservar_turno` relee el hold
 *    del dominio y lanza `HOLD_NO_VIGENTE`. No es un error del sistema: es la conversación
 *    real, y se trata ofreciendo horas otra vez, sin disculpas raras ni callejones.
 *
 * 3. **No existe `consultar_mis_citas`.** El asistente solo puede tocar citas cuyo código ya
 *    conoce, así que el código se guarda en `variables` al crearla. Fuera de esta conversación
 *    no hay forma de recuperarlo, y la FSM está escrita **sabiéndolo** en vez de tropezar con
 *    ello a mitad. Lo desbloquea que `reserva` adopte `persona` (ver ESTADO-Y-CONTINUACION).
 *
 * ## Lo que este manejador NO hace
 *
 * No toca el esquema de conversación: devuelve una decisión y el motor la escribe. Sí invoca
 * capacidades por el Policy Gate, que abre **su propia** transacción y confirma — y eso es
 * correcto: una cita creada no debe deshacerse porque falle una escritura del Ledger.
 */
'use strict';

const policyGateReal = require('../core/policyGate');
const registry = require('../core/registry');
const identidadReal = require('./identidad');
const contextoNegocioReal = require('../core/contextoNegocio');
// Leer «sí», «cancelar» y la última línea de una ráfaga vive en `texto.js` desde F7: la
// confirmación de una mutación necesita exactamente la misma lectura, y dos lecturas distintas
// de «sí» sería un bot que confirma en un sitio y repregunta en el otro.
const { COMANDO, normalizar, ultimaLinea, esComando, saludoPorLaHora } = require('./texto');
const confirmacion = require('./confirmacion');

/** Pasos de la tarea de agendar. Enum-like: se registran en el Ledger y se miden. */
const PASO = {
    SERVICIO: 'servicio',
    PROFESIONAL: 'profesional',
    FECHA: 'fecha',
    HORA: 'hora',
    NOMBRE: 'nombre',
    CONFIRMAR: 'confirmar',
};

const TAREA_AGENDAR = 'agendar_cita';

const MAX_OPCIONES = 8;

/**
 * La opción «me da igual» del paso de profesional.
 *
 * Es una cadena y no `null` porque tiene que viajar como `id` de una opción por el canal y
 * volver como texto. `null` se convertiría en la cadena "null" en algún borde y acabaría
 * comparándose mal justo el día que nadie mire.
 */
const CUALQUIER_PROFESIONAL = 'cualquiera';

// ── Retroceso ───────────────────────────────────────────────────────────────────────────────
//
// Ids de las opciones para volver atrás. Van con prefijo para no chocar nunca con un id de
// servicio, una hora o un profesional: el resolvedor de cada paso compara contra texto, y un
// «volver» que coincidiera con un dato real sería el peor de los errores posibles.
const VOLVER = {
    SERVICIO: 'volver_servicio',
    PROFESIONAL: 'volver_profesional',
    FECHA: 'volver_fecha',
    HORA: 'volver_hora',
};

/**
 * Qué sobrevive al volver a cada paso. **Es una lista blanca a propósito.**
 *
 * Con una lista negra —«borra la hora»— cada campo nuevo que alguien añada al flujo se
 * quedaría por descuido, y el síntoma sería una selección imposible que no falla hasta el
 * último paso: elegir un servicio de 3 horas conservando una hora que se calculó para uno de
 * 30, y descubrirlo al reservar. Enumerando lo que se queda, lo que se olvida es el
 * comportamiento por defecto.
 *
 * El orden de arriba abajo es el del flujo, y cada paso conserva lo del anterior:
 *
 *   · **Servicio**: nada. Cambiar de servicio cambia la duración y a quién lo presta; todo lo
 *     que venía después se calculó para otra cosa.
 *   · **Profesional**: solo el servicio. La fecha se conserva*a*, pero la hora no: la agenda de
 *     otra persona es otra agenda.
 *   · **Fecha**: servicio y profesional. Solo caen la hora y el hold.
 *   · **Hora**: además la fecha, porque volver a las horas es volver a las de ESE día.
 *
 * *a* La fecha no se conserva al cambiar de profesional aunque podría: se prefiere volver a
 * preguntarla antes que enseñar las horas de alguien para un día que quizá no trabaja, con el
 * cliente creyendo que sigue eligiendo sobre lo mismo.
 */
const SOBREVIVE_AL_VOLVER = {
    servicio: [],
    profesional: ['id_servicio'],
    fecha: ['id_servicio', 'id_profesional_preferido', 'profesionales_ofrecidos'],
    hora: ['id_servicio', 'id_profesional_preferido', 'profesionales_ofrecidos', 'fecha'],
};

/**
 * Poda los datos de la tarea dejando solo lo que sigue siendo cierto en el paso de destino.
 *
 * **El hold no se libera, y no es un olvido.** Si había una hora apartada se queda apartada
 * hasta que caduca sola, porque soltarla exigiría invocar otra capacidad en el mismo turno y
 * la FSM invoca una por turno (la clave de idempotencia es el id del turno). Es la misma
 * decisión que ya tomó el rechazo de la confirmación, y se mantiene igual aquí para no tener
 * dos reglas distintas sobre lo mismo. El coste es que una hora queda bloqueada unos minutos
 * para los demás; el precio de la alternativa es romper una invariante del motor.
 */
function podarAlVolver(destino, datos) {
    const conservar = SOBREVIVE_AL_VOLVER[destino] || [];
    const podados = {};
    for (const clave of conservar) {
        if (datos[clave] !== undefined) podados[clave] = datos[clave];
    }
    return podados;
}

/** Reconoce «otro día», «cambiar de servicio», «con otra persona»… y el id de un chip. */
const PISTA_DE_CAMBIO = /\b(otro|otra|otros|otras|cambiar|cambia|cambio|volver|atras|regresar|distinto|distinta|diferente)\b/;

const DESTINOS_DE_RETROCESO = [
    [PASO.SERVICIO, VOLVER.SERVICIO, /\bservicios?\b/],
    [PASO.PROFESIONAL, VOLVER.PROFESIONAL, /\b(profesional|persona|estilista|barbero|peluquer\w*|manicurista)\b/],
    [PASO.FECHA, VOLVER.FECHA, /\b(dia|dias|fecha|fechas)\b/],
    [PASO.HORA, VOLVER.HORA, /\b(hora|horas|horario)\b/],
];

/**
 * ¿A qué paso quiere volver? `null` si no lo pidió.
 *
 * Un id de chip vale por sí solo; el texto libre necesita **las dos cosas**: una pista de
 * cambio y un destino. Exigir las dos es lo que evita que «quiero un corte de pelo» se lea
 * como «volver al servicio» estando ya en el menú de servicios, y que «cambiar» a secas robe
 * el «no» del paso de confirmar, donde esa palabra significa «enséñame otras horas».
 */
function destinoDeRetroceso(texto) {
    const t = normalizar(texto);
    if (!t) return null;

    for (const [destino, id] of DESTINOS_DE_RETROCESO) {
        if (t === id) return destino;
    }
    if (!PISTA_DE_CAMBIO.test(t)) return null;

    for (const [destino, , patron] of DESTINOS_DE_RETROCESO) {
        if (patron.test(t)) return destino;
    }
    return null;
}

/**
 * Memoria de conversación completa. Existe porque `variables` reemplaza en vez de fusionar:
 * construirla a mano en cada rama es la forma segura de perder el teléfono en la rama que
 * nadie probó.
 */
function conMemoria(conversacion, extra = {}) {
    const previas = conversacion.variables || {};
    return {
        nombre: previas.nombre ?? null,
        telefono: previas.telefono ?? null,
        ultima_cita: previas.ultima_cita ?? null,
        turnos: Number(previas.turnos || 0) + 1,
        ...extra,
    };
}

function paso(decision, motivo = {}) {
    return { tipo: 'regla', decision, motivo };
}

/**
 * Fecha en zona de Bogotá, que es la hora de pared con la que trabaja toda la plataforma.
 *
 * Acepta ISO y dos atajos. Deliberadamente pobre: en Nivel 1, entender «el jueves de la semana
 * que viene» es trabajo del LLM, y fingirlo aquí con expresiones regulares produce el peor de
 * los mundos — un parser que acierta lo justo para que nadie note cuándo falla.
 */
function interpretarFecha(texto, ahora = new Date()) {
    const t = normalizar(texto);

    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];

    // `en-CA` formatea como YYYY-MM-DD, así que se lee la fecha de pared de Bogotá **sin pasar
    // nunca por UTC**. La versión anterior hacía `new Date(toLocaleString(...))` y luego
    // `toISOString()`: dos conversiones que solo se cancelan si el proceso corre en UTC. En un
    // PC en Bogotá, a partir de las 19:00 la fecha UTC ya ha cambiado y tanto «hoy» como
    // «mañana» devolvían un día de más — un cliente que pedía «hoy» veía la agenda de mañana.
    const hoyISO = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(ahora);

    if (t === 'hoy') return hoyISO;
    if (t === 'manana' || t === 'mañana') {
        // Aritmética de calendario en UTC sobre una fecha sin hora: `Date.UTC` normaliza el
        // desbordamiento de mes y año, y como se construye y se lee en UTC no hay sesgo de zona.
        const [anio, mes, dia] = hoyISO.split('-').map(Number);
        return new Date(Date.UTC(anio, mes - 1, dia + 1)).toISOString().slice(0, 10);
    }
    return null;
}

/** Día siguiente a una fecha `YYYY-MM-DD`, en el mismo calendario y sin tocar zonas horarias. */
function diaSiguiente(fechaISO) {
    const [anio, mes, dia] = fechaISO.split('-').map(Number);
    return new Date(Date.UTC(anio, mes - 1, dia + 1)).toISOString().slice(0, 10);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «viernes 15» — una fecha ISO no se lee, y el chip tiene que poder leerse de un vistazo. */
function etiquetaDia(fechaISO) {
    const [anio, mes, dia] = fechaISO.split('-').map(Number);
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    return `${DIAS[d.getUTCDay()]} ${dia}`;
}

function formatearPrecio(valor) {
    if (valor == null) return '';
    return ` — $${Number(valor).toLocaleString('es-CO')}`;
}

/**
 * Crea el manejador. Las dependencias se inyectan para que la FSM se pueda probar entera
 * **sin Postgres**: los tests hostiles pasan un Gate de mentira y ejercitan los caminos que
 * en la vida real solo ocurren de vez en cuando, como el hold caducado.
 */
function crearManejadorDeterminista({
    gate = policyGateReal,
    identidad = identidadReal,
    // Quién es el negocio para el que hablamos. Inyectable como los otros dos: los tests de la
    // FSM corren sin Postgres y esto es lo único nuevo que tocaría la base.
    contextoNegocio = contextoNegocioReal,
    ahora = () => new Date(),
} = {}) {
    /**
     * Invoca una capacidad. La clave de idempotencia es el id del turno: un turno reintentado
     * —porque el proceso murió, o porque la conversación estaba ocupada— devuelve lo que ya
     * hizo en vez de volver a hacerlo.
     */
    async function invocar({
        capacidad,
        args,
        principal,
        idNegocio,
        turno,
        invocaciones,
        confirmadoPor = null,
    }) {
        const iniciado = Date.now();
        try {
            const sobre = await gate.ejecutar({
                capacidad,
                principal,
                idNegocio,
                args,
                claveIdempotencia: turno?.id_turno ? String(turno.id_turno) : undefined,
                // Las mutaciones que comprometen al negocio no se ejecutan sin el sí del
                // cliente (ADR-010). La FSM lo tiene delante —acaba de leerlo en el paso de
                // confirmar— y lo pasa; el Gate es quien lo exige.
                ...(confirmadoPor ? { confirmadoPor } : {}),
            });
            invocaciones?.push({
                capacidad,
                vertical: sobre?.vertical ?? null,
                argumentos: args,
                resultado: 'ok',
                latenciaMs: Date.now() - iniciado,
                dryRun: Boolean(sobre?.dry_run),
            });
            return sobre;
        } catch (error) {
            // Las que fallan se registran igual, y son las que más importan: una capacidad
            // denegada o rota es media respuesta a «¿por qué el bot hizo eso?».
            invocaciones?.push({
                capacidad,
                // En el `catch` no existe la respuesta del Gate, así que sale del Registry por
                // nombre. Antes iba `null` y la columna es NOT NULL: el rastro del error se
                // llevaba por delante el turno entero. Ver `repositorio.registrarInvocacion`.
                vertical: registry.describir(capacidad)?.vertical ?? null,
                argumentos: args,
                resultado: error.code && error.statusCode === 403 ? 'denegado' : 'error',
                errorCodigo: error.code ?? null,
                latenciaMs: Date.now() - iniciado,
            });
            throw error;
        }
    }

    // ── Menú inicial ────────────────────────────────────────────────────────────────────

    /**
     * Saludo de apertura. Dice **con quién** está hablando el cliente, que es lo primero que
     * pregunta cualquiera al escribir a un negocio y lo que el bot no contestaba: arrancaba con
     * «¿Qué servicio quieres agendar?», idéntico en una barbería y en un consultorio.
     *
     * El nombre sale del contexto del inquilino, no de una constante ni del texto de la FSM: el
     * día que sea configurable por negocio (Business Context, ADR-020/F6) cambia de origen sin
     * tocar esto. Y si no se conoce, `tratamiento` ya trae una fórmula neutra — aquí no se
     * comprueba si hay nombre, porque el olvido saldría publicado como «te saluda null».
     *
     * ## Por qué cambió el 2026-08-26
     *
     * Decía «¡Hola! Te comunicas con X.», que es como contesta un conmutador, no un negocio. Se
     * cambió en el restaurante primero —lo señaló el dueño— y aquí por lo mismo: **el saludo por
     * la hora del día es lo que más barato compra la sensación de que hay alguien**. Cuesta una
     * línea y se nota en el primer mensaje, que es el único que todo el mundo lee.
     *
     * La negrita es la de WhatsApp: **un** asterisco. Con dos, el cliente ve los asteriscos.
     */
    function saludo(ctx) {
        const nombre = (ctx.conversacion.variables || {}).nombre;
        const quien = ctx.negocio?.tratamiento || 'el negocio';
        const hora = saludoPorLaHora(ahora());
        return nombre
            ? `👋 ${hora} Qué bueno tenerte de vuelta, ${nombre}. Te saluda *${quien}*.`
            : `👋 ${hora} Te saluda *${quien}*.`;
    }

    async function ofrecerServicios(ctx, pasosPrevios = [], { saludar = false } = {}) {
        const { resultado } = await invocar({ ...ctx, capacidad: 'consultar_servicios', args: {} });
        const servicios = (resultado?.servicios || []).slice(0, MAX_OPCIONES);
        const apertura = saludar ? `${saludo(ctx)} ` : '';

        if (servicios.length === 0) {
            return {
                pasos: [...pasosPrevios, paso('sin_servicios')],
                // También se saluda aquí: que no haya agenda no es motivo para que el cliente
                // no sepa a dónde escribió.
                respuestas: [`${apertura}Ahora mismo no tenemos servicios disponibles para agendar.`],
                variables: conMemoria(ctx.conversacion),
                tarea: null,
                resultado: 'sin_respuesta',
                nivel: 'determinista',
            };
        }

        return {
            pasos: [...pasosPrevios, paso('menu_servicios', { cuantos: servicios.length })],
            respuestas: [
                {
                    texto: `${apertura}¿Qué servicio te gustaría agendar?`,
                    // Nunca numerado dentro del texto: va en `opciones` y cada canal lo pinta
                    // como sabe (ADR-017). El WebChat los hace chips; WhatsApp, botones.
                    // El nombre va en `etiqueta` y lo demás en `detalle` (F8-A): en el WebChat
                    // se pintan juntos como antes, y en WhatsApp el detalle cabe en la
                    // descripción de la fila en vez de morir en el recorte de 20 caracteres del
                    // título de un botón, que se comía justo el precio.
                    opciones: servicios.map((s) => ({
                        id: String(s.id_servicio),
                        etiqueta: s.nombre,
                        detalle: `${s.duracion_min} min${formatearPrecio(s.precio)}`,
                    })),
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    paso: PASO.SERVICIO,
                    // Se recuerda QUÉ se ofreció para poder resolver la respuesta contra la
                    // lista real en vez de adivinar. Sin esto había que sacar un número del
                    // texto libre, y «Corte de cabello (30 min) — $35.000» daba el servicio 30.
                    ofrecidos: servicios.map((s) => ({ id: s.id_servicio, nombre: s.nombre })),
                },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // ── Pasos de la tarea ───────────────────────────────────────────────────────────────

    /**
     * Resuelve la respuesta contra los servicios que se ofrecieron, en tres pasadas.
     *
     * Antes se hacía `texto.match(/\d+/)` —el primer número del texto— y era un cristal:
     * el WebChat manda la etiqueta del chip al pulsarlo, así que «Corte de cabello (30 min) —
     * $35.000» se leía como el servicio **30**. La conversación seguía tan campante hasta el
     * paso de fecha, donde `consultar_disponibilidad` devolvía cero horas para cualquier día y
     * parecía que el negocio no tenía agenda. Un fallo de interpretación disfrazado de fallo de
     * datos, tres pasos más adelante.
     *
     * El orden importa: primero el id exacto (lo que manda un chip), después el nombre (lo que
     * escribe una persona en WhatsApp) y solo al final un número dentro de la frase — «mejor 2»
     * es una respuesta legítima.
     *
     * Lo que salva esa última pasada de repetir el bug es **validar contra la lista**: en
     * «Corte de cabello (30 min)» el 30 no es un id ofrecido, así que se descarta en vez de
     * inventarse un servicio. Antes se aceptaba cualquier número por el hecho de serlo.
     */
    function resolverServicio(texto, ofrecidos) {
        if (!ofrecidos || ofrecidos.length === 0) return null;
        const t = normalizar(texto);

        const porId = ofrecidos.find((s) => t === String(s.id));
        if (porId) return porId;

        const porNombre = ofrecidos.find((s) => t.includes(normalizar(s.nombre)));
        if (porNombre) return porNombre;

        for (const n of t.match(/\d+/g) || []) {
            const s = ofrecidos.find((x) => x.id === Number(n));
            if (s) return s;
        }
        return null;
    }

    async function elegirServicio(ctx, datos) {
        // Una conversación abierta ANTES de que se guardara `ofrecidos` no lo tiene: su
        // `tarea_datos` está persistido en la base y no se migra solo. Sin lista contra la que
        // validar no se puede resolver sin adivinar, así que se vuelve a ofrecer el menú —que
        // la repuebla— en vez de arriesgar otra elección inventada.
        if (!datos.ofrecidos) {
            return ofrecerServicios(ctx, [paso('menu_repetido', { motivo: 'sin_ofrecidos' })]);
        }

        const servicio = resolverServicio(ultimaLinea(ctx.texto), datos.ofrecidos);
        if (!servicio) {
            return reintentar(ctx, datos, 'Elige uno de los servicios de la lista, por favor.');
        }
        const idServicio = Number(servicio.id);
        return ofrecerProfesionales(
            ctx,
            { ...datos, id_servicio: idServicio },
            [paso('servicio_elegido', { id_servicio: idServicio })]
        );
    }

    /** El paso de fecha, que es a donde se llega con o sin elegir profesional. */
    function pedirFecha(ctx, datos, pasosPrevios) {
        return {
            pasos: pasosPrevios,
            respuestas: [
                {
                    texto: '¿Para qué día? Puedes decirme "hoy", "mañana" o una fecha (2026-08-20).',
                    opciones: [
                        { id: 'hoy', etiqueta: 'Hoy' },
                        { id: 'mañana', etiqueta: 'Mañana' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    /**
     * Ofrece quién puede atender — y se salta el paso cuando preguntar no aporta nada.
     *
     * ## Las dos decisiones que hacen que esto no estorbe
     *
     * **1. «Me da igual» va primero.** La mayoría de la gente no tiene preferencia, y para esa
     * mayoría preguntar es fricción pura: un paso más entre «quiero un corte» y tenerlo
     * agendado. Si el menú se añadiera sin una salida rápida y visible, el flujo empeoraría
     * para casi todos con tal de mejorar para unos pocos. Por eso la primera opción —la que
     * más se pulsa sin leer— es la que equivale al comportamiento anterior.
     *
     * **2. Con un solo profesional NO se pregunta.** Ofrecer un menú de una opción es pedirle
     * a alguien que confirme lo inevitable. Se salta directo a la fecha y no se guarda
     * `id_profesional`: dejar la disponibilidad sin filtrar da el mismo resultado —solo hay
     * uno— y evita que la conversación afirme una elección que el cliente nunca hizo.
     *
     * Si no hay ninguno, tampoco se pregunta: se sigue a la fecha y el paso de disponibilidad
     * dirá «no hay horas», que es donde ese problema se explica bien.
     */
    async function ofrecerProfesionales(ctx, datos, pasosPrevios) {
        const { resultado } = await invocar({
            ...ctx,
            capacidad: 'consultar_profesionales',
            args: { id_servicio: datos.id_servicio },
        });
        const profesionales = (resultado?.profesionales || []).slice(0, MAX_OPCIONES);

        if (profesionales.length <= 1) {
            return pedirFecha(ctx, datos, [
                ...pasosPrevios,
                paso('profesional_no_se_pregunta', { cuantos: profesionales.length }),
            ]);
        }

        return {
            pasos: [...pasosPrevios, paso('menu_profesionales', { cuantos: profesionales.length })],
            respuestas: [
                {
                    texto: '¿Con quién prefieres?',
                    opciones: [
                        { id: CUALQUIER_PROFESIONAL, etiqueta: 'Me da igual', detalle: 'El primero que tenga hueco' },
                        ...profesionales.map((pr) => ({
                            id: String(pr.id_profesional),
                            etiqueta: pr.nombre,
                            detalle: pr.especialidad || undefined,
                        })),
                        { id: VOLVER.SERVICIO, etiqueta: '← Otro servicio' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    ...datos,
                    paso: PASO.PROFESIONAL,
                    // Misma razón que con los servicios: se recuerda lo ofrecido para resolver
                    // la respuesta contra la lista real en vez de sacar un número del texto.
                    profesionales_ofrecidos: profesionales.map((pr) => ({
                        id: pr.id_profesional,
                        nombre: pr.nombre,
                    })),
                },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    /**
     * Resuelve a quién eligió, contra la lista que se ofreció.
     *
     * Devuelve `undefined` si no se entiende, y `null` si dijo que le da igual — que **no es lo
     * mismo** y por eso no se colapsan: `null` es una elección («cualquiera»), `undefined` es
     * una falta de respuesta que hay que repreguntar.
     */
    function resolverProfesional(texto, ofrecidos) {
        const t = normalizar(texto);
        if (!t) return undefined;

        if (
            t === CUALQUIER_PROFESIONAL ||
            /\b(me da igual|cualquiera|el que sea|da igual|indiferente|no tengo preferencia)\b/.test(t)
        ) {
            return null;
        }

        if (!ofrecidos || ofrecidos.length === 0) return undefined;

        const porId = ofrecidos.find((pr) => t === String(pr.id));
        if (porId) return porId.id;

        // Por nombre, y también por el nombre de pila suelto: quien escribe en WhatsApp pone
        // «con Laura», no «Laura Gómez».
        const porNombre = ofrecidos.find((pr) => {
            const completo = normalizar(pr.nombre);
            const pila = completo.split(' ')[0];
            return t.includes(completo) || (pila.length >= 3 && t.includes(pila));
        });
        if (porNombre) return porNombre.id;

        for (const num of t.match(/\d+/g) || []) {
            const pr = ofrecidos.find((x) => x.id === Number(num));
            if (pr) return pr.id;
        }
        return undefined;
    }

    /**
     * Lleva la conversación al paso pedido, con los datos ya podados.
     *
     * Un solo sitio para las cuatro vueltas: si cada rama decidiera por su cuenta qué
     * conservar, la que nadie prueba acabaría arrastrando una hora que ya no existe.
     */
    async function volverA(ctx, destino, datos) {
        const podados = podarAlVolver(destino, datos);
        const rastro = [paso('retroceso', { desde: datos.paso ?? null, hacia: destino })];

        switch (destino) {
            case PASO.SERVICIO:
                return ofrecerServicios(ctx, rastro);
            case PASO.PROFESIONAL:
                return ofrecerProfesionales(ctx, podados, rastro);
            case PASO.HORA:
                // Volver a las horas de ESE día. Si no hay día guardado —porque se venía de
                // más atrás— no hay nada a lo que volver, y se pide la fecha.
                return podados.fecha
                    ? mostrarHoras(ctx, podados, podados.fecha, rastro)
                    : pedirFecha(ctx, podados, rastro);
            case PASO.FECHA:
            default:
                return pedirFecha(ctx, podados, rastro);
        }
    }

    async function elegirProfesional(ctx, datos) {
        // Igual que en el paso de servicio: una conversación abierta antes de que esto
        // existiera no tiene la lista guardada, así que se vuelve a ofrecer el menú en vez de
        // resolver a ciegas.
        if (!datos.profesionales_ofrecidos) {
            return ofrecerProfesionales(ctx, datos, [paso('menu_repetido', { motivo: 'sin_profesionales_ofrecidos' })]);
        }

        const elegido = resolverProfesional(ultimaLinea(ctx.texto), datos.profesionales_ofrecidos);
        if (elegido === undefined) {
            return reintentar(ctx, datos, 'Dime con quién prefieres, o "me da igual".');
        }

        return pedirFecha(
            ctx,
            { ...datos, id_profesional_preferido: elegido },
            [paso('profesional_elegido', { id_profesional: elegido })]
        );
    }

    async function elegirFecha(ctx, datos) {
        const fecha = interpretarFecha(ultimaLinea(ctx.texto), ahora());
        if (!fecha) {
            return reintentar(ctx, datos, 'No entendí la fecha. Dime "hoy", "mañana" o algo como 2026-08-20.');
        }
        return mostrarHoras(ctx, datos, fecha, []);
    }

    /**
     * Consulta y pinta las horas libres de un día.
     *
     * Va aparte de `elegirFecha` desde que existe el retroceso: volver a la lista de horas no
     * debe obligar a repreguntar la fecha que el cliente ya dijo. Antes, rechazar la
     * confirmación mandaba al paso de fecha y había que volver a teclear el día — un paso de
     * castigo por cambiar de opinión.
     */
    async function mostrarHoras(ctx, datos, fecha, pasosPrevios) {
        const { resultado } = await invocar({
            ...ctx,
            capacidad: 'consultar_disponibilidad',
            args: {
                id_servicio: datos.id_servicio,
                fecha,
                // Solo va si eligió a alguien. `id_profesional_preferido` en `null` significa
                // «me da igual» y es justo la ausencia del filtro, no un filtro con valor nulo.
                ...(datos.id_profesional_preferido
                    ? { id_profesional: datos.id_profesional_preferido }
                    : {}),
            },
        });
        const horas = (resultado?.horas || []).slice(0, MAX_OPCIONES);

        if (horas.length === 0) {
            // El chip lleva el día siguiente **al consultado**, no «mañana». Ofrecer «Mañana»
            // aquí era un callejón sin salida: se resuelve contra HOY, así que quien acababa de
            // oír «no hay horas el 14» pulsaba «Mañana» y volvía a preguntar por el 14, en
            // bucle. Se avanza de día en día porque `consultar_disponibilidad` mira una sola
            // fecha y la FSM invoca una capacidad por turno (clave de idempotencia = id del
            // turno): sondear varios días de golpe exige otra capacidad, no otro parche aquí.
            const siguiente = diaSiguiente(fecha);
            return {
                pasos: [...pasosPrevios, paso('sin_disponibilidad', { fecha })],
                respuestas: [
                    {
                        texto: datos.id_profesional_preferido
                            ? `No hay horas libres el ${fecha} con quien elegiste. ¿Probamos el ${siguiente}?`
                            : `No hay horas libres el ${fecha}. ¿Probamos el ${siguiente}?`,
                        opciones: [
                            { id: siguiente, etiqueta: etiquetaDia(siguiente) },
                            // Solo si había preferencia: sin ella, «otra persona» no significa
                            // nada y sería una opción que no lleva a ninguna parte.
                            ...(datos.id_profesional_preferido
                                ? [{ id: VOLVER.PROFESIONAL, etiqueta: '← Con otra persona' }]
                                : []),
                        ],
                    },
                ],
                variables: conMemoria(ctx.conversacion),
                // Se retrocede al paso de fecha, no se cierra la tarea: quien quería una cita
                // sigue queriéndola aunque ese día estuviera lleno.
                tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        // ⚠️ Se guarda QUÉ profesional tiene libre cada hora, y no solo la hora.
        //
        // `consultar_disponibilidad` funde las agendas de varios profesionales y devuelve,
        // por cada hora, el primero que la tiene libre — el adaptador lo hace explícitamente
        // «para que la capacidad de reserva no tenga que volver a calcularlo». Si aquí se
        // tirara ese dato, `proponer_turno` volvería a elegir profesional por su cuenta y
        // podría escoger a uno que acaba de ocuparse: `SLOT_NO_DISPONIBLE` sobre una hora que
        // el bot mismo acababa de ofrecer. Lo cazó el test de extremo a extremo en cuanto
        // hubo dos profesionales y una cita previa.
        const profesionalPorHora = Object.fromEntries(horas.map((h) => [h.hora, h.id_profesional]));

        return {
            pasos: [...pasosPrevios, paso('menu_horas', { fecha, cuantas: horas.length })],
            respuestas: [
                {
                    texto: `Estas son las horas libres el ${fecha}:`,
                    // Ocho horas + «otro día» = nueve filas, dentro del límite de diez de una
                    // lista de WhatsApp (`channels/whatsapp/adaptador.js`, LIMITES). Añadir
                    // aquí una segunda opción de volver rompería ese margen.
                    opciones: [
                        ...horas.map((h) => ({ id: h.hora, etiqueta: h.hora })),
                        { id: VOLVER.FECHA, etiqueta: '← Otro día' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: { ...datos, paso: PASO.HORA, fecha, profesional_por_hora: profesionalPorHora },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    /**
     * Elegida la hora, hace falta el nombre **antes** de apartar nada.
     *
     * El orden importa: el hold dura minutos, así que se toma lo más tarde posible. Preguntar
     * el nombre con la hora ya apartada regala esos minutos a un formulario y hace que el hold
     * caduque justo cuando el cliente está a punto de confirmar.
     */
    async function elegirHora(ctx, datos) {
        const hora = normalizar(ultimaLinea(ctx.texto)).match(/\d{1,2}:\d{2}/);
        if (!hora) {
            return reintentar(ctx, datos, 'Elige una de las horas de la lista, por favor.');
        }
        const conHora = {
            ...datos,
            hora: hora[0],
            id_profesional: datos.profesional_por_hora?.[hora[0]] ?? null,
        };

        if (!ctx.identidad.nombre) {
            return {
                pasos: [paso('hora_elegida', { hora: hora[0], pide_nombre: true })],
                respuestas: ['¿A nombre de quién agendo la cita?'],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...conHora, paso: PASO.NOMBRE } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }
        return apartarHora(ctx, conHora, ctx.identidad.nombre, [
            paso('hora_elegida', { hora: hora[0], pide_nombre: false }),
        ]);
    }

    async function recibirNombre(ctx, datos) {
        // Excepción a la regla de la última línea: «Nicolás\nPaez» son dos trozos de UN
        // nombre, no dos intenciones. Aquí se unen en vez de quedarse con el último.
        const nombre = String(ctx.texto || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .join(' ');
        if (nombre.length < 2) {
            return reintentar(ctx, datos, 'Necesito un nombre para la cita. ¿Cómo te llamas?');
        }
        return apartarHora(ctx, datos, nombre, [paso('nombre_recibido')]);
    }

    /** Toma el hold y pide confirmación. Única invocación de `proponer_turno` del turno. */
    async function apartarHora(ctx, datos, nombre, pasosPrevios) {
        const inicio = `${datos.fecha}T${datos.hora}:00`;
        const { resultado } = await invocar({
            ...ctx,
            capacidad: 'proponer_turno',
            args: {
                id_servicio: datos.id_servicio,
                inicio,
                // El mismo profesional que tenía libre esa hora cuando se ofreció. Sin esto,
                // el adaptador vuelve a elegir y puede caer en uno ya ocupado.
                ...(datos.id_profesional ? { id_profesional: datos.id_profesional } : {}),
            },
        });

        const detalle = [
            `${resultado.servicio}`,
            resultado.profesional ? `con ${resultado.profesional}` : null,
            `el ${datos.fecha} a las ${datos.hora}`,
            resultado.duracion_min ? `(${resultado.duracion_min} min)` : null,
            resultado.precio != null ? formatearPrecio(resultado.precio).replace(' — ', '— ') : null,
        ]
            .filter(Boolean)
            .join(' ');

        return {
            pasos: [...pasosPrevios, paso('hora_apartada', { codigo_hold: resultado.codigo_hold })],
            respuestas: [
                {
                    texto: `Te aparté ${detalle}. ¿Confirmo la cita?`,
                    opciones: [
                        { id: 'si', etiqueta: 'Sí, confirmar' },
                        { id: 'no', etiqueta: 'Ver otras horas' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion, { nombre }),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: { ...datos, paso: PASO.CONFIRMAR, codigo_hold: resultado.codigo_hold, nombre },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    async function confirmar(ctx, datos) {
        if (esComando(ctx.texto, COMANDO.NO)) {
            // No se libera el hold a mano: caduca solo. Soltarlo aquí exigiría otra mutación
            // en el mismo turno, y eso choca con la regla de una capacidad por turno.
            //
            // Desde el retroceso (2026-08-24) se vuelve a las horas de ESE día en vez de
            // repreguntar la fecha. «Ver otras horas» prometía justo eso y llevaba a teclear
            // otra vez el día: un paso de castigo por cambiar de opinión.
            return volverA(ctx, PASO.HORA, { ...datos, paso: PASO.CONFIRMAR });
        }

        if (!esComando(ctx.texto, COMANDO.SI)) {
            return reintentar(ctx, datos, '¿Confirmo la cita? Respóndeme sí o no.');
        }

        try {
            const { resultado } = await invocar({
                ...ctx,
                capacidad: 'reservar_turno',
                args: {
                    codigo_hold: datos.codigo_hold,
                    cliente_nombre: datos.nombre,
                    cliente_telefono: ctx.identidad.telefono || undefined,
                },
                // Éste es el sí: el texto que acaba de pasar por `COMANDO.SI` dos líneas arriba.
                confirmadoPor: { idTurno: ctx.turno?.id_turno, texto: ctx.texto },
            });

            return {
                pasos: [paso('cita_creada', { codigo_cita: resultado.codigo_cita })],
                respuestas: [
                    `¡Listo! Tu cita quedó agendada para el ${datos.fecha} a las ${datos.hora}. ` +
                        `El código es ${resultado.codigo_cita} — guárdalo por si quieres cambiarla o cancelarla.`,
                ],
                // El código va a `variables` y no solo al texto: sin `consultar_mis_citas`, es
                // la ÚNICA forma de que el asistente pueda reagendar o cancelar después.
                variables: conMemoria(ctx.conversacion, {
                    nombre: datos.nombre,
                    ultima_cita: resultado.codigo_cita,
                }),
                tarea: null,
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        } catch (error) {
            if (error.code === 'HOLD_NO_VIGENTE') {
                // Camino normal, no avería: tardó en confirmar y la hora se liberó sola.
                return {
                    pasos: [paso('hold_caducado', { codigo_hold: datos.codigo_hold })],
                    respuestas: [
                        {
                            texto: 'Se me liberó esa hora mientras esperábamos. ¿Miramos las horas libres otra vez?',
                            opciones: [{ id: datos.fecha, etiqueta: `Ver el ${datos.fecha}` }],
                        },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            throw error;
        }
    }

    /** Repregunta sin avanzar ni perder la tarea: el paso se queda donde estaba. */
    function reintentar(ctx, datos, texto) {
        return {
            pasos: [paso('entrada_no_entendida', { paso: datos.paso })],
            respuestas: [texto],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: TAREA_AGENDAR, datos },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // ── Entrada ─────────────────────────────────────────────────────────────────────────

    return async function manejarDeterminista({ conversacion, mensajes, turno, texto }) {
        const identidad = await identidad_(conversacion);
        const negocio = await contextoNegocio.obtener(conversacion.id_negocio);
        // Se acumulan aquí y se adjuntan al final en UN solo sitio: hacerlo en cada rama sería
        // olvidarlo en la rama que nadie probó, y el Ledger quedaría con agujeros que no
        // parecen agujeros.
        const invocaciones = [];
        const ctx = {
            conversacion,
            mensajes,
            turno,
            texto,
            identidad,
            negocio,
            invocaciones,
            principal: identidad.principal,
            idNegocio: Number(conversacion.id_negocio),
        };

        const datos = conversacion.tarea_datos || {};
        const hayTarea = conversacion.tarea_actual === TAREA_AGENDAR;

        // Una mutación esperando el sí del cliente manda sobre todo lo demás, incluso sobre
        // «cancelar»: ahí esa palabra no significa «sal del flujo», significa «no lo hagas»
        // — y las dos lecturas acaban en el mismo sitio, que es no ejecutar nada.
        if (confirmacion.pendiente(conversacion)) {
            return conRastro(await confirmacion.resolver(ctx, { gate, ahora }));
        }

        // Cancelar manda en cualquier paso. Es lo primero que se mira a propósito: un cliente
        // que quiere salir tiene que poder salir, aunque esté a mitad de un formulario.
        if (esComando(texto, COMANDO.CANCELAR)) {
            return {
                pasos: [paso('tarea_cancelada', { paso: datos.paso ?? null })],
                respuestas: ['Listo, lo dejamos aquí. Escríbeme cuando quieras agendar.'],
                variables: conMemoria(conversacion),
                tarea: null,
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        if (hayTarea && esComando(texto, COMANDO.SEGUIMOS)) {
            // Retomar no repite trabajo: se vuelve a preguntar lo del paso donde se quedó.
            return reintentar(ctx, datos, `Seguimos donde lo dejamos. ${textoDelPaso(datos.paso)}`);
        }

        // Retroceder. Va DESPUÉS de cancelar y de la confirmación pendiente —que mandan
        // siempre— y ANTES del paso actual, porque «otro día» no es una respuesta al paso en
        // el que se está: es la petición de no responderlo.
        if (hayTarea) {
            const destino = destinoDeRetroceso(ultimaLinea(texto));
            if (destino && destino !== datos.paso) {
                return conRastro(await volverA(ctx, destino, datos));
            }
        }

        if (!hayTarea || esComando(texto, COMANDO.MENU)) {
            // Se saluda cuando NO había tarea —es decir, alguien que llega, no alguien que
            // vuelve al menú a mitad de un agendamiento—. Repetir «¡Hola! Te comunicas con…»
            // a quien lleva cinco turnos hablando suena a que el bot se olvidó de él.
            return conRastro(
                await ofrecerServicios(ctx, [paso('inicio_conversacion')], { saludar: !hayTarea })
            );
        }

        switch (datos.paso) {
            case PASO.SERVICIO:
                return conRastro(await elegirServicio(ctx, datos));
            case PASO.PROFESIONAL:
                return conRastro(await elegirProfesional(ctx, datos));
            case PASO.FECHA:
                return conRastro(await elegirFecha(ctx, datos));
            case PASO.HORA:
                return conRastro(await elegirHora(ctx, datos));
            case PASO.NOMBRE:
                return conRastro(await recibirNombre(ctx, datos));
            case PASO.CONFIRMAR:
                return conRastro(await confirmar(ctx, datos));
            default:
                // Tarea con un paso que esta versión no conoce: puede pasar si se despliega
                // una FSM nueva con conversaciones vivas a medias. Se vuelve al menú en vez
                // de reventar, que es lo que un cliente a mitad de camino merece.
                return conRastro(
                    await ofrecerServicios(ctx, [paso('paso_desconocido', { paso: datos.paso ?? null })])
                );
        }

        /** Adjunta al Ledger lo que se invocó. Un solo sitio para todas las ramas. */
        function conRastro(decision) {
            return invocaciones.length ? { ...decision, invocaciones } : decision;
        }
    };

    function identidad_(conversacion) {
        return identidad.resolver(conversacion);
    }
}

function textoDelPaso(pasoActual) {
    switch (pasoActual) {
        case PASO.SERVICIO:
            return 'Elige el servicio de la lista.';
        case PASO.PROFESIONAL:
            return '¿Con quién prefieres? También puedes decir "me da igual".';
        case PASO.FECHA:
            return '¿Para qué día lo quieres?';
        case PASO.HORA:
            return 'Elige una de las horas libres.';
        case PASO.NOMBRE:
            return '¿A nombre de quién agendo la cita?';
        case PASO.CONFIRMAR:
            return '¿Confirmo la cita?';
        default:
            return '';
    }
}

module.exports = {
    crearManejadorDeterminista,
    /** Manejador listo para producción, con el Policy Gate y el resolver de verdad. */
    manejarDeterminista: crearManejadorDeterminista(),
    PASO,
    TAREA_AGENDAR,
    COMANDO,
    interpretarFecha,
};
