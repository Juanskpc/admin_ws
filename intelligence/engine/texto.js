/**
 * Lo poco que hace falta para leer lo que escribió una persona (Nivel 1).
 *
 * Vivía dentro de `manejadorDeterminista.js`, y salió de ahí cuando F7 trajo un segundo
 * consumidor: la confirmación de una mutación también tiene que entender un «sí», y también
 * tiene que quedarse con la última línea de una ráfaga. Copiarlo habría sido peor que moverlo —
 * dos lecturas distintas de «sí» es un bot que confirma en un sitio y repregunta en el otro.
 *
 * Deliberadamente pobre: aquí no se entiende lenguaje, se reconocen palabras exactas. Entender
 * es trabajo del Nivel 4, y fingirlo con expresiones regulares produce el peor de los mundos —
 * un parser que acierta lo justo para que nadie note cuándo falla.
 */
'use strict';

/** Palabras que valen en cualquier paso. Son pocas a propósito: cada una hay que probarla. */
const COMANDO = {
    /**
     * Reabren la bienvenida.
     *
     * ⚠️ **Los saludos entraron el 2026-08-29, y su ausencia era un fallo visible.** Aquí solo
     * estaba «hola», así que quien escribía «buenos días» —que es como saluda media Colombia—
     * no casaba con nada y caía al modelo. El modelo contestaba un saludo perfectamente
     * plausible **y sin el enlace del menú**, que es lo único que ese primer mensaje tiene que
     * hacer. Parecía una versión vieja del bot; era la IA improvisando.
     *
     * No se vio antes porque en el primer mensaje de una conversación cualquier texto abre la
     * bienvenida: solo falla con quien ya había hablado alguna vez.
     *
     * Van sueltos y no como expresión regular a propósito: «buenos días, ¿están abiertos?» NO
     * debe reiniciar nada — eso es una pregunta, y la contesta el modelo con el hilo en la mano.
     */
    MENU: [
        'menu', 'menú', 'inicio', 'empezar',
        'hola', 'holi', 'hey', 'buenas',
        'buenos dias', 'buenos días', 'buen dia', 'buen día',
        'buenas tardes', 'buenas noches',
    ],
    CANCELAR: ['cancelar', 'salir', 'olvidalo', 'olvídalo', 'nada'],
    SEGUIMOS: ['seguimos', 'continuar', 'sigamos', 'retomar'],
    SI: ['si', 'sí', 'confirmo', 'dale', 'ok', 'vale', 'listo'],
    NO: ['no', 'otra', 'cambiar'],
};

function normalizar(texto) {
    return String(texto || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

/**
 * La última línea no vacía del texto agrupado.
 *
 * El debounce junta la ráfaga en **un** turno, así que aquí no llega «sí» sino «sí\nsí\nsí»,
 * y comparar el bloque entero contra «sí» no casa: el bot repreguntaba y la cita no se creaba.
 * Lo cazó el test de ráfaga en el paso de confirmar, que es exactamente para lo que está.
 *
 * Se toma la **última** y no «alguna»: dentro de un turno, lo último que dijo la persona es su
 * intención actual. Con «alguna» valdría, un «cancelar… no, espera, sigue» cancelaría.
 */
function ultimaLinea(texto) {
    const lineas = String(texto || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    return lineas[lineas.length - 1] ?? '';
}

/**
 * Signos que rodean a un comando sin cambiarlo. Se quitan **solo aquí**, no en `normalizar()`:
 * esa la usan también expresiones regulares de los flujos, y cambiarla movería cosas que hoy
 * funcionan. «¡Hola!», «buenas.» y «ok!» son el mismo comando que sin adornos, y hasta hoy no
 * casaban con ninguno.
 */
const ADORNOS = /^[¡¿!?.,;:\s]+|[!?.,;:\s]+$/g;

function esComando(texto, lista) {
    const t = normalizar(ultimaLinea(texto)).replace(ADORNOS, '');
    return lista.some((palabra) => t === normalizar(palabra).replace(ADORNOS, ''));
}

/**
 * Palabras que acompañan a un «sí» sin cambiarlo: vocativos y cortesías.
 *
 * Producción, 2026-10-01 (Zona Burger): «Si Veci» no se leyó como sí y el bot repreguntó. En
 * Colombia el «sí» casi nunca va solo: «sí veci», «sí porfa», «sí señor, gracias», «siii».
 */
const PALABRA_DE_SI = /^(s+i+|si+p+|confirmo|confirmado|dale|ok+|okey|vale|listo|claro|perfecto|correcto|exacto|eso|de|una|asi|es)$/;
const CORTESIA = /^(veci|vecin[oa]|vecinit[oa]|porfa|porfis|por|favor|senor|senora|seno|sr|sra|mi|amor|reina|rey|amig[oa]|gracias|muchas|mil|please|pls|y|todo|bien|ya)$/;

/**
 * ¿Es un «sí», aunque venga adornado? La primera palabra tiene que ser de afirmar y TODAS las
 * demás, de afirmar o de cortesía: «sí, pero sin cebolla» NO es un sí limpio — trae un cambio.
 */
function esAfirmacion(texto) {
    if (esComando(texto, COMANDO.SI)) return true;
    const palabras = normalizar(ultimaLinea(texto))
        .replace(/[^a-zñ\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    if (palabras.length === 0 || palabras.length > 6) return false;
    if (!PALABRA_DE_SI.test(palabras[0])) return false;
    return palabras.every((p) => PALABRA_DE_SI.test(p) || CORTESIA.test(p));
}

/**
 * Palabras con las que se REPITE cómo se entrega el pedido que se está confirmando: «sí para
 * recoger», «dale, a mi casa», «sí, para servir aquí». No cambian nada —el resumen ya lo dice—,
 * solo lo reafirman.
 *
 * Producción, 2026-10-02 (Zona Burger): «Si para recoger» se leyó como un añadido, se anotó en la
 * nota del pedido («Nota: Si para recoger») y se volvió a preguntar lo mismo. Cada pregunta de
 * más es un mensaje que se paga y un cliente que duda de que el bot lo haya entendido.
 *
 * Van por tipo de entrega a propósito: «sí para domicilio» sobre un pedido para RECOGER es un
 * cambio, no una confirmación, y tiene que seguir yendo a la nota.
 */
const NEUTRAS_DE_ENTREGA = /^(para|a|en|el|la|lo|mi|pedido|esta|estan|bien|asi|ahi|ya|mismo|todo|ese|eso|que|es)$/;
const ENTREGA_DE_PEDIDO = {
    LLEVAR: /^(local|recoger|recojo|recogerlo|recogerla|recoge|llevar|llevo|llevarlo|paso|pasar|pasarlo|pasare|buscar|buscarlo|busco|voy|alla)$/,
    DOMICILIO: /^(domicilio|casa|envien|enviar|enviarlo|envio|mandar|mandarlo|manden|traer|traigan|trae|traelo|direccion)$/,
    MESA: /^(servir|servirlo|aqui|comer|mesa|local|consumir|sentado|sentada|voy|camino|alla)$/,
};

/**
 * ¿Es un «sí» a un pedido, aunque repita cómo se entrega? Igual que `esAfirmacion`, y además
 * acepta «sí para recoger» cuando eso es justo lo que el resumen dice (`tipoEntrega`). Sin saber
 * el tipo (una capacidad que no lo trae) vale cualquiera de los tres.
 */
function esAfirmacionConEntrega(texto, tipoEntrega) {
    if (esAfirmacion(texto)) return true;
    const palabras = normalizar(ultimaLinea(texto))
        .replace(/[^a-zñ\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    if (palabras.length < 2 || palabras.length > 8) return false;
    if (!PALABRA_DE_SI.test(palabras[0])) return false;
    const propias = ENTREGA_DE_PEDIDO[tipoEntrega];
    return palabras.every(
        (p) =>
            PALABRA_DE_SI.test(p) ||
            CORTESIA.test(p) ||
            NEUTRAS_DE_ENTREGA.test(p) ||
            (propias ? propias.test(p) : Object.values(ENTREGA_DE_PEDIDO).some((r) => r.test(p)))
    );
}

/** ¿Es alguno de los comandos conocidos, cualquiera que sea? */
function esAlgunComando(texto) {
    return Object.values(COMANDO).some((lista) => esComando(texto, lista));
}

/**
 * ¿Este mensaje puede ser la PRIMERA parte de algo que el cliente sigue escribiendo?
 *
 * WhatsApp no avisa de que alguien está escribiendo, así que se adivina por la forma: lo que ya
 * está completo se contesta enseguida —un comando, un sí o un no, el toque de un botón, el pedido
 * que arma la carta digital (`#P6-…`), una foto, un saludo— y el texto libre espera un poco más
 * (`cola.js`, `debounceTextoMs`) por si llega el resto.
 */
function puedeSeguirEscribiendo(texto) {
    const crudo = String(texto || '').trim();
    if (!crudo) return false;
    if (esAlgunComando(crudo) || esAfirmacion(crudo) || esSaludo(crudo)) return false;
    if (/#p\d+-/i.test(crudo)) return false; // el pedido de la carta digital llega entero
    if (/^\[[a-z_]+\]$/i.test(crudo)) return false; // [image], [audio]…
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(crudo)) return false; // el id de un botón
    if (/^[\d\s+.-]{7,}$/.test(crudo)) return false; // un teléfono suelto: es el dato que se le pidió
    return true;
}

/**
 * Un saludo, escrito como lo escribe la gente.
 *
 * ## Por qué no basta con la lista de `COMANDO.MENU`
 *
 * Porque esa lista se compara **exacta**, y en la vida real un saludo llega con un signo detrás,
 * una vocal de más o dos palabras juntas: «Buenas!», «holaa», «hola buenas», «buens». Cada una
 * de ésas caía fuera de la lista, se iba al modelo, y el cliente recibía una respuesta
 * plausible **sin el enlace del menú** — que es lo único que ese primer mensaje tiene que hacer.
 * Parecía una versión vieja del bot; era la IA improvisando. Visto en producción el 2026-09-07.
 *
 * ## La regla: el mensaje ENTERO tiene que ser saludo
 *
 * No «contiene un saludo», que es la trampa. «Buenos días, ¿están abiertos?» empieza igual y
 * **no** es un saludo: es una pregunta, y contestarla con la bienvenida sería ignorarla. Así que
 * se parten las palabras y se exige que **todas** sean de saludar. En cuanto aparece una que no
 * lo es, esto devuelve `false` y el turno sigue su camino hacia quien pueda contestarla.
 *
 * Las repeticiones de letra se admiten a propósito (`h+o+l+a+`): «holaaa» y «buenaas» son la
 * forma normal de escribir en un chat, no una falta que haya que castigar con un menú equivocado.
 *
 * `dice` se sumó el 2026-09-22: sin ella, «qué dice» —un saludo colombiano tan corriente como
 * «qué más» o «qué tal», que ya estaban— no se reconocía como saludo por la sola palabra «dice»,
 * y el mensaje se iba al modelo en vez de abrir la bienvenida.
 */
const PALABRA_DE_SALUDO =
    /^(?:h+o+l+a*s?|o+l+a+s?|h+o+l+i+s?|b+u+e+n+[oa]*s?|d+i+a+s?|t+a+r+d+e+s?|n+o+c+h+e+s?|h+e+y+|e+y+|epa|ola|alo+|hi|hello|saludo?s?|que|q|k|mas|tal|dice|buenass?|veci|vecin[oa]s?|vecinit[oa]s?|amig[oa]s?|senor|senora|senorita|sr|sra|caballero|joven|parce|como|esta|estas|estan|muy)$/;

/** Palabras que acompañan a un saludo pero solas no lo son: «veci», «amiga», «cómo está». */
const SOLO_ACOMPANA =
    /^(?:veci|vecin[oa]s?|vecinit[oa]s?|amig[oa]s?|senor|senora|senorita|sr|sra|caballero|joven|parce|como|esta|estas|estan|muy)$/;

function esSaludo(texto) {
    const palabras = normalizar(ultimaLinea(texto))
        // Se quitan signos y emoji: un «hola 👋» es un saludo, y el emoji no es una palabra.
        .replace(/[^a-zñ\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

    // Un saludo es corto. El tope no es estético: sin él, una frase larga hecha solo de
    // muletillas reconocidas acabaría abriendo la bienvenida en medio de una conversación.
    //
    // Seis y no cuatro desde el 2026-10-05: «Hola buenas noches veci, ¿cómo está?» es un saludo
    // y se iba al modelo, que contestaba «¡Muy bien, gracias!» sin la carta. Con los vocativos
    // («veci», «amiga», «señor») y el «¿cómo está?» pasa igual que con el resto: todas las
    // palabras tienen que ser de saludar, y solo de vocativos no hay saludo («veci» a secas).
    if (palabras.length === 0 || palabras.length > 6) return false;
    if (!palabras.every((p) => PALABRA_DE_SALUDO.test(p))) return false;
    return palabras.some((p) => !SOLO_ACOMPANA.test(p));
}

/**
 * «¡Buenos días!» / «¡Buenas tardes!» / «¡Buenas noches!», en la hora del NEGOCIO.
 *
 * Vive aquí y no en un flujo porque no es conocimiento de dominio —un restaurante y una barbería
 * saludan igual— y porque tenerlo dos veces sería tener dos relojes: el día que alguien mueva el
 * corte de la tarde en uno, el otro se queda como estaba.
 *
 * ⚠️ Se calcula con `Intl` y **no** con `getHours()` ni pasando por `toISOString()`. El proceso
 * corre en UTC en el VPS, así que `getHours()` daría «buenas noches» a las seis de la tarde en
 * Bogotá — y un saludo desfasado cinco horas es exactamente la clase de detalle que delata a un
 * bot. Es la misma trampa que ya se pagó con las fechas (ESTADO-Y-CONTINUACION §8).
 */
function saludoPorLaHora(ahora = new Date(), zona = 'America/Bogota') {
    const hora = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', hour12: false }).format(
            ahora
        )
    );
    if (hora < 12) return '¡Buenos días!';
    if (hora < 19) return '¡Buenas tardes!';
    return '¡Buenas noches!';
}

module.exports = {
    COMANDO,
    normalizar,
    ultimaLinea,
    esComando,
    esAlgunComando,
    puedeSeguirEscribiendo,
    esAfirmacion,
    esAfirmacionConEntrega,
    esSaludo,
    saludoPorLaHora,
};
