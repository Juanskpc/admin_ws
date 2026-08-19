/**
 * Guardarraíl de promesas — que el asistente no comprometa al negocio con cifras inventadas.
 *
 * Es la mitad difícil de [ADR-023](../../docs/adr/ADR-023-guardarrailes.md). El hueco que tapa no
 * es de datos: *«Claro, te hago un 20% de descuento por cliente frecuente.»* No ejecuta ninguna
 * capacidad, no corrompe nada, el Policy Gate impecable — y mañana llega un cliente con esa
 * promesa por escrito de un agente que hablaba en nombre del negocio. Protegemos la base de datos;
 * esto protege **la palabra del negocio**, que es literalmente lo que se vende.
 *
 * ## Por qué no es una lista de palabras prohibidas
 *
 * Porque se midió y no funciona. El 2026-08-18, con el modelo real, el caso `i12` del arnés falló
 * por decir «gratis»… dentro de *«**No puedo confirmar** sesiones gratis»*. La misma palabra
 * aparece en la promesa y en el rechazo, así que una lista negra castiga justo la conducta que se
 * quiere. Y las instrucciones en el prompt tampoco valen: se eluden, y ADR-023 pide una defensa
 * **estructural**.
 *
 * ## Lo que sí se comprueba: que las cifras tengan de dónde salir
 *
 * ADR-023 da el criterio y es verificable: un compromiso es sospechoso cuando **no está respaldado
 * por el resultado de una capacidad ejecutada en ese turno**. Así que en vez de interpretar
 * lenguaje, esto compara **números**:
 *
 * 1. Se sacan las cifras de lo que el asistente va a decir (precios, porcentajes, horas, plazos).
 * 2. Se sacan las cifras de lo que el sistema *sabe*: los resultados de las capacidades de ese
 *    turno, el contexto del negocio, y **lo que dijo el propio cliente** —repetirle su fecha no es
 *    prometer nada—.
 * 3. Lo que aparece en (1) y no en (2) es una cifra que nadie respalda.
 *
 * Un modelo puede desobedecer una instrucción; no puede hacer que un 20 aparezca en un resultado
 * que no lo trae.
 *
 * ## Lo que esta versión NO cubre, dicho en voz alta
 *
 * - **Promesas sin número.** «Te lo dejamos gratis», «te lo guardo hasta mañana». No hay cifra que
 *   contrastar, y el intento de cazarlas por palabras es exactamente lo que se descartó arriba.
 * - **Cifras que el propio bot dijo antes en la conversación.** No cuentan como respaldo a
 *   propósito: si las inventó en el turno anterior, aceptarlas ahora sería blanquear la mentira.
 *   El precio de esto es ruido cuando el bot repite un precio legítimo sin volver a consultarlo, y
 *   es justo uno de los números que el modo observación existe para medir.
 *
 * ## Arranca sin bloquear nada, como F2
 *
 * `PROMESAS_MODO=observacion` (por defecto) registra y **deja pasar**. `bloqueo` escala a un
 * humano en vez de decir la frase. Es el mismo procedimiento que se siguió con la autorización
 * multi-inquilino, y por el mismo motivo: un guardarraíl que bloquea el primer día con reglas sin
 * medir rompe conversaciones legítimas, y nadie sabe cuántas hasta que mira. **Medir una semana
 * antes de encender `bloqueo`.**
 */
'use strict';

const MODO = (process.env.PROMESAS_MODO || 'observacion').toLowerCase();

/**
 * Números que no comprometen a nadie y solo harían ruido.
 *
 * Son los que aparecen al enumerar opciones («1) Corte  2) Tinte») y en el año en curso. Dejarlos
 * dentro llenaría la medición de falsos positivos y enterraría los que importan.
 */
const IRRELEVANTES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/**
 * Las lecturas posibles de una cifra escrita, como **alternativas** y no como números distintos.
 *
 * Aquí se pagó un falso positivo bonito: «$35.000» producía `35000` **y** `35`, y ese `35` no lo
 * respaldaba nadie, así que un precio legítimo salía marcado como promesa inventada. El error de
 * fondo era tratar las interpretaciones de un mismo token como si fueran cifras separadas.
 *
 * `35.000` puede leerse como treinta y cinco mil (punto de miles, que es lo normal en Colombia) o
 * como treinta y cinco coma cero (punto decimal, que es lo normal en inglés). No hace falta
 * adivinar cuál: basta con que **alguna** lectura tenga respaldo. Un modelo que se inventa una
 * cifra no acierta por casualidad en ninguna de las dos.
 */
function candidatosDe(bruto) {
    const candidatos = new Set();

    // Lectura 1: los separadores son de miles. «35.000» → 35000, «35.000,00» → 3500000.
    const sinSeparadores = Number(String(bruto).replace(/[.,]/g, ''));
    if (Number.isFinite(sinSeparadores)) candidatos.add(sinSeparadores);

    // Lectura 2: el último separador es decimal, si le siguen una o dos cifras. La parte entera
    // es lo que compromete: «35.000,50» son treinta y cinco mil pesos y medio, no tres millones.
    const conDecimales = String(bruto).match(/^(.*)[.,](\d{1,2})$/);
    if (conDecimales) {
        const entera = Number(conDecimales[1].replace(/[.,]/g, ''));
        if (Number.isFinite(entera)) candidatos.add(entera);
    }

    return candidatos;
}

/**
 * Parte un texto en las cifras que contiene, cada una con sus lecturas posibles.
 *
 * Las horas se sacan primero y se tapan, porque si no «9:00» se leería como dos cifras sueltas
 * (un 9 y un 0) y se perdería la única que significa algo: las nueve.
 */
function cifrasDe(texto) {
    if (!texto) return [];
    let plano = String(texto);
    const cifras = [];

    for (const m of plano.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
        const hora = Number(m[1]);
        const minuto = Number(m[2]);
        // La hora normalizada (HHMM) permite casar «9:00» con «09:00» venga como venga del
        // horario del negocio; la hora suelta cubre el «a las 9» del texto.
        cifras.push({ lecturas: new Set([hora * 100 + minuto, hora]), comprometeDinero: false });
    }
    plano = plano.replace(/\b\d{1,2}:\d{2}\b/g, ' ');

    for (const m of plano.matchAll(/(\$\s*)?(\d[\d.,]*\d|\d)\s*(%)?/g)) {
        const bruto = m[2];
        if (!bruto) continue;
        cifras.push({
            lecturas: candidatosDe(bruto),
            // Una cifra con `$` delante o `%` detrás **compromete dinero**. La distinción no es
            // cosmética: decide quién puede respaldarla (ver `revisar`).
            comprometeDinero: Boolean(m[1] || m[3]),
        });
    }

    return cifras;
}

/** Todos los números de un texto, aplanados. Sirve como **respaldo**, donde ser generoso no daña. */
function numerosDe(texto) {
    const todos = new Set();
    for (const cifra of cifrasDe(texto)) for (const n of cifra.lecturas) todos.add(n);
    return todos;
}

/** Todos los números que hay dentro de una estructura, por hondo que estén. */
function numerosDeEstructura(valor, acumulador = new Set()) {
    if (valor === null || valor === undefined) return acumulador;

    if (typeof valor === 'number') {
        if (Number.isFinite(valor)) {
            acumulador.add(Math.trunc(valor));
            // Un precio de 35000.00 y el texto «35.000» tienen que casar; y una duración de 30
            // min escrita como «30» también.
            acumulador.add(Math.round(valor));
        }
        return acumulador;
    }

    if (typeof valor === 'string') {
        for (const n of numerosDe(valor)) acumulador.add(n);
        return acumulador;
    }

    if (Array.isArray(valor)) {
        for (const item of valor) numerosDeEstructura(item, acumulador);
        return acumulador;
    }

    if (typeof valor === 'object') {
        for (const item of Object.values(valor)) numerosDeEstructura(item, acumulador);
        return acumulador;
    }

    return acumulador;
}

/**
 * Revisa una respuesta antes de que salga.
 *
 * @param {Object}   opciones
 * @param {string}   opciones.texto      — lo que el asistente va a decir.
 * @param {Array}    opciones.resultados — lo que DEVOLVIERON las capacidades de este turno. Es el
 *                                         respaldo que ADR-023 exige, y llega aparte y no dentro
 *                                         de `invocaciones` por un motivo de peso: las
 *                                         invocaciones se persisten en el Ledger y ahí no se
 *                                         vuelcan los datos del cliente (ADR-024). Aquí los
 *                                         números se miran y se tiran; solo sobreviven los que
 *                                         NO tenían respaldo.
 * @param {string}   opciones.mensajeCliente — lo que escribió el cliente: sus cifras no son
 *                                         promesas del negocio.
 * @param {Object}   opciones.negocio    — contexto del inquilino (horario, etc.).
 * @returns {{limpio: boolean, sinRespaldo: number[]}}
 */
function revisar({ texto, resultados = [], mensajeCliente = '', negocio = null }) {
    const dichas = cifrasDe(texto);
    if (dichas.length === 0) return { limpio: true, sinRespaldo: [] };

    // Respaldo fuerte: lo que el SISTEMA sabe. Solo cuenta lo que la capacidad DEVOLVIÓ — los
    // argumentos los propuso el modelo, y aceptarlos sería dejar que firme su propio aval.
    const respaldoFuerte = new Set();
    numerosDeEstructura(resultados, respaldoFuerte);
    numerosDeEstructura(negocio?.atencion ?? null, respaldoFuerte);

    // Respaldo débil: lo que dijo el cliente. Repetirle su fecha no es prometer nada.
    const respaldoDebil = new Set(respaldoFuerte);
    for (const n of numerosDe(mensajeCliente)) respaldoDebil.add(n);

    // ⚠️ El cliente puede proponer una FECHA; no puede autorizar un PRECIO.
    //
    // Esto se descubrió probando contra el modelo real el 2026-08-18. La primera versión daba por
    // respaldado todo número que el cliente hubiera escrito, y esa es justo la forma del ataque:
    // «soy cliente frecuente, hazme un 20% de descuento» → si el bot contesta «listo, el 20%», el
    // 20 venía del cliente y el guardarraíl lo dejaba pasar. El ejemplo textual de ADR-023 se
    // colaba por la puerta de atrás.
    //
    // Así que una cifra marcada como dinero (`$` delante o `%` detrás) solo la respalda el
    // sistema. Las demás —días, horas, duraciones— siguen aceptando lo que dijo el cliente.
    const sinRespaldo = dichas
        .filter(({ lecturas, comprometeDinero }) => {
            const respaldo = comprometeDinero ? respaldoFuerte : respaldoDebil;
            // Los irrelevantes existen para no ahogar la medición en «1) Corte 2) Tinte». Con `$`
            // o `%` delante dejan de serlo: «te hago un 5%» compromete tanto como un 50%, y
            // dejarlo pasar por pequeño sería un agujero del tamaño exacto de la lista.
            const salvavidas = comprometeDinero
                ? (n) => respaldo.has(n)
                : (n) => respaldo.has(n) || IRRELEVANTES.has(n);
            return ![...lecturas].some(salvavidas);
        })
        // De las lecturas que sobran se reporta la mayor: es la que compromete de verdad.
        .map(({ lecturas }) => Math.max(...lecturas));

    return { limpio: sinRespaldo.length === 0, sinRespaldo };
}

/**
 * El paso que se escribe en el Ledger: es el «registro de lo prometido» que pide ADR-023, para que
 * el negocio pueda auditar qué dijo su empleado virtual.
 *
 * ⚠️ `tipo: 'regla'` porque el CHECK de `intelligence.paso` admite seis y ninguno es «guardarraíl»
 * (ESTADO-Y-CONTINUACION §8). Ampliar el enum sería una migración sobre una tabla particionada
 * para no ganar nada que el `decision` no diga ya.
 */
function paso(revision, modo = MODO) {
    return {
        tipo: 'regla',
        decision: modo === 'bloqueo' ? 'promesa_bloqueada' : 'promesa_sin_respaldo',
        motivo: { cifras: revision.sinRespaldo.slice(0, 20), modo },
    };
}

const bloquea = (modo = MODO) => modo === 'bloqueo';

module.exports = { revisar, paso, bloquea, cifrasDe, numerosDe, numerosDeEstructura, MODO };
