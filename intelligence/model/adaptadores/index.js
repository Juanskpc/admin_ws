/**
 * Fábrica de adaptadores del `ModelPort`.
 *
 * Es **el único sitio** donde se elige proveedor. La composición (`intelligence/index.js`) y el
 * arnés (`scripts/evaluar.js`) pasan los dos por aquí, y por eso no pueden divergir: si el arnés
 * midiera un proveedor y el servidor arrancara con otro, la medición no serviría de nada — y ese
 * es exactamente el fallo que ya se pagó una vez, cuando `app.js` montaba el eco mientras los
 * tests ejercitaban la FSM.
 *
 * ADR-018 quiere **un** proveedor en operación. Que aquí haya dos es transitorio y tiene fecha
 * de caducidad: se mide con `scripts/evaluar.js --comparar`, se decide, y el que pierda se borra
 * de esta lista y del disco.
 */
'use strict';

const precios = require('../precios');

const FABRICAS = {
    anthropic: () => require('./anthropic').crearAdaptadorAnthropic,
    openai: () => require('./openai').crearAdaptadorOpenai,
};

/** La variable de entorno con la credencial de cada proveedor. */
const CREDENCIAL = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
};

/** Modelo por defecto de cada proveedor cuando no se dice cuál. */
const MODELO_POR_DEFECTO = {
    anthropic: 'claude-opus-5',
    openai: 'gpt-5.6-terra',
};

/**
 * Qué proveedores tienen credencial ahora mismo. La composición lo usa para decidir sola cuando
 * no se le dice nada — que es el caso normal en desarrollo: pones una clave y funciona.
 */
function proveedoresDisponibles() {
    return Object.keys(FABRICAS).filter((p) => Boolean(process.env[CREDENCIAL[p]]));
}

/**
 * Resuelve qué proveedor y qué modelo usar, en este orden:
 *
 *   1. lo que se pase por argumento (el arnés, al comparar),
 *   2. `LLM_MODELO` — el modelo manda, porque su proveedor se deduce de `precios.js`,
 *   3. `LLM_PROVEEDOR` con su modelo por defecto,
 *   4. el único proveedor que tenga credencial.
 *
 * Deducir el proveedor del modelo y no al revés evita la combinación imposible: pedir
 * `gpt-5.6-terra` con el adaptador de Anthropic no falla al arrancar, falla en el primer turno
 * y con un error del proveedor que no dice nada del problema real.
 */
function resolver({ proveedor = null, modelo = null } = {}) {
    const modeloPedido = modelo || process.env.LLM_MODELO || null;
    const proveedorPedido = proveedor || process.env.LLM_PROVEEDOR || null;
    const dueñoDelModelo = modeloPedido ? precios.proveedorDe(modeloPedido) : null;

    // Se comprueba ANTES de mirar credenciales. Si no, un modelo mal escrito devuelve `null`
    // —«no hay Nivel 4»— en una máquina sin clave y solo revienta en la que sí la tiene: el
    // error aparecería lejísimos de la errata que lo causó.
    if (modeloPedido && !dueñoDelModelo) {
        const e = new Error(
            `El modelo "${modeloPedido}" no está en precios.js, así que su costo no se puede ` +
                'calcular. Añádelo con su tarifa antes de usarlo (ADR-022).'
        );
        e.code = 'MODELO_SIN_PRECIO';
        throw e;
    }

    // Si te contradices, se te dice. La tentación era dejar que el modelo mandara en silencio —
    // nunca produce una petición inválida— pero entonces un `LLM_PROVEEDOR` explícito se ignora
    // sin avisar, y acabas midiendo un proveedor creyendo que mediste el otro. Es peor que un
    // arranque fallido: es una conclusión falsa.
    if (proveedorPedido && dueñoDelModelo && dueñoDelModelo !== proveedorPedido) {
        const e = new Error(
            `El modelo "${modeloPedido}" es de ${dueñoDelModelo} y se pidió el proveedor ` +
                `"${proveedorPedido}". Revisa LLM_MODELO y LLM_PROVEEDOR: uno de los dos sobra.`
        );
        e.code = 'MODELO_Y_PROVEEDOR_NO_CUADRAN';
        throw e;
    }

    // Sin contradicción, el modelo manda: su proveedor se deduce de la tabla de precios, así que
    // basta decir `LLM_MODELO` y no hay forma de emparejarlo con el adaptador equivocado.
    let elegidoProveedor = dueñoDelModelo || proveedorPedido || proveedoresDisponibles()[0] || null;
    if (!elegidoProveedor) return null;

    if (!FABRICAS[elegidoProveedor]) {
        const e = new Error(
            `Proveedor de modelo desconocido: "${elegidoProveedor}". Conocidos: ` +
                `${Object.keys(FABRICAS).join(', ')}.`
        );
        e.code = 'PROVEEDOR_DESCONOCIDO';
        throw e;
    }

    const elegidoModelo = modeloPedido || MODELO_POR_DEFECTO[elegidoProveedor];

    return { proveedor: elegidoProveedor, modelo: elegidoModelo, credencial: CREDENCIAL[elegidoProveedor] };
}

/**
 * Construye el adaptador. Devuelve `null` si no hay ningún proveedor con credencial — no lanza,
 * porque quedarse sin Nivel 4 es un estado válido del sistema (ADR-005) y no un error.
 */
function crearAdaptador({ proveedor = null, modelo = null, apiKey = null } = {}) {
    const elegido = resolver({ proveedor, modelo });
    if (!elegido) return null;

    const clave = apiKey || process.env[elegido.credencial];
    if (!clave) return null;

    const fabrica = FABRICAS[elegido.proveedor]();
    const adaptador = fabrica({ apiKey: clave });
    return { adaptador, modelo: elegido.modelo, proveedor: elegido.proveedor };
}

module.exports = { crearAdaptador, resolver, proveedoresDisponibles, CREDENCIAL, MODELO_POR_DEFECTO };
