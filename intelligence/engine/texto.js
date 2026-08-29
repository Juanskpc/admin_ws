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

module.exports = { COMANDO, normalizar, ultimaLinea, esComando, saludoPorLaHora };
