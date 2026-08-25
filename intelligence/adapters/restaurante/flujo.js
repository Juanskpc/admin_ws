/**
 * El flujo determinista de un restaurante: la puerta de entrada, y nada más.
 *
 * ## Por qué es tan corto, y por qué eso es la decisión
 *
 * El flujo de `reserva` es una máquina de estados larga porque agendar una cita **es** un
 * formulario: servicio, profesional, día, hora, nombre. Las opciones son finitas y el cliente
 * elige de listas.
 *
 * Pedir comida no se parece a eso. «Dos bandejas, una sin chicharrón, y una limonada sin azúcar»
 * es una frase, no cinco pulsaciones. Un menú rígido de categoría → producto → cantidad → ¿algo
 * más? convierte un pedido de tres cosas en doce mensajes, y sigue sin entender «sin cebolla».
 *
 * Así que este flujo hace **solo lo que un guion hace mejor que un modelo**: recibir a quien
 * llega, decirle de qué negocio se trata y ofrecerle los dos caminos. En cuanto el cliente elige
 * pedir por chat, esto se aparta y **no deja tarea abierta**: el comodín de la política de
 * enrutado (`pregunta_libre` → Nivel 4) manda el resto al modelo, que sí sabe conversar y ya
 * tiene las cuatro capacidades de restaurante. Es literalmente para lo que existe la escalera de
 * ADR-018 — el peldaño barato atiende lo previsible y el caro solo lo que hace falta.
 *
 * ## Las dos opciones no son cosmética
 *
 * El menú digital es **más barato y más exacto** que conversar: el cliente ve fotos y precios,
 * arma el carrito en su navegador y llega con el pedido hecho. Cero turnos de modelo, cero
 * malentendidos sobre qué pidió. Ofrecerlo primero es ofrecer el camino bueno.
 *
 * Pero obligar a usarlo sería peor: hay quien no quiere abrir una página, o pide siempre lo
 * mismo, o escribe desde un teléfono con mala conexión. Por eso son dos caminos y no uno.
 */
'use strict';

const contextoNegocio = require('../../core/contextoNegocio');
const { COMANDO, normalizar, ultimaLinea, esComando } = require('../../engine/texto');

const VERTICAL = 'restaurante';

/** Los tipos de `general.gener_tipo_negocio.nombre` que atiende este flujo. */
const TIPOS_NEGOCIO = ['RESTAURANTE'];

const OPCION = {
    MENU: 'ver_menu',
    CHAT: 'pedir_chat',
};

/**
 * De dónde sale el enlace del menú digital.
 *
 * `FRONTEND_URL` ya existe en el `.env` y apunta a la raíz del sitio; la ruta pública de la
 * carta es `/restaurante/carta/:id` (`restaurante_app/src/app/app.routes.ts`). Se deja
 * `MENU_DIGITAL_URL` como escape por si algún día el menú vive en otro dominio, pero no hace
 * falta ponerla: sin ella se compone sola, y una variable más que nadie rellena es una variable
 * que acaba mal puesta.
 */
function enlaceDelMenu(idNegocio) {
    const base = (process.env.MENU_DIGITAL_URL || `${process.env.FRONTEND_URL || ''}/restaurante/carta`)
        .replace(/\/+$/, '');
    return `${base}/${idNegocio}`;
}

function paso(decision, motivo = {}) {
    return { tipo: 'regla', decision, motivo };
}

/** Memoria mínima. Se conserva lo que ya hubiera: `variables` reemplaza, no fusiona. */
function conMemoria(conversacion, extra = {}) {
    const previas = conversacion.variables || {};
    return {
        nombre: previas.nombre ?? null,
        telefono: previas.telefono ?? null,
        ultimo_pedido: previas.ultimo_pedido ?? null,
        turnos: Number(previas.turnos || 0) + 1,
        ...extra,
    };
}

function bienvenida(ctx, pasosPrevios = []) {
    const enlace = enlaceDelMenu(ctx.idNegocio);
    return {
        pasos: [...pasosPrevios, paso('menu_entrada_restaurante')],
        respuestas: [
            {
                // ⚠️ El enlace va DENTRO del texto, no como opción.
                //
                // Un botón de WhatsApp no abre una URL: devuelve un id al bot. Ofrecer «Ver el
                // menú» como opción obligaba a un turno de ida y vuelta —el cliente pulsa, el
                // bot contesta con el enlace— para algo que debería ser un toque. En el texto,
                // WhatsApp lo hace pulsable solo.
                texto: [
                    `¡Hola! Te comunicas con ${ctx.negocio.tratamiento}.`,
                    '',
                    '🍽️ *Ver el menú y pedir desde ahí:*',
                    enlace,
                    '',
                    'Ahí ves fotos y precios, armas el pedido y vuelves aquí con todo listo.',
                    '',
                    'O si prefieres, dime por aquí qué quieres y yo lo anoto.',
                ].join('\n'),
                opciones: [
                    {
                        id: OPCION.CHAT,
                        etiqueta: 'Pedir por aquí',
                        detalle: 'Me dices qué quieres y yo lo anoto',
                    },
                ],
            },
        ],
        variables: conMemoria(ctx.conversacion, { enlace_menu: enlace }),
        // Sin tarea: quien no elija ninguna de las dos y escriba una pregunta suelta debe poder
        // ser atendido por el modelo, no quedarse atrapado repitiendo este menú.
        tarea: null,
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

function mandarElMenu(ctx) {
    const enlace = enlaceDelMenu(ctx.idNegocio);
    return {
        pasos: [paso('menu_digital_enviado')],
        respuestas: [
            // El enlace va en el texto y no como opción: una «opción» que en realidad es un
            // enlace se renderiza como un botón que no hace nada en WhatsApp, donde los botones
            // devuelven un id al bot en vez de abrir una URL.
            {
                texto:
                    `Aquí tienes la carta: ${enlace}\n\n` +
                    'Elige lo que quieras y, cuando termines, el mismo menú te trae de vuelta ' +
                    'aquí con el pedido listo. Solo tendrás que darme la dirección.',
            },
        ],
        variables: conMemoria(ctx.conversacion, { enlace_menu: enlace }),
        tarea: null,
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

function pasarAlModelo(ctx) {
    return {
        pasos: [paso('pedido_por_chat_delegado', { a: 'nivel4' })],
        respuestas: ['Claro. Dime qué quieres pedir y de paso la dirección de entrega.'],
        variables: conMemoria(ctx.conversacion),
        // **Sin tarea a propósito.** Es lo que hace que el siguiente mensaje caiga en la regla
        // `pregunta_libre` de la política de enrutado y lo atienda el Nivel 4. Abrir una tarea
        // aquí lo devolvería a este flujo, que no sabe tomar un pedido.
        tarea: null,
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

/**
 * Crea el manejador. La inyección existe para los tests, igual que en el flujo de `reserva`.
 */
function crearFlujoRestaurante({ contextoNegocio: ctxNegocio = contextoNegocio } = {}) {
    return async function manejarRestaurante({ conversacion, texto }) {
        const negocio = await ctxNegocio.obtener(conversacion.id_negocio);
        const ctx = { conversacion, texto, negocio, idNegocio: Number(conversacion.id_negocio) };

        const t = normalizar(ultimaLinea(texto));

        if (t === OPCION.MENU || /\b(ver el menu|el menu|la carta|menu digital)\b/.test(t)) {
            return mandarElMenu(ctx);
        }
        if (t === OPCION.CHAT || /\b(pedir por aqui|por aqui|por chat)\b/.test(t)) {
            return pasarAlModelo(ctx);
        }

        // Un saludo o «menú» reabren la bienvenida. Cualquier otra cosa **no** cae aquí: la
        // política de enrutado ya la mandó al Nivel 4 antes de llegar a este archivo, porque
        // este flujo no deja tareas abiertas.
        return bienvenida(ctx, [paso('inicio_conversacion')]);
    };
}

module.exports = {
    VERTICAL,
    TIPOS_NEGOCIO,
    OPCION,
    crearFlujoRestaurante,
    manejarRestaurante: crearFlujoRestaurante(),
    enlaceDelMenu,
};
