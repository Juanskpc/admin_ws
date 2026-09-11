'use strict';

/**
 * realtime — avisos en vivo del servidor al navegador (SSE, *Server-Sent Events*).
 *
 * El problema que resuelve: dos personas del mismo negocio trabajando en equipos distintos no
 * se ven entre ellas. El mesero cobra una mesa y en la tablet del otro sigue ocupada; cocina
 * marca un plato listo y en Despacho no aparece hasta que alguien entra de nuevo a la pantalla.
 *
 * ## Por qué SSE y no WebSockets
 *
 * Un WebSocket es un tubo de DOS vías. Aquí solo hace falta una: lo que el usuario *hace* ya
 * viaja por las rutas REST de siempre, y lo único que falta es que el servidor pueda decir
 * «oye, algo cambió». SSE hace exactamente eso, viene de fábrica en Node y en el navegador
 * (cero dependencias nuevas), se reconecta solo —importante con tablets en wifi de local— y
 * para la red es una petición HTTP normal que no se termina, así que atraviesa Caddy sin
 * configuración especial.
 *
 * ## Qué viaja por aquí: una SEÑAL, no los datos
 *
 * El aviso dice «cambió algo de `pedidos` en el negocio 12» y nada más. Quien lo recibe vuelve
 * a pedir la lista por el endpoint de siempre.
 *
 * Es deliberado y es la decisión importante de este módulo: las reglas de quién puede ver qué
 * —por ejemplo que un cajero sin `caja_ver_ingresos` no vea los montos— viven en esos
 * endpoints. Si los datos viajaran por aquí habría que repetir esas reglas en este camino, y
 * el día que se olvide una, este tubo enseñaría lo que la pantalla esconde.
 *
 * ## Esto NO es el outbox de eventos de dominio (ADR-012)
 *
 * El outbox es para lo que no se puede perder (recordatorios, WhatsApp): escribe en la base,
 * garantiza la entrega y la reintenta. Una señal de «refresca la pantalla» es lo contrario:
 * si se pierde no pasa nada, porque la próxima señal —o la reconexión, que refresca todo—
 * pone al día. Meterla en el outbox significaría escribir en la base cada vez que alguien
 * toca un pedido y sondear esa tabla cada 5 segundos, en un servidor de un solo núcleo.
 *
 * Son cosas distintas a propósito: aquí no hay persistencia, ni reintentos, ni orden
 * garantizado. Si algún día un evento de dominio real necesita llegar a la pantalla, se
 * añade un consumidor del relay que llame a `emitir()`; los dos caminos conviven.
 *
 * ## Coste
 *
 * En reposo: cero consultas a la base y una conexión abierta por pestaña. El único tráfico es
 * un latido cada 25 segundos, que además es lo que distingue una conexión viva de una muerta.
 */

/**
 * Freno de emergencia. Con `REALTIME_ENABLED=false` el canal deja de aceptar conexiones y las
 * pantallas caen solas a su refresco por reloj, sin desplegar nada.
 *
 * Existe porque esto es lo único de este trabajo que NO tiene interruptor por negocio: afecta a
 * todos a la vez. Si en producción resultara que Caddy retiene la respuesta —lo que queda por
 * comprobar— o que las conexiones abiertas molestan al servidor, se apaga con una variable de
 * entorno y un reinicio, sin tener que revertir un despliegue.
 */
const HABILITADO = process.env.REALTIME_ENABLED !== 'false';

/** Cada cuánto se manda el latido que mantiene viva la conexión y detecta las muertas. */
const LATIDO_MS = Number(process.env.REALTIME_LATIDO_MS) || 25_000;

/**
 * Topes de conexiones. No son una optimización: son el freno que impide que un cliente con un
 * bucle roto —o una pestaña que se reabre sola— se lleve por delante un servidor de 1 núcleo.
 * Al superarlos se responde 503 y el navegador se queda con su refresco por tiempo, que es el
 * comportamiento que ya tenía antes de existir esto.
 */
const MAX_POR_NEGOCIO = Number(process.env.REALTIME_MAX_POR_NEGOCIO) || 40;
const MAX_TOTAL = Number(process.env.REALTIME_MAX_TOTAL) || 200;

/** Map<`canal:idNegocio`, Set<conexion>> */
const salas = new Map();
let totalConexiones = 0;
let temporizadorLatido = null;

function claveSala(canal, idNegocio) {
    return `${canal}:${Number(idNegocio)}`;
}

/**
 * Escribe en una conexión sin dejar que un socket muerto rompa nada.
 *
 * Quien llama a `emitir()` está en medio de una operación de negocio —acaba de cobrar un
 * pedido—. Que el navegador de alguien se haya ido no puede hacer fallar ese cobro.
 */
function escribir(conexion, texto) {
    try {
        if (conexion.res.writableEnded || conexion.res.destroyed) return false;
        conexion.res.write(texto);
        return true;
    } catch {
        return false;
    }
}

/**
 * Un solo temporizador para TODAS las conexiones, no uno por conexión.
 *
 * Va con `unref()` a propósito: un `setInterval` vivo impide que Node termine, y esta suite ya
 * arrastra el problema de que jest no cierra solo (ver CLAUDE.md). Un latido no es motivo para
 * mantener vivo un proceso que ya terminó su trabajo.
 */
function asegurarLatido() {
    if (temporizadorLatido || totalConexiones === 0) return;

    temporizadorLatido = setInterval(() => {
        // Un comentario SSE (una línea que empieza por «:») no dispara nada en el cliente:
        // solo mueve bytes, que es justo lo que hace falta para que ningún intermediario dé
        // la conexión por abandonada y para enterarnos de las que ya están muertas.
        for (const sala of salas.values()) {
            for (const conexion of [...sala]) {
                if (!escribir(conexion, ': latido\n\n')) cerrarConexion(conexion);
            }
        }
    }, LATIDO_MS);

    if (typeof temporizadorLatido.unref === 'function') temporizadorLatido.unref();
}

function detenerLatidoSiVacio() {
    if (totalConexiones > 0 || !temporizadorLatido) return;
    clearInterval(temporizadorLatido);
    temporizadorLatido = null;
}

function cerrarConexion(conexion) {
    const sala = salas.get(conexion.clave);
    if (!sala || !sala.delete(conexion)) return;

    totalConexiones -= 1;
    if (sala.size === 0) salas.delete(conexion.clave);
    detenerLatidoSiVacio();

    try {
        conexion.res.end();
    } catch {
        // Ya estaba cerrada. No hay nada que hacer ni nada que reportar.
    }
}

/**
 * Deja abierta la respuesta y apunta al navegador a la sala de su negocio.
 *
 * **Quien llama es responsable de haber comprobado que el usuario pertenece a ese negocio.**
 * Este módulo no sabe de sesiones ni de permisos: si se le pasa un `idNegocio`, lo apunta ahí.
 *
 * @returns {boolean} false si se rechazó por tope de conexiones (ya respondió 503).
 */
function suscribir(req, res, { canal, idNegocio }) {
    if (!HABILITADO) {
        res.status(503).json({
            success: false,
            message: 'Los avisos en vivo están desactivados.',
            errors: { code: 'REALTIME_APAGADO' },
        });
        return false;
    }

    const clave = claveSala(canal, idNegocio);
    const sala = salas.get(clave) || new Set();

    if (totalConexiones >= MAX_TOTAL || sala.size >= MAX_POR_NEGOCIO) {
        res.status(503).json({
            success: false,
            message: 'Demasiadas conexiones en vivo abiertas. Intenta de nuevo en un momento.',
            errors: { code: 'REALTIME_SATURADO' },
        });
        return false;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // `no-transform` importa tanto como `no-cache`: le prohíbe a cualquier intermediario
        // recomprimir o reempaquetar la respuesta, que es como se «pierden» los avisos —
        // quedan retenidos en un búfer esperando a llenarlo, y llegan todos juntos o no llegan.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Para proxies de la familia nginx. Caddy no lo necesita, pero no molesta y el día que
        // haya otro proxy delante, esto ya está puesto.
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Sin esto, Node cierra el socket por inactividad (no hay peticiones nuevas en una conexión
    // que solo espera) y `setNoDelay` evita que el latido se quede esperando a llenar un paquete.
    req.socket?.setTimeout?.(0);
    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true);

    const conexion = { res, clave };
    sala.add(conexion);
    salas.set(clave, sala);
    totalConexiones += 1;
    asegurarLatido();

    // Si el cliente cae al modo EventSource nativo, esto le dice cada cuánto reintentar.
    escribir(conexion, 'retry: 3000\n\n');
    escribir(
        conexion,
        `event: listo\ndata: ${JSON.stringify({ canal, id_negocio: Number(idNegocio) })}\n\n`,
    );

    req.on('close', () => cerrarConexion(conexion));
    res.on('error', () => cerrarConexion(conexion));

    return true;
}

/**
 * Avisa a todas las pantallas abiertas de un negocio que algo cambió.
 *
 * Nunca lanza: se llama justo después de confirmar una operación de negocio y un navegador
 * caído no puede tumbar un cobro.
 *
 * @param {{canal: string, idNegocio: number, temas: string[]|string}} aviso
 * @returns {number} a cuántas pantallas se avisó (0 si no había ninguna abierta).
 */
function emitir({ canal, idNegocio, temas }) {
    try {
        const lista = [...new Set([].concat(temas || []).filter(Boolean))];
        if (!canal || !idNegocio || lista.length === 0) return 0;

        const sala = salas.get(claveSala(canal, idNegocio));
        if (!sala || sala.size === 0) return 0;

        const cuerpo = `event: cambio\ndata: ${JSON.stringify({
            temas: lista,
            en: new Date().toISOString(),
        })}\n\n`;

        let entregados = 0;
        for (const conexion of [...sala]) {
            if (escribir(conexion, cuerpo)) entregados += 1;
            else cerrarConexion(conexion);
        }
        return entregados;
    } catch {
        return 0;
    }
}

/** Cuántas pantallas hay escuchando. Para diagnóstico y para los tests. */
function contar(canal = null, idNegocio = null) {
    if (canal && idNegocio) return salas.get(claveSala(canal, idNegocio))?.size || 0;
    return totalConexiones;
}

/** Cierra todo. Solo para los tests y para un apagado ordenado. */
function cerrarTodo() {
    for (const sala of salas.values()) {
        for (const conexion of [...sala]) cerrarConexion(conexion);
    }
    salas.clear();
    totalConexiones = 0;
    detenerLatidoSiVacio();
}

module.exports = {
    HABILITADO,
    suscribir,
    emitir,
    contar,
    cerrarTodo,
    LATIDO_MS,
    MAX_POR_NEGOCIO,
    MAX_TOTAL,
};
