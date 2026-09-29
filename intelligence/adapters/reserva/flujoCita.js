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

const policyGateReal = require('../../core/policyGate');
const registry = require('../../core/registry');
const identidadReal = require('../../engine/identidad');
const contextoNegocioReal = require('../../core/contextoNegocio');
// Leer «sí», «cancelar» y la última línea de una ráfaga vive en `texto.js` desde F7: la
// confirmación de una mutación necesita exactamente la misma lectura, y dos lecturas distintas
// de «sí» sería un bot que confirma en un sitio y repregunta en el otro.
const { COMANDO, normalizar, ultimaLinea, esComando, saludoPorLaHora } = require('../../engine/texto');
const confirmacion = require('../../engine/confirmacion');
// El estado que apaga el bot, pone la conversación en la bandeja y avisa al negocio (campanita y
// correo, `avisos/escalado.js`). `resultado: 'handoff'` a secas solo cuenta en el Ledger: un
// mensaje que dice «le aviso al negocio» sin este estado es una promesa que nadie cumple.
const { ESTADO_HANDOFF } = require('../../engine/handoff');

/** Pasos de la tarea de agendar. Enum-like: se registran en el Ledger y se miden. */
const PASO = {
    /**
     * El tipo de servicio («Cabello», «Uñas», «Faciales»). Solo cuando el catálogo es largo y
     * está ordenado en categorías: leer quince servicios para encontrar uno es lo que hacía que
     * el cliente escribiera en vez de pulsar (ver `usaCategorias`).
     */
    CATEGORIA: 'categoria',
    SERVICIO: 'servicio',
    /**
     * El largo del cabello, el tamaño de la mascota, la zona del cuerpo. Va **entre el servicio
     * y las horas** y no más tarde: la variante cambia la duración, y la duración decide qué
     * horas caben. Preguntarla después de elegir hora obligaría a retirar una hora ya ofrecida.
     */
    VARIANTE: 'variante',
    /**
     * Para cuál de sus mascotas. Solo en negocios que las atienden, donde además es obligatoria:
     * sin ella la vertical rechaza la cita (`MASCOTA_REQUERIDA`).
     *
     * Va **antes** que la variante porque el tamaño de la mascota ES la variante: elegir a
     * Firulais (grande) fija el precio del baño de perro grande sin preguntarlo aparte.
     */
    MASCOTA: 'mascota',
    // Desde el 2026-09-29 el orden es servicio → día → hora → nombre → profesional: primero
    // CUÁNDO y después CON QUIÉN, ofreciendo solo a quien tiene libre esa hora. Antes se elegía
    // la persona primero y con frecuencia no tenía hueco el día que el cliente quería.
    FECHA: 'fecha',
    HORA: 'hora',
    NOMBRE: 'nombre',
    PROFESIONAL: 'profesional',
    CONFIRMAR: 'confirmar',
};

const TAREA_AGENDAR = 'agendar_cita';

const MAX_OPCIONES = 8;

/**
 * Con más servicios que esto, y el catálogo repartido en al menos dos categorías, se pregunta
 * primero el tipo. Es MAX_OPCIONES a propósito: hasta ahí caben en una sola lista de WhatsApp
 * (10 filas) con sitio para volver, y por encima había que recortar y el cliente no veía todo.
 */
const UMBRAL_CATEGORIAS = MAX_OPCIONES;

/** «Ver más» en una lista larga. Prefijados como los de VOLVER para no chocar con un id real. */
const MAS_SERVICIOS = 'mas_servicios';
const MAS_CATEGORIAS = 'mas_categorias';

/** Ids de categoría en el menú. Los servicios sin categoría van juntos en «Otros». */
const CATEGORIA_OTROS = 'cat_otros';
const idDeCategoria = (idCategoria) => (idCategoria == null ? CATEGORIA_OTROS : `cat_${idCategoria}`);

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
    CATEGORIA: 'volver_categoria',
    SERVICIO: 'volver_servicio',
    PROFESIONAL: 'volver_profesional',
    FECHA: 'volver_fecha',
    HORA: 'volver_hora',
};

/**
 * Los tamaños de mascota, con el texto que ve el cliente.
 *
 * ⚠️ Las claves son las de `reserva_mascota.tamano` **y** las de `reserva_servicio_variante.clave`
 * (ver el comentario de ese modelo). Que sean las mismas no es casualidad: es lo que permite que
 * elegir la mascota elija también la variante de precio, sin preguntar dos veces. Si alguien
 * cambia una de las dos listas sin la otra, el emparejamiento deja de funcionar **en silencio**:
 * el bot seguirá agendando, pero con el precio del tamaño equivocado.
 */
const TAMANOS_MASCOTA = {
    PEQUENO: 'Pequeño',
    MEDIANO: 'Mediano',
    GRANDE: 'Grande',
    GIGANTE: 'Gigante',
};

/** `GRANDE` → `Grande`, para el detalle del botón. Un tamaño desconocido no se pinta. */
function etiquetaTamano(clave) {
    return TAMANOS_MASCOTA[String(clave || '').toUpperCase()] || null;
}

/** La mascota nueva, cuando el cliente no quiere ninguna de las que ya tiene registradas. */
const OTRA_MASCOTA = 'otra_mascota';

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
 *   · **Categoría**: nada.
 *   · **Servicio**: solo la categoría. Cambiar de servicio cambia la duración y a quién lo
 *     presta; todo lo que venía después se calculó para otra cosa.
 *   · **Fecha**: lo del pedido (servicio, mascota, variante). Caen la hora y el hold.
 *   · **Hora**: además la fecha, porque volver a las horas es volver a las de ESE día.
 *   · **Profesional**: además la hora y quién la tiene libre: cambiar de persona no mueve la cita.
 */
const DEL_PEDIDO = ['id_servicio', 'categoria', 'id_mascota', 'mascota_nombre', 'mascota_tamano',
    'id_variante', 'variante_nombre', 'perfil'];
const SOBREVIVE_AL_VOLVER = {
    categoria: [],
    // Volver a los servicios es volver a los de la MISMA categoría: el cliente pidió otro
    // servicio, no otro tipo.
    servicio: ['categoria'],
    fecha: DEL_PEDIDO,
    hora: [...DEL_PEDIDO, 'fecha'],
    // Cambiar de persona conserva el día y la hora: la lista de profesionales es la de quienes
    // tienen libre ESA hora, así que no hay nada que recalcular.
    profesional: [...DEL_PEDIDO, 'fecha', 'hora', 'libres_por_hora', 'profesional_por_hora', 'nombre'],
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
    // Antes que el de servicio: «elegir otro tipo de servicio» nombra las dos cosas y pide la
    // primera. En un negocio sin categorías, volver aquí acaba en la lista de servicios igual.
    [PASO.CATEGORIA, VOLVER.CATEGORIA, /\b(tipo|tipos|categorias?)\b/],
    // Los términos de cada oficio entran aquí: en un spa el cliente escribe «otro tratamiento»
    // y en un tatuador «otra sesión». Sin ellos, «cambiar de tratamiento» no se reconocía como
    // un retroceso y se leía como una respuesta al paso en curso.
    [PASO.SERVICIO, VOLVER.SERVICIO, /\b(servicios?|tratamientos?)\b/],
    [PASO.PROFESIONAL, VOLVER.PROFESIONAL,
     /\b(profesional|persona|estilista|barbero|peluquer\w*|manicurista|terapeuta|especialista|artista|groomer|tatuador\w*)\b/],
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
 * ── El idioma del oficio ────────────────────────────────────────────────────────────────────
 *
 * Un spa no tiene «servicios» sino tratamientos, ni «profesionales» sino terapeutas; un tatuador
 * agenda «sesiones» con «artistas»; una peluquería canina trabaja con «groomers». El diccionario
 * vive en `app_reserva_api/perfiles/definiciones.js` y llega al flujo dentro de
 * `consultar_servicios`, junto con las funciones que el negocio tiene encendidas.
 *
 * ⚠️ **Nunca se pregunta por el nombre del perfil.** El flujo pregunta qué funciones hay activas
 * y cómo se llaman las cosas; si en este archivo apareciera un `if (perfil === 'SALON')`, la
 * regla que protege a la barbería ya estaría rota (`docs/asistente-reserva.md` §1).
 *
 * Los valores por defecto son los de la barbería, que es lo que se usaba antes de que esto
 * existiera: un negocio cuyo perfil no se pudo leer sigue hablando como siempre.
 */
const TERMINOS_POR_DEFECTO = {
    profesional: 'Profesional',
    profesionales: 'Profesionales',
    servicio: 'Servicio',
    servicios: 'Servicios',
    cita: 'Cita',
    citas: 'Citas',
    cliente: 'Cliente',
    clientes: 'Clientes',
};

/** Los términos de la barbería ya en minúscula, para las funciones fuera del closure. */
const TERMINOS_POR_DEFECTO_MINUSCULA = Object.fromEntries(
    Object.entries(TERMINOS_POR_DEFECTO).map(([k, v]) => [k, v.toLocaleLowerCase('es')]),
);

/** El diccionario del negocio, en minúscula, listo para meter en una frase. */
function terminos(datos) {
    const propios = datos?.perfil?.terminos || {};
    const mezcla = { ...TERMINOS_POR_DEFECTO, ...propios };
    const salida = {};
    for (const [clave, valor] of Object.entries(mezcla)) {
        salida[clave] = String(valor || '').toLocaleLowerCase('es');
    }
    return salida;
}

/** ¿Tiene el negocio esta función encendida? Sin perfil leído, no. */
function tiene(datos, funcion) {
    return Array.isArray(datos?.perfil?.funciones) && datos.perfil.funciones.includes(funcion);
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
    if (!t) return null;

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
    const [anioHoy, mesHoy, diaHoy] = hoyISO.split('-').map(Number);
    // Aritmética de calendario en UTC sobre fechas sin hora: `Date.UTC` normaliza el desborde
    // de mes y año, y como se construye y se lee en UTC no hay sesgo de zona.
    const masDias = (n) => new Date(Date.UTC(anioHoy, mesHoy - 1, diaHoy + n)).toISOString().slice(0, 10);

    // ── Lo que escribe una persona (2026-09-29) ─────────────────────────────────────────
    //
    // Hasta hoy solo se entendía «hoy», «mañana» y `2026-10-02`, que nadie escribe. Un cliente
    // pone «el viernes», «el 15», «2 de octubre» o «pasado mañana», y todo eso caía al modelo
    // —que cuesta— o en un «no entendí la fecha». Se cubren las formas comunes y nada más: lo
    // raro («el jueves de la otra semana») sigue siendo trabajo del modelo, y fingirlo aquí con
    // expresiones regulares es el peor de los mundos — acertar lo justo para que nadie note
    // cuándo falla.
    //
    // Una hora (`10:00`) no es una fecha: si el texto trae dos puntos, no se busca un día en él.
    const sinHoras = t.replace(/\d{1,2}:\d{2}/g, ' ');

    // «2 de octubre», «octubre 2»
    for (let i = 0; i < MESES.length; i++) {
        const mesNombre = MESES[i];
        const m = sinHoras.match(new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s+)?${mesNombre}\\b`))
            || sinHoras.match(new RegExp(`\\b${mesNombre}\\s+(\\d{1,2})\\b`));
        if (m) return proximaFechaCon(Number(m[1]), i + 1, hoyISO);
    }

    // «2/10», «02-10» (día/mes)
    const dm = sinHoras.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
    if (dm) return proximaFechaCon(Number(dm[1]), Number(dm[2]), hoyISO);

    if (/\bpasado\s+manana\b/.test(sinHoras)) return masDias(2);

    // «el 15», «viernes 2» (el número manda sobre el nombre del día: es más preciso)
    const numero = sinHoras.match(/\b(\d{1,2})\b/);
    if (numero) {
        const dia = Number(numero[1]);
        if (dia >= 1 && dia <= 31) return proximaFechaCon(dia, null, hoyISO);
    }

    if (/\bhoy\b/.test(sinHoras)) return hoyISO;
    if (/\bmanana\b/.test(sinHoras)) return masDias(1);

    // «el viernes», «para el sábado»
    const nombresDia = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const hoyDow = new Date(Date.UTC(anioHoy, mesHoy - 1, diaHoy)).getUTCDay();
    for (let dow = 0; dow < 7; dow++) {
        if (new RegExp(`\\b${nombresDia[dow]}\\b`).test(sinHoras)) {
            // El mismo día de la semana que hoy es la semana que viene: quien dice «el lunes»
            // un lunes casi nunca quiere decir hoy (para eso dice «hoy»).
            const faltan = (dow - hoyDow + 7) % 7 || 7;
            return masDias(faltan);
        }
    }

    return null;
}

/**
 * La próxima fecha —hoy incluido— con ese día del mes (y ese mes, si se dijo).
 *
 * «El 15» dicho el 20 es el 15 del mes que viene, no uno que ya pasó. Un día que no existe en un
 * mes («el 31» en septiembre) salta al siguiente mes que lo tenga, en vez de desbordarse al 1 de
 * octubre sin avisar. Devuelve `null` si en un año no aparece (un 31 de febrero).
 */
function proximaFechaCon(dia, mes, hoyISO) {
    if (!Number.isInteger(dia) || dia < 1 || dia > 31) return null;
    if (mes != null && (!Number.isInteger(mes) || mes < 1 || mes > 12)) return null;
    const [anio, mesHoy] = hoyISO.split('-').map(Number);

    for (let k = 0; k < 13; k++) {
        const base = new Date(Date.UTC(anio, mesHoy - 1 + k, 1));
        const a = base.getUTCFullYear();
        const m = base.getUTCMonth() + 1;
        if (mes != null && m !== mes) continue;
        const candidato = new Date(Date.UTC(a, m - 1, dia));
        if (candidato.getUTCMonth() + 1 !== m) continue; // ese mes no tiene ese día
        const iso = candidato.toISOString().slice(0, 10);
        if (iso >= hoyISO) return iso;
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

const MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * «viernes 2 de octubre». Es como se dice una fecha en una conversación.
 *
 * El bot escribía `2026-10-02` en cada mensaje —«No hay horas libres el 2026-09-29»—, que es
 * como la guarda la base, no como la lee nadie. Aritmética en UTC sobre una fecha sin hora: no
 * hay zona que la corra de día.
 */
function fechaLegible(fechaISO) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fechaISO || ''))) return String(fechaISO || '');
    const [anio, mes, dia] = fechaISO.split('-').map(Number);
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    return `${DIAS[d.getUTCDay()]} ${dia} de ${MESES[mes - 1]}`;
}

function formatearPrecio(valor, desde = false) {
    if (valor == null) return '';
    // «desde $35.000» cuando el servicio tiene variantes: el precio de lista es el del caso más
    // barato, y enseñarlo a secas haría que la clienta de pelo largo se sintiera engañada al
    // llegar. Una palabra evita esa conversación en el mostrador.
    return ` — ${desde ? 'desde ' : ''}$${Number(valor).toLocaleString('es-CO')}`;
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

    /**
     * ¿Se pregunta primero el tipo de servicio?
     *
     * Solo si el catálogo es largo **y** está repartido en al menos dos categorías. Con pocos
     * servicios la lista entera cabe y un paso más es fricción; con todo en una misma categoría
     * (o sin ninguna), preguntar el tipo sería ofrecer una sola opción.
     */
    function usaCategorias(servicios) {
        if (servicios.length <= UMBRAL_CATEGORIAS) return false;
        return new Set(servicios.map((s) => idDeCategoria(s.categoria?.id_categoria))).size > 1;
    }

    /** Las categorías del catálogo, en el orden que fijó el negocio, con «Otros» al final. */
    function categoriasDe(servicios) {
        const porId = new Map();
        for (const s of servicios) {
            const id = idDeCategoria(s.categoria?.id_categoria);
            if (!porId.has(id)) {
                porId.set(id, {
                    id,
                    nombre: s.categoria?.nombre || 'Otros',
                    orden: s.categoria ? Number(s.categoria.orden ?? 0) : Number.MAX_SAFE_INTEGER,
                    cuantos: 0,
                });
            }
            porId.get(id).cuantos += 1;
        }
        return [...porId.values()].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es'));
    }

    /**
     * Arranque del agendamiento: saluda (si toca) y enseña qué se puede reservar.
     *
     * Con catálogo largo y en categorías, primero el tipo; si no, los servicios directamente.
     * `categoria` en `undefined` significa «aún no se eligió» y deja que se decida aquí; con
     * valor, se muestran solo los servicios de esa categoría.
     */
    async function ofrecerServicios(ctx, pasosPrevios = [], { saludar = false, categoria, pagina = 0 } = {}) {
        const { resultado } = await invocar({ ...ctx, capacidad: 'consultar_servicios', args: {} });
        const todos = resultado?.servicios || [];
        const apertura = saludar ? `${saludo(ctx)} ` : '';
        // Cómo habla este oficio y qué tiene encendido. Viene con los servicios —una sola
        // llamada— y se guarda en la tarea para que los pasos siguientes no vuelvan a pedirlo.
        const perfil = resultado?.negocio || null;
        const t = terminos({ perfil });

        if (todos.length === 0) {
            return {
                pasos: [...pasosPrevios, paso('sin_servicios')],
                // También se saluda aquí: que no haya agenda no es motivo para que el cliente
                // no sepa a dónde escribió.
                respuestas: [`${apertura}Ahora mismo no tenemos ${t.servicios} disponibles para agendar.`],
                variables: conMemoria(ctx.conversacion),
                tarea: null,
                resultado: 'sin_respuesta',
                nivel: 'determinista',
            };
        }

        const conCategorias = usaCategorias(todos);
        if (conCategorias && categoria === undefined) {
            return ofrecerCategorias(ctx, pasosPrevios, { apertura, perfil, t, todos, pagina });
        }

        const delTipo = conCategorias
            ? todos.filter((s) => idDeCategoria(s.categoria?.id_categoria) === categoria)
            : todos;
        // Si la categoría guardada ya no existe (se vació a mitad de conversación), se vuelve a
        // empezar por los tipos en vez de enseñar una lista vacía.
        if (delTipo.length === 0) {
            return ofrecerServicios(ctx, pasosPrevios, { saludar });
        }

        const inicio = pagina * MAX_OPCIONES;
        const servicios = delTipo.slice(inicio, inicio + MAX_OPCIONES);
        const hayMas = delTipo.length > inicio + MAX_OPCIONES;
        const nombreCategoria = conCategorias
            ? categoriasDe(todos).find((c) => c.id === categoria)?.nombre
            : null;

        const pregunta = nombreCategoria
            ? `Estos son los ${t.servicios} de *${nombreCategoria}*. ¿Cuál te gustaría agendar?`
            : `${apertura}¿Qué ${t.servicio} te gustaría agendar?`;

        return {
            pasos: [...pasosPrevios, paso('menu_servicios', {
                cuantos: servicios.length, categoria: categoria ?? null, pagina,
            })],
            respuestas: [
                {
                    texto: pregunta,
                    // Nunca numerado dentro del texto: va en `opciones` y cada canal lo pinta
                    // como sabe (ADR-017). El WebChat los hace chips; WhatsApp, una lista.
                    // El nombre va en `etiqueta` y lo demás en `detalle` (F8-A): en el WebChat
                    // se pintan juntos, y en WhatsApp el detalle cabe en la descripción de la
                    // fila en vez de morir en el recorte de 20 caracteres del título.
                    opciones: [
                        ...servicios.map((s) => ({
                            id: String(s.id_servicio),
                            etiqueta: s.nombre,
                            // Un servicio a cotizar NO lleva precio en el detalle: enseñar el de
                            // lista es prometer algo que el negocio va a desmentir. Y uno con
                            // variantes lleva «desde», porque el precio depende de cuál se elija.
                            detalle: s.a_cotizar
                                ? 'Precio a convenir'
                                : `${s.duracion_min} min${formatearPrecio(s.precio, s.variantes?.length > 0)}`,
                        })),
                        // 8 servicios + «Ver más» + «Otro tipo» = 10, el máximo de una lista.
                        ...(hayMas ? [{ id: MAS_SERVICIOS, etiqueta: `Ver más ${t.servicios}` }] : []),
                        // El título de una fila de WhatsApp corta en 24 caracteres: el texto
                        // completo («Elegir otro tipo de servicio») va en el detalle.
                        ...(conCategorias
                            ? [{
                                id: VOLVER.CATEGORIA,
                                etiqueta: '← Otro tipo',
                                detalle: `Elegir otro tipo de ${t.servicio}`,
                            }]
                            : []),
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    paso: PASO.SERVICIO,
                    perfil,
                    ...(conCategorias ? { categoria } : {}),
                    pagina,
                    // Se recuerda QUÉ se ofreció para poder resolver la respuesta contra la
                    // lista real en vez de adivinar. Sin esto había que sacar un número del
                    // texto libre, y «Corte de cabello (30 min) — $35.000» daba el servicio 30.
                    //
                    // Se guarda también lo que decide los pasos siguientes: si hay que
                    // cotizarlo, qué variantes tiene y si pide consentimiento. Así el paso
                    // siguiente no necesita volver a consultar el catálogo.
                    ofrecidos: servicios.map((s) => ({
                        id: s.id_servicio,
                        nombre: s.nombre,
                        a_cotizar: Boolean(s.a_cotizar),
                        requiere_consentimiento: Boolean(s.requiere_consentimiento),
                        variantes: s.variantes || [],
                    })),
                },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    /** El menú de tipos de servicio. Una fila por categoría, con cuántos servicios tiene. */
    function ofrecerCategorias(ctx, pasosPrevios, { apertura, perfil, t, todos, pagina = 0 }) {
        const lista = categoriasDe(todos);
        // Con diez o menos caben todas en una lista de WhatsApp; si no, nueve y «Ver más».
        const porPagina = lista.length <= 10 ? 10 : 9;
        const inicio = pagina * porPagina;
        const categorias = lista.slice(inicio, inicio + porPagina);
        const hayMas = lista.length > inicio + porPagina;

        return {
            pasos: [...pasosPrevios, paso('menu_categorias', { cuantas: categorias.length, pagina })],
            respuestas: [
                {
                    texto: `${apertura}¿Qué tipo de ${t.servicio} te gustaría agendar?`,
                    opciones: [
                        ...categorias.map((c) => ({
                            id: c.id,
                            etiqueta: c.nombre,
                            detalle: `${c.cuantos} ${c.cuantos === 1 ? t.servicio : t.servicios}`,
                        })),
                        ...(hayMas ? [{ id: MAS_CATEGORIAS, etiqueta: 'Ver más tipos' }] : []),
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    paso: PASO.CATEGORIA,
                    perfil,
                    pagina,
                    categorias_ofrecidas: categorias.map((c) => ({ id: c.id, nombre: c.nombre })),
                },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    async function elegirCategoria(ctx, datos) {
        const texto = ultimaLinea(ctx.texto);
        const t = normalizar(texto);
        if (t === MAS_CATEGORIAS || /\bver mas\b/.test(t)) {
            return ofrecerServicios(ctx, [paso('mas_categorias')], { pagina: (datos.pagina || 0) + 1 });
        }
        const elegida = resolverOpcion(texto, datos.categorias_ofrecidas);
        if (!elegida) {
            return reintentar(ctx, datos, 'Elige uno de los tipos de la lista, por favor.');
        }
        return ofrecerServicios(ctx, [paso('categoria_elegida', { categoria: elegida.id })], {
            categoria: elegida.id,
        });
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

    /**
     * Resuelve la respuesta contra una lista de opciones `{ id, nombre }`.
     *
     * Es `resolverServicio` generalizado, y existe por la misma razón que aquél: el WebChat
     * manda la **etiqueta** del chip al pulsarlo y WhatsApp manda el **id**, así que hay que
     * aceptar las dos formas y validar siempre contra la lista real.
     *
     * Lo que NO hace es aceptar un número suelto por el hecho de serlo: si el texto trae un 30
     * porque el nombre decía «30 min», ese 30 tiene que estar entre los ids ofrecidos para
     * contar. Ésa es la parte que evitó repetir el bug de «Corte de cabello (30 min)» leído como
     * el servicio 30.
     */
    function resolverOpcion(texto, ofrecidas) {
        if (!ofrecidas || ofrecidas.length === 0) return null;
        const t = normalizar(texto);
        if (!t) return null;

        const porId = ofrecidas.find((o) => t === String(o.id));
        if (porId) return porId;

        const porNombre = ofrecidas.find((o) => o.nombre && t.includes(normalizar(o.nombre)));
        if (porNombre) return porNombre;

        for (const n of t.match(/\d+/g) || []) {
            const o = ofrecidas.find((x) => String(x.id) === n);
            if (o) return o;
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

        const t = terminos(datos);
        const texto = ultimaLinea(ctx.texto);
        if (normalizar(texto) === MAS_SERVICIOS || /\bver mas\b/.test(normalizar(texto))) {
            return ofrecerServicios(ctx, [paso('mas_servicios')], {
                categoria: datos.categoria, pagina: (datos.pagina || 0) + 1,
            });
        }
        const servicio = resolverServicio(texto, datos.ofrecidos);
        if (!servicio) {
            return reintentar(ctx, datos, `Elige uno de los ${t.servicios} de la lista, por favor.`);
        }
        const idServicio = Number(servicio.id);
        const elegido = { ...datos, id_servicio: idServicio, servicio_nombre: servicio.nombre };

        // ── Lo que se cotiza no se agenda por chat ────────────────────────────────────────
        //
        // En un tatuador la mayoría de trabajos no tienen precio hasta que el artista ve qué
        // quiere el cliente. Apartar una hora exigiría saber cuánto va a durar, y no se sabe.
        //
        // Antes el flujo lo ofrecía con su precio de lista y la vertical lo rechazaba al
        // confirmar (`SERVICIO_A_COTIZAR`): el cliente elegía día y hora, daba su nombre, decía
        // que sí, y ahí se caía. Ahora se corta en el primer paso y se dice por qué.
        if (servicio.a_cotizar) {
            return cederAlNegocio(ctx, elegido, servicio);
        }

        return despuesDelServicio(ctx, elegido, [paso('servicio_elegido', { id_servicio: idServicio })]);
    }

    /**
     * Qué toca después de elegir servicio, según el oficio.
     *
     * Es el único sitio donde se decide el orden, y por eso se lee de un vistazo: mascota →
     * variante → día. Cada paso se salta solo si el negocio no tiene esa función o si el dato
     * ya está resuelto, así que en una barbería —todo apagado— se cae directo al día. El
     * profesional va después de la hora (`ofrecerProfesionales`).
     */
    async function despuesDelServicio(ctx, datos, pasosPrevios) {
        const servicio = (datos.ofrecidos || []).find((x) => Number(x.id) === Number(datos.id_servicio));

        // 1. La mascota, si el negocio las atiende y aún no se sabe cuál.
        if (tiene(datos, 'mascotas') && !datos.id_mascota && !datos.mascota_nombre) {
            return preguntarMascota(ctx, datos, pasosPrevios);
        }

        // 2. La variante. El tamaño de la mascota ya la resuelve, así que este paso solo
        //    aparece cuando no hay mascota que la decida.
        const variantes = servicio?.variantes || [];
        if (tiene(datos, 'variantes') && variantes.length > 0 && !datos.id_variante) {
            const porTamano = datos.mascota_tamano
                ? variantes.find((v) => v.clave && v.clave === datos.mascota_tamano)
                : null;
            if (porTamano) {
                return despuesDelServicio(
                    ctx,
                    { ...datos, id_variante: porTamano.id_variante, variante_nombre: porTamano.nombre },
                    [...pasosPrevios, paso('variante_por_tamano', {
                        id_variante: porTamano.id_variante, tamano: datos.mascota_tamano,
                    })],
                );
            }
            return ofrecerVariantes(ctx, datos, variantes, pasosPrevios);
        }

        // 3. El día. El profesional se pregunta después de la hora, entre quienes la tienen libre.
        return pedirFecha(ctx, datos, pasosPrevios);
    }

    /**
     * Un servicio «a cotizar»: se le pasa la conversación al negocio.
     *
     * No es una limitación que haya que disimular, es cómo trabaja el oficio: el artista mira el
     * diseño, dice cuánto cuesta y cuánto dura, y entonces se agenda. Lo honesto es decirlo y
     * avisar a una persona, no simular una agenda que después se desmiente.
     *
     * La tarea se cierra (`tarea: null`): dejarla abierta haría que el cliente siguiera dentro
     * de un formulario que ya no lleva a ninguna parte.
     */
    function cederAlNegocio(ctx, datos, servicio) {
        const t = terminos(datos);
        const quien = ctx.negocio?.tratamiento || 'el negocio';
        return {
            pasos: [paso('servicio_a_cotizar', { id_servicio: datos.id_servicio })],
            respuestas: [
                `«${servicio.nombre}» se cotiza antes de agendar: el precio y el tiempo dependen ` +
                    'de lo que quieras hacerte, así que lo vemos contigo.',
                `Cuéntame aquí mismo qué tienes en mente y alguien de *${quien}* te responde con ` +
                    `precio y fecha para tu ${t.cita}.`,
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: null,
            // El negocio lo ve en la bandeja y contesta a mano: es el mismo camino que cualquier
            // otra cosa que el asistente no sabe hacer (ADR-023). Lo que el cliente escriba
            // ahora —«quiero un dragón en el brazo»— le llega a una persona, no al bot.
            estado: ESTADO_HANDOFF,
            resultado: 'handoff',
            nivel: 'determinista',
        };
    }

    // ── Variante: el largo, el tamaño, la zona ──────────────────────────────────────────

    /**
     * Pregunta cuál de las variantes del servicio quiere.
     *
     * Aquí no hay opción de «me da igual», y es deliberado: a diferencia del profesional, esto
     * no es una preferencia sino un hecho sobre el cliente —su pelo mide lo que mide—. Una
     * opción de azar elegiría por él un precio y una duración equivocados.
     */
    function ofrecerVariantes(ctx, datos, variantes, pasosPrevios) {
        const t = terminos(datos);
        return {
            pasos: [...pasosPrevios, paso('menu_variantes', { cuantas: variantes.length })],
            respuestas: [
                {
                    texto: `Para ese ${t.servicio}, ¿cuál es tu caso?`,
                    opciones: [
                        ...variantes.slice(0, MAX_OPCIONES).map((v) => ({
                            id: String(v.id_variante),
                            etiqueta: v.nombre,
                            detalle: `${v.duracion_min} min${formatearPrecio(v.precio)}`,
                        })),
                        { id: VOLVER.SERVICIO, etiqueta: `← Otro ${t.servicio}` },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    ...datos,
                    paso: PASO.VARIANTE,
                    variantes_ofrecidas: variantes.map((v) => ({ id: v.id_variante, nombre: v.nombre })),
                },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    async function elegirVariante(ctx, datos) {
        const ofrecidas = datos.variantes_ofrecidas || [];
        if (ofrecidas.length === 0) {
            // Sin lista contra la que validar no se resuelve sin adivinar: se rehace el menú.
            return despuesDelServicio(ctx, datos, [paso('menu_repetido', { motivo: 'sin_variantes_ofrecidas' })]);
        }

        const elegida = resolverOpcion(ultimaLinea(ctx.texto), ofrecidas);
        if (!elegida) {
            return reintentar(ctx, datos, 'Elige una de las opciones de la lista, por favor.');
        }
        return despuesDelServicio(
            ctx,
            { ...datos, id_variante: Number(elegida.id), variante_nombre: elegida.nombre },
            [paso('variante_elegida', { id_variante: Number(elegida.id) })],
        );
    }

    // ── Mascota ─────────────────────────────────────────────────────────────────────────

    /**
     * ¿Para cuál de sus mascotas?
     *
     * Quien ya vino las ve como botones: el teléfono del canal identifica al cliente y sus
     * mascotas están registradas. Preguntarle otra vez cómo se llama su perro sería tratarle
     * como a un desconocido teniendo su ficha delante.
     *
     * Quien llega por primera vez escribe el nombre. El tamaño se pregunta **solo si hace
     * falta** —cuando el servicio tiene variantes por tamaño— y no siempre: en un negocio sin
     * variantes, el tamaño no cambia nada y preguntarlo es un paso regalado.
     */
    async function preguntarMascota(ctx, datos, pasosPrevios) {
        const { resultado } = await invocar({ ...ctx, capacidad: 'consultar_mis_mascotas', args: {} });
        const mias = (resultado?.mascotas || []).slice(0, MAX_OPCIONES);

        if (mias.length === 0) {
            return {
                pasos: [...pasosPrevios, paso('mascota_sin_registro')],
                respuestas: ['¿Cómo se llama tu mascota? 🐾'],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.MASCOTA, mascotas_ofrecidas: [] } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        return {
            pasos: [...pasosPrevios, paso('menu_mascotas', { cuantas: mias.length })],
            respuestas: [
                {
                    texto: '¿Para cuál de tus mascotas?',
                    opciones: [
                        ...mias.map((m) => ({
                            id: String(m.id_mascota),
                            etiqueta: m.nombre,
                            detalle: [m.raza, etiquetaTamano(m.tamano)].filter(Boolean).join(' · ') || undefined,
                        })),
                        { id: OTRA_MASCOTA, etiqueta: '+ Otra mascota' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    ...datos,
                    paso: PASO.MASCOTA,
                    mascotas_ofrecidas: mias.map((m) => ({
                        id: m.id_mascota, nombre: m.nombre, tamano: m.tamano || null,
                    })),
                },
            },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    async function elegirMascota(ctx, datos) {
        const texto = ultimaLinea(ctx.texto);
        const ofrecidas = datos.mascotas_ofrecidas || [];
        const t = normalizar(texto);

        // «Otra mascota»: se pregunta el nombre, vaciando la lista para que la próxima vuelta
        // caiga en la rama de texto libre en vez de volver a ofrecer los botones.
        if (t === OTRA_MASCOTA || /\b(otra|otro|nueva|nuevo)\b/.test(t)) {
            return {
                pasos: [paso('mascota_nueva')],
                respuestas: ['¿Cómo se llama? 🐾'],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.MASCOTA, mascotas_ofrecidas: [] } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        const suya = ofrecidas.length ? resolverOpcion(texto, ofrecidas) : null;
        if (suya) {
            return despuesDelServicio(
                ctx,
                {
                    ...datos,
                    id_mascota: Number(suya.id),
                    mascota_nombre: suya.nombre,
                    // El tamaño viene de su ficha, y es lo que después elige la variante sola.
                    mascota_tamano: suya.tamano || null,
                },
                [paso('mascota_elegida', { id_mascota: Number(suya.id) })],
            );
        }

        // Texto libre: es el nombre de una mascota nueva.
        const nombre = String(texto || '').trim();
        if (nombre.length < 2) {
            return reintentar(ctx, datos, '¿Cómo se llama tu mascota?');
        }
        const conMascota = { ...datos, mascota_nombre: nombre.slice(0, 60), id_mascota: null };

        // El tamaño solo se pregunta si de verdad cambia el precio o la duración.
        const servicio = (datos.ofrecidos || []).find((x) => Number(x.id) === Number(datos.id_servicio));
        const porTamano = tiene(datos, 'variantes')
            && (servicio?.variantes || []).some((v) => v.clave && TAMANOS_MASCOTA[v.clave]);
        if (porTamano && !conMascota.mascota_tamano) {
            return {
                pasos: [paso('mascota_pide_tamano', { nombre: conMascota.mascota_nombre })],
                respuestas: [
                    {
                        texto: `¿De qué tamaño es ${conMascota.mascota_nombre}?`,
                        opciones: Object.entries(TAMANOS_MASCOTA).map(([clave, etiqueta]) => ({
                            id: clave, etiqueta,
                        })),
                    },
                ],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...conMascota, paso: PASO.MASCOTA, espera_tamano: true } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        return despuesDelServicio(ctx, conMascota, [paso('mascota_nombre_recibido')]);
    }

    /** La respuesta al tamaño, que llega en el mismo paso pero con `espera_tamano` puesto. */
    async function recibirTamanoMascota(ctx, datos) {
        const t = normalizar(ultimaLinea(ctx.texto));
        const clave = Object.keys(TAMANOS_MASCOTA).find(
            (k) => t === normalizar(k) || t.includes(normalizar(TAMANOS_MASCOTA[k])),
        );
        if (!clave) {
            return reintentar(ctx, datos, 'Dime si es pequeño, mediano, grande o gigante.');
        }
        const { espera_tamano: _espera, ...limpio } = datos;
        return despuesDelServicio(
            ctx,
            { ...limpio, mascota_tamano: clave },
            [paso('mascota_tamano_recibido', { tamano: clave })],
        );
    }

    /**
     * Busca los próximos días que tienen horas libres para lo que se está agendando.
     *
     * Devuelve `null` —y no una lista vacía— cuando **no se pudo saber**: la capacidad falló o
     * no está (un negocio sin habilitar, un doble de pruebas). Son dos cosas muy distintas:
     * con `[]` se sabe que no hay agenda y se le dice al cliente; con `null` no se sabe nada y
     * se vuelve al comportamiento de antes, que es preguntar el día sin prometer que tenga hueco.
     * Confundirlas le diría «no tenemos agenda» a un negocio que la tiene llena de huecos.
     */
    async function buscarDias(ctx, datos, desde) {
        try {
            const { resultado } = await invocar({
                ...ctx,
                capacidad: 'consultar_dias_con_horas',
                args: {
                    id_servicio: datos.id_servicio,
                    ...(desde ? { desde } : {}),
                    ...(datos.id_profesional_preferido ? { id_profesional: datos.id_profesional_preferido } : {}),
                    ...(datos.id_variante ? { id_variante: datos.id_variante } : {}),
                    cuantos: 3,
                },
            });
            return Array.isArray(resultado?.dias) ? resultado : null;
        } catch {
            // Ya quedó en el Ledger (lo hace `invocar`). Aquí solo se degrada.
            return null;
        }
    }

    /** Un día con horas, como botón: «viernes 2» y debajo «desde las 09:00». */
    function chipDeDia(d) {
        return {
            id: d.fecha,
            etiqueta: etiquetaDia(d.fecha),
            detalle: d.primera_hora ? `Desde las ${d.primera_hora}` : undefined,
        };
    }

    /**
     * No hay agenda en las próximas semanas.
     *
     * Lo que NO se hace es lo que se hacía: proponer el día siguiente a ciegas, una y otra vez.
     * Si eligió a alguien concreto, se le ofrece cambiar de persona —puede que otra sí tenga
     * hueco—. Si no, se le dice la verdad y se avisa al negocio: que no haya agenda en tres
     * semanas casi siempre es un horario sin configurar, y eso lo tiene que ver una persona.
     */
    function sinAgenda(ctx, datos, pasosPrevios) {
        const t = terminos(datos);
        const quien = ctx.negocio?.tratamiento || 'el negocio';

        if (datos.id_profesional_preferido) {
            return {
                pasos: [...pasosPrevios, paso('sin_agenda', { con_profesional: true })],
                respuestas: [
                    {
                        texto: 'Con quien elegiste no hay horas libres en las próximas tres semanas. ' +
                            '¿Probamos con otra persona?',
                        opciones: [
                            { id: VOLVER.PROFESIONAL, etiqueta: '← Con otra persona' },
                            { id: VOLVER.SERVICIO, etiqueta: `← Otro ${t.servicio}` },
                        ],
                    },
                ],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        return {
            pasos: [...pasosPrevios, paso('sin_agenda', { con_profesional: false })],
            respuestas: [
                `Por ahora no veo horas libres para ese ${t.servicio} en las próximas tres semanas. 😕`,
                `Ya le aviso a *${quien}* para que te escriba y te busque un espacio.`,
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: null,
            // A la bandeja: el negocio tiene que enterarse, porque esto casi nunca es una agenda
            // llena de verdad sino un horario que nadie configuró.
            estado: ESTADO_HANDOFF,
            resultado: 'handoff',
            nivel: 'determinista',
        };
    }

    /**
     * El paso de fecha, que es a donde se llega con o sin elegir profesional.
     *
     * Desde el 2026-09-29 **no se ofrece ningún día sin haber comprobado que tiene horas**. Antes
     * los botones eran «Hoy» y «Mañana» a ciegas, y un cliente de D'ALEX pulsó «Mañana», oyó
     * «no hay horas», y el bot le fue proponiendo el día siguiente cuatro veces seguidas sin
     * encontrar nada. Ahora los botones SON los próximos días con hueco, con su primera hora.
     */
    async function pedirFecha(ctx, datos, pasosPrevios) {
        const busqueda = await buscarDias(ctx, datos, null);
        if (busqueda && busqueda.dias.length === 0) return sinAgenda(ctx, datos, pasosPrevios);

        const respuesta = busqueda
            ? {
                  texto: '¿Qué día te queda bien? Estos son los próximos con horas libres ' +
                      '(también puedes escribirme otra fecha):',
                  opciones: busqueda.dias.map(chipDeDia),
              }
            : {
                  texto: '¿Para qué día? Puedes decirme "hoy", "mañana" o una fecha (2026-08-20).',
                  opciones: [
                      { id: 'hoy', etiqueta: 'Hoy' },
                      { id: 'mañana', etiqueta: 'Mañana' },
                  ],
              };

        return {
            pasos: [...pasosPrevios, ...(busqueda ? [paso('dias_con_horas', { cuantos: busqueda.dias.length })] : [])],
            respuestas: [respuesta],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: TAREA_AGENDAR, datos: { ...datos, paso: PASO.FECHA } },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    /**
     * Ofrece con quién, **entre quienes tienen libre la hora elegida** — y se salta el paso
     * cuando preguntar no aporta nada.
     *
     * ## Por qué va después de la hora (2026-09-29)
     *
     * Antes se preguntaba la persona primero y después el día, y era frecuente elegir a alguien
     * que no tenía hueco cuando el cliente podía venir: vuelta atrás y a empezar. Ahora el
     * cliente dice cuándo y el menú solo trae a quien puede atenderle en ese momento, así que
     * cualquier opción que pulse termina en cita.
     *
     * ## Las dos decisiones que hacen que esto no estorbe
     *
     * **1. «Me da igual» va primero.** La mayoría de la gente no tiene preferencia, y para esa
     * mayoría la opción más a mano es la que equivale a no elegir.
     *
     * **2. Con una sola persona libre NO se pregunta.** Ofrecer un menú de una opción es pedirle
     * a alguien que confirme lo inevitable: se aparta directamente con ella y el resumen dice
     * con quién es.
     *
     * Aparta la hora en el mismo turno cuando no hay nada que preguntar. Son dos capacidades
     * distintas (`consultar_profesionales` y `proponer_turno`), así que la regla de «cada
     * capacidad una vez por turno» se cumple.
     */
    async function ofrecerProfesionales(ctx, datos, pasosPrevios) {
        const libres = (datos.libres_por_hora?.[datos.hora] || []).map(Number);
        const porDefecto = datos.profesional_por_hora?.[datos.hora] ?? libres[0] ?? null;

        if (libres.length <= 1) {
            return apartarHora(ctx, { ...datos, id_profesional: porDefecto }, datos.nombre, [
                ...pasosPrevios,
                paso('profesional_no_se_pregunta', { cuantos: libres.length }),
            ]);
        }

        const { resultado } = await invocar({
            ...ctx,
            capacidad: 'consultar_profesionales',
            args: { id_servicio: datos.id_servicio },
        });
        const conocidos = new Map((resultado?.profesionales || []).map((pr) => [Number(pr.id_profesional), pr]));
        const profesionales = libres
            .map((id) => conocidos.get(id))
            .filter(Boolean)
            .slice(0, MAX_OPCIONES);

        if (profesionales.length <= 1) {
            return apartarHora(
                ctx,
                { ...datos, id_profesional: profesionales[0]?.id_profesional ?? porDefecto },
                datos.nombre,
                [...pasosPrevios, paso('profesional_no_se_pregunta', { cuantos: profesionales.length })],
            );
        }

        const t = terminos(datos);
        return {
            pasos: [...pasosPrevios, paso('menu_profesionales', { cuantos: profesionales.length })],
            respuestas: [
                {
                    texto: `¿Con quién prefieres tu ${t.cita} del ${fechaLegible(datos.fecha)} a las ${datos.hora}?`,
                    // Me da igual + 8 personas + «Otra hora» = 10 filas, el máximo de una lista.
                    opciones: [
                        { id: CUALQUIER_PROFESIONAL, etiqueta: 'Me da igual', detalle: 'Cualquiera con esa hora libre' },
                        ...profesionales.map((pr) => ({
                            id: String(pr.id_profesional),
                            etiqueta: pr.nombre,
                            detalle: pr.especialidad || undefined,
                        })),
                        { id: VOLVER.HORA, etiqueta: '← Otra hora' },
                    ],
                },
            ],
            // El nombre se guarda ya: si la conversación se corta aquí, la próxima vez no se
            // vuelve a preguntar.
            variables: conMemoria(ctx.conversacion, datos.nombre ? { nombre: datos.nombre } : {}),
            tarea: {
                nombre: TAREA_AGENDAR,
                datos: {
                    ...datos,
                    paso: PASO.PROFESIONAL,
                    // Misma razón que con los servicios: se recuerda lo ofrecido para resolver
                    // la respuesta contra la lista real en vez de sacar un número del texto.
                    profesionales_ofrecidos: profesionales.map((pr) => ({
                        id: Number(pr.id_profesional),
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
            case PASO.CATEGORIA:
                // Sin `categoria`: es lo que hace que se vuelva a preguntar el tipo. En un
                // negocio sin categorías acaba en la lista de servicios, que es lo correcto.
                return ofrecerServicios(ctx, rastro);
            case PASO.SERVICIO:
                // Los servicios del MISMO tipo que ya había elegido.
                return ofrecerServicios(ctx, rastro, { categoria: podados.categoria });
            case PASO.PROFESIONAL:
                // Otra persona para el mismo día y hora. Sin hora guardada (se venía de más
                // atrás) no hay a quién ofrecer todavía: se sigue por el día.
                return podados.hora && podados.fecha
                    ? ofrecerProfesionales(ctx, podados, rastro)
                    : despuesDelServicio(ctx, podados, rastro);
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
            return datos.hora
                ? ofrecerProfesionales(ctx, datos, [paso('menu_repetido', { motivo: 'sin_profesionales_ofrecidos' })])
                : pedirFecha(ctx, datos, [paso('menu_repetido', { motivo: 'sin_profesionales_ofrecidos' })]);
        }

        const elegido = resolverProfesional(ultimaLinea(ctx.texto), datos.profesionales_ofrecidos);
        if (elegido === undefined) {
            return reintentar(ctx, datos, 'Dime con quién prefieres, o "me da igual".');
        }

        // Una tarea abierta con el orden anterior (profesional antes que el día) no tiene hora
        // todavía: se sigue como entonces, con la persona como filtro de los días.
        if (!datos.hora) {
            return pedirFecha(
                ctx,
                { ...datos, id_profesional_preferido: elegido },
                [paso('profesional_elegido', { id_profesional: elegido })],
            );
        }

        // «Me da igual» es quien ofreció la hora; si no, la persona elegida, que está libre a
        // esa hora porque la lista solo traía a quien lo estaba.
        const idProfesional = elegido ?? datos.profesional_por_hora?.[datos.hora] ?? null;
        return apartarHora(ctx, { ...datos, id_profesional: idProfesional }, datos.nombre, [
            paso('profesional_elegido', { id_profesional: elegido }),
        ]);
    }

    async function elegirFecha(ctx, datos) {
        const fecha = interpretarFecha(ultimaLinea(ctx.texto), ahora());
        if (!fecha) {
            return reintentar(ctx, datos, 'No entendí el día. Puedes decirme "mañana", "el viernes" o "el 15".');
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
                // La variante ya elegida: las horas tienen que medirse con la duración REAL,
                // no con la de lista, o se ofrecen huecos donde la cita no cabe.
                ...(datos.id_variante ? { id_variante: datos.id_variante } : {}),
            },
        });
        const horas = (resultado?.horas || []).slice(0, MAX_OPCIONES);

        if (horas.length === 0) {
            // ⚠️ Se buscan los próximos días CON horas, no el siguiente a ciegas (2026-09-29).
            //
            // Antes esto ofrecía el día siguiente al consultado sin mirarlo. En producción, en
            // D'ALEX, un cliente encadenó «no hay horas el 29 → ¿el 30? → no hay → ¿el 1?…»
            // cuatro veces y se fue sin cita. La nota que había aquí ya lo decía: sondear varios
            // días exigía otra capacidad, no otro parche. Ésa es `consultar_dias_con_horas`.
            const busqueda = await buscarDias(ctx, datos, diaSiguiente(fecha));
            if (busqueda && busqueda.dias.length === 0) {
                return sinAgenda(ctx, datos, [...pasosPrevios, paso('sin_disponibilidad', { fecha })]);
            }

            const siguiente = diaSiguiente(fecha);
            const conQuien = datos.id_profesional_preferido ? ' con quien elegiste' : '';
            return {
                pasos: [...pasosPrevios, paso('sin_disponibilidad', { fecha })],
                respuestas: [
                    {
                        texto: busqueda
                            ? `El ${fechaLegible(fecha)} no hay horas libres${conQuien}. ` +
                              'Estos son los días más próximos que sí tienen:'
                            : `No hay horas libres el ${fechaLegible(fecha)}${conQuien}. ` +
                              `¿Probamos el ${fechaLegible(siguiente)}?`,
                        opciones: [
                            ...(busqueda
                                ? busqueda.dias.map(chipDeDia)
                                : [{ id: siguiente, etiqueta: etiquetaDia(siguiente) }]),
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
        // Y TODOS los que la tienen libre: el profesional se elige después de la hora, y solo
        // se ofrece a quien de verdad puede atender a esa hora. Un adaptador anterior que no
        // mande la lista deja al primero, que es lo que se sabía.
        const libresPorHora = Object.fromEntries(horas.map((h) => [
            h.hora,
            Array.isArray(h.id_profesionales) && h.id_profesionales.length
                ? h.id_profesionales
                : [h.id_profesional].filter((x) => x != null),
        ]));

        return {
            pasos: [...pasosPrevios, paso('menu_horas', { fecha, cuantas: horas.length })],
            respuestas: [
                {
                    texto: `Estas son las horas libres el ${fechaLegible(fecha)}:`,
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
                datos: {
                    ...datos,
                    paso: PASO.HORA,
                    fecha,
                    profesional_por_hora: profesionalPorHora,
                    libres_por_hora: libresPorHora,
                },
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

        // El nombre solo se pregunta la primera vez: después sale de la memoria de la
        // conversación o de la ficha del cliente (`identidad.resolver`).
        if (!ctx.identidad.nombre) {
            return {
                pasos: [paso('hora_elegida', { hora: hora[0], pide_nombre: true })],
                respuestas: [`¿A nombre de quién agendo la ${terminos(datos).cita}?`],
                variables: conMemoria(ctx.conversacion),
                tarea: { nombre: TAREA_AGENDAR, datos: { ...conHora, paso: PASO.NOMBRE } },
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }
        return ofrecerProfesionales(ctx, { ...conHora, nombre: ctx.identidad.nombre }, [
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
            return reintentar(
                ctx, datos,
                `Necesito un nombre para la ${terminos(datos).cita}. ¿Cómo te llamas?`,
            );
        }
        return ofrecerProfesionales(ctx, { ...datos, nombre }, [paso('nombre_recibido')]);
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
                // La variante va AL APARTAR, no al confirmar: es lo que decide cuánto dura el
                // hueco. Sin ella se apartaban 40 minutos para una cita de 90.
                ...(datos.id_variante ? { id_variante: datos.id_variante } : {}),
            },
        });

        const t = terminos(datos);
        const mayuscula = (x) => x.charAt(0).toLocaleUpperCase('es') + x.slice(1);
        // Todo lo que se va a agendar, una línea por dato, para que el cliente lo revise de un
        // vistazo antes de decir que sí. La negrita es la de WhatsApp: UN asterisco.
        const lineas = [
            // La variante junto al servicio: «Coloración (pelo largo)». Sin esto el cliente lee
            // el nombre del servicio a secas y no puede comprobar que se entendió su caso.
            `• *${mayuscula(t.servicio)}:* ${resultado.servicio}${resultado.variante ? ` (${resultado.variante})` : ''}`,
            datos.mascota_nombre ? `• *Mascota:* ${datos.mascota_nombre}` : null,
            resultado.profesional ? `• *${mayuscula(t.profesional)}:* ${resultado.profesional}` : null,
            `• *Día:* ${fechaLegible(datos.fecha)}`,
            `• *Hora:* ${datos.hora}`,
            resultado.duracion_min ? `• *Duración:* ${resultado.duracion_min} min` : null,
            resultado.precio != null ? `• *Precio:* $${Number(resultado.precio).toLocaleString('es-CO')}` : null,
            nombre ? `• *A nombre de:* ${nombre}` : null,
        ].filter(Boolean);

        // El consentimiento no se firma por chat: se avisa para que venga preparado. Callarlo y
        // que se entere en el mostrador es lo que convierte una cita en una discusión.
        const avisos = resultado.requiere_consentimiento
            ? ['Antes de empezar firmarás un consentimiento, así que trae tu documento.']
            : [];

        return {
            pasos: [...pasosPrevios, paso('hora_apartada', { codigo_hold: resultado.codigo_hold })],
            respuestas: [
                ...avisos,
                {
                    texto: [
                        `Estos son los datos de tu ${t.cita}:`,
                        '',
                        ...lineas,
                        '',
                        `¿Confirmas la ${t.cita}?`,
                    ].join('\n'),
                    // Dos botones y nada más: la decisión es sí o no. El «no» lleva de vuelta a
                    // las horas de ese día (ver `confirmar`), desde donde se puede cambiar todo.
                    opciones: [
                        { id: 'si', etiqueta: 'Sí' },
                        { id: 'no', etiqueta: 'No' },
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
            return reintentar(ctx, datos, `¿Confirmo la ${terminos(datos).cita}? Respóndeme sí o no.`);
        }

        try {
            const { resultado } = await invocar({
                ...ctx,
                capacidad: 'reservar_turno',
                args: {
                    codigo_hold: datos.codigo_hold,
                    cliente_nombre: datos.nombre,
                    cliente_telefono: ctx.identidad.telefono || undefined,
                    // La mascota. Va al confirmar y no al apartar porque no cambia el hueco;
                    // sin ella la vertical rechaza la cita con `MASCOTA_REQUERIDA` — que es lo
                    // que hacía que una peluquería canina no pudiera agendar nada por WhatsApp.
                    ...(datos.id_mascota ? { id_mascota: datos.id_mascota } : {}),
                    ...(!datos.id_mascota && datos.mascota_nombre
                        ? {
                              mascota_nombre: datos.mascota_nombre,
                              ...(datos.mascota_tamano ? { mascota_tamano: datos.mascota_tamano } : {}),
                          }
                        : {}),
                },
                // Éste es el sí: el texto que acaba de pasar por `COMANDO.SI` dos líneas arriba.
                confirmadoPor: { idTurno: ctx.turno?.id_turno, texto: ctx.texto },
            });

            return {
                pasos: [paso('cita_creada', { codigo_cita: resultado.codigo_cita })],
                respuestas: [
                    `¡Listo! Tu ${terminos(datos).cita} quedó agendada para el ${fechaLegible(datos.fecha)} a las ${datos.hora}. ` +
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
                            opciones: [{ id: datos.fecha, etiqueta: `Ver el ${etiquetaDia(datos.fecha)}` }],
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
            return reintentar(
                ctx, datos,
                `Seguimos donde lo dejamos. ${textoDelPaso(datos.paso, terminos(datos))}`,
            );
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
            case PASO.CATEGORIA:
                return conRastro(await elegirCategoria(ctx, datos));
            case PASO.SERVICIO:
                return conRastro(await elegirServicio(ctx, datos));
            case PASO.VARIANTE:
                return conRastro(await elegirVariante(ctx, datos));
            case PASO.MASCOTA:
                // Dos preguntas caen en el mismo paso —el nombre y el tamaño— porque son la
                // misma decisión partida en dos mensajes. `espera_tamano` dice en cuál va.
                return conRastro(
                    datos.espera_tamano
                        ? await recibirTamanoMascota(ctx, datos)
                        : await elegirMascota(ctx, datos)
                );
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

function textoDelPaso(pasoActual, t = TERMINOS_POR_DEFECTO_MINUSCULA) {
    switch (pasoActual) {
        case PASO.CATEGORIA:
            return `Elige el tipo de ${t.servicio} de la lista.`;
        case PASO.SERVICIO:
            return `Elige el ${t.servicio} de la lista.`;
        case PASO.VARIANTE:
            return 'Elige una de las opciones de la lista.';
        case PASO.MASCOTA:
            return '¿Para cuál de tus mascotas?';
        case PASO.PROFESIONAL:
            return '¿Con quién prefieres? También puedes decir "me da igual".';
        case PASO.FECHA:
            return '¿Para qué día lo quieres?';
        case PASO.HORA:
            return 'Elige una de las horas libres.';
        case PASO.NOMBRE:
            return `¿A nombre de quién agendo la ${t.cita}?`;
        case PASO.CONFIRMAR:
            return `¿Confirmo la ${t.cita}?`;
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
