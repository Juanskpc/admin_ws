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
 * llega, decirle de qué negocio se trata, ofrecerle los dos caminos y —si elige el chat— poner
 * delante los platos que más piden **con su precio**, que es una lectura de tabla y no una
 * conversación. En cuanto el cliente elige pedir por chat, esto se aparta y **no deja tarea
 * abierta**: el comodín de la política de
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
const {
    COMANDO,
    normalizar,
    ultimaLinea,
    esComando,
    esSaludo,
    saludoPorLaHora,
    esAfirmacion,
    esAfirmacionConEntrega,
    esPeticionConQue,
} = require('../../engine/texto');
const codigoPedido = require('./codigoPedido');
const confirmacion = require('../../engine/confirmacion');
const policyGate = require('../../core/policyGate');
const identidadReal = require('../../engine/identidad');
const horarioService = require('../../../app_restaurante_api/services/horarioService');
const barrioService = require('../../../app_restaurante_api/services/barrioService');
const exclusiones = require('./exclusiones');
const adiciones = require('./adiciones');
const mesaPublicaService = require('../../../app_restaurante_api/services/mesaPublicaService');
const datosCliente = require('./datosCliente');
const pago = require('./pago');
const formularioEntrega = require('./formularioEntrega');
const Models = require('../../../app_core/models/conection');

const VERTICAL = 'restaurante';

/** Los tipos de `general.gener_tipo_negocio.nombre` que atiende este flujo. */
const TIPOS_NEGOCIO = ['RESTAURANTE'];

const OPCION = {
    MENU: 'ver_menu',
    CHAT: 'pedir_chat',
    /**
     * Domicilio o recoger, como botones.
     *
     * Aquí sí compensa un botón, al revés que en el enlace del menú: no hay ninguna URL que
     * abrir, la elección es binaria, y escribirla a mano es justo donde aparecía la ambigüedad
     * de «llevar». Un toque no se escribe mal.
     *
     * Lo que llega de vuelta por el webhook es el **id**, no la etiqueta, así que `leerEntrega`
     * reconoce los dos: el id de quien pulsa y las palabras de quien escribe. Los dos caminos
     * siguen abiertos porque el botón no puede ser el único — un mensaje reenviado, una
     * respuesta citando el anterior o un canal sin botones traen texto y nada más.
     */
    ENTREGA_DOMICILIO: 'entrega_domicilio',
    ENTREGA_RECOGER: 'entrega_recoger',
    /** «Para servir»: comer en el local. Solo se ofrece si el negocio tiene mesas. */
    ENTREGA_SERVIR: 'entrega_servir',
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

/**
 * Cuántos productos se enseñan en el chat.
 *
 * No es el tamaño de la carta: es el tamaño de lo que alguien lee en un móvil sin hacer scroll
 * y sin sentir que le han volcado un PDF encima. La carta entera ya tiene su sitio —el enlace
 * del menú— y esto es el aperitivo: lo que más piden, con su precio, para que el cliente pueda
 * contestar «una de esas y una limonada» sin abrir nada.
 */
const MAX_EN_EL_CHAT = 8;

function paso(decision, motivo = {}) {
    return { tipo: 'regla', decision, motivo };
}

/** «$22.000». Un precio sin formato («22000») se lee como un número de teléfono. */
function enPesos(valor) {
    return valor == null ? '' : `$${Number(valor).toLocaleString('es-CO')}`;
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «5:00 PM» a partir de «17:00». */
function horaAmPm(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * «Hoy abrimos a las 5:00 PM» / «Abrimos mañana a las…» / «Abrimos el martes a las…».
 *
 * Recibe lo que devuelve `horarioService.proximaApertura`. Sin él (negocio sin horario, o la
 * consulta falló) devuelve `null` y quien llama cae a la frase genérica: no se inventa una hora.
 */
function fraseDeApertura(abre) {
    if (!abre || !abre.hora) return null;
    const hora = horaAmPm(abre.hora);
    if (abre.dias_adelante === 0) return `Hoy abrimos a las ${hora}.`;
    if (abre.dias_adelante === 1) return `Abrimos mañana a las ${hora}.`;
    const dia = DIAS_SEMANA[abre.dia_semana];
    if (!dia) return null;
    return abre.dias_adelante >= 7
        ? `Abrimos el próximo ${dia} a las ${hora}.`
        : `Abrimos el ${dia} a las ${hora}.`;
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

/**
 * El primer mensaje. Es el único que todo el mundo lee, así que es el que más se nota.
 *
 * ## Por qué se parece a lo que escribe un negocio, y no a lo que escribe un sistema
 *
 * Un restaurante de barrio saluda por la hora del día, se nombra, y dice de una lo que se puede
 * hacer. Un sistema informa. La diferencia no es decorativa: el cliente decide en el primer
 * mensaje si esto le va a servir o le va a hacer perder el tiempo, y «Te comunicas con X» suena
 * a contestador automático.
 *
 * Lo que se añadió respecto de la versión anterior —el saludo por la hora, el nombre en negrita
 * y una frase con lo demás que sabe hacer— cabe en tres líneas y quita la sensación de máquina.
 *
 * Lo que **no** se copió del ejemplo que dio el dueño es el formulario de datos («Dirección: /
 * Celular: / Nombre:»). Ese negocio lo necesita porque al otro lado hay una persona leyendo
 * mensajes a mano y quiere recibirlo todo de una vez. Aquí no hay nadie leyendo: pedirle al
 * cliente que rellene un formulario, cuando el asistente puede preguntar lo que falte justo
 * cuando falte, sería añadirle trabajo para no usar lo único que tenemos de más.
 *
 * ## Por qué también pregunta si el negocio está atendiendo (2026-09-22)
 *
 * Hasta hoy esto saludaba igual sin importar la hora: un cliente que escribía a las 3 de la
 * tarde recibía «arma tu pedido» aunque el negocio abriera a las 5, y solo se enteraba de que
 * estaba cerrado si llegaba hasta intentar confirmar un pedido (`tomar_pedido` es quien más
 * comprobaba esto, no el saludo). Pedido explícito del dueño: que el PRIMER mensaje ya diga en
 * cuál de los tres estados está el negocio — mismo estado que usa `tomar_pedido`
 * (`horarioService.estadoDeAtencion`), para que la respuesta no contradiga lo que pasaría si el
 * cliente insistiera en pedir.
 */
/**
 * El saludo que el cliente trajo, devuelto igual: si escribe «buenas noches» a las 6:52 PM, contestarle
 * «buenas tardes» suena a máquina (Zona Burger, 2026-10-03). Sin saludo con franja, se usa la hora.
 */
function saludoDelCliente(texto) {
    // ⚠️ 2026-10-04: este arreglo no funcionó NUNCA en producción. Los `\b` de las expresiones
    // se habían guardado como el carácter de retroceso (U+0008), invisible en el editor, así que
    // ninguna casaba y a las 6 PM «buenas noches» seguía recibiendo «buenas tardes». Lo cubre
    // `auditoria_2026_10_04.test.js`. De paso, cualquier espacio cuenta como uno (el espacio duro
    // U+00A0 de algunos teclados tampoco casaba).
    const t = normalizar(ultimaLinea(texto)).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ');
    if (/\bbuena?s? noches?\b/.test(t)) return '¡Buenas noches!';
    if (/\bbuena?s? tardes?\b/.test(t)) return '¡Buenas tardes!';
    if (/\bbuen(os)? dias?\b/.test(t)) return '¡Buenos días!';
    return null;
}

async function bienvenida(
    ctx,
    pasosPrevios = [],
    {
        estadoAtencion = horarioService.estadoDeAtencion,
        proximaApertura = horarioService.proximaApertura,
    } = {}
) {
    const enlace = enlaceDelMenu(ctx.idNegocio);
    const encabezado = `👋 ${saludoDelCliente(ctx.texto) || saludoPorLaHora(ctx.ahora())} Te saluda *${ctx.negocio.tratamiento}*.`;
    const { estado } = await estadoAtencion({ idNegocio: ctx.idNegocio, ahora: ctx.ahora() });
    const cuandoAbre = await cuandoAbreDe(ctx, estado, proximaApertura);

    return {
        pasos: [...pasosPrevios, paso('menu_entrada_restaurante', { estado })],
        respuestas: [
            {
                // ⚠️ El enlace va DENTRO del texto, no como opción.
                //
                // Un botón de WhatsApp no abre una URL: devuelve un id al bot. Ofrecer «Ver el
                // menú» como opción obligaba a un turno de ida y vuelta —el cliente pulsa, el
                // bot contesta con el enlace— para algo que debería ser un toque. En el texto,
                // WhatsApp lo hace pulsable solo.
                //
                // Sin botón a propósito (2026-09-22): el texto ya ofrece las dos rutas —el
                // enlace y "dime por aquí qué se te antoja"— y un botón «Pedir por aquí» sobraba
                // al lado de esa misma frase. El camino de texto libre sigue abierto igual:
                // `pedir por aquí` / `por chat` se reconocen más abajo como palabras sueltas.
                texto: [encabezado, '', ...cuerpoPorEstado(estado, cuandoAbre, enlace)].join('\n'),
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

/**
 * «Abrimos mañana a las 4:30 PM.» — solo cuando el cierre es por horario hay una hora que decir.
 * Si la consulta falla se cae a la frase genérica: es peor, pero el mensaje no se cae por eso.
 */
async function cuandoAbreDe(ctx, estado, proximaApertura) {
    if (estado !== 'fuera_de_horario') return null;
    try {
        return fraseDeApertura(await proximaApertura({ idNegocio: ctx.idNegocio, ahora: ctx.ahora() }));
    } catch (_) {
        return null;
    }
}

/** Lo que se dice en cada estado de atención, sin el saludo de cabecera. */
function cuerpoPorEstado(estado, cuandoAbre, enlace) {
    const textosPorEstado = {
        fuera_de_horario: [
            cuandoAbre
                ? `Ahora mismo estamos fuera de nuestro horario de atención. ${cuandoAbre} 🙏`
                : 'Ahora mismo estamos fuera de nuestro horario de atención. Te atendemos apenas ' +
                  'sea posible 🙏',
            '',
            'Si quieres, mientras tanto puedes ir mirando la carta, con fotos y precios 👇',
            enlace,
        ],
        aun_no_abre: [
            'Ya estamos en nuestro horario de atención, pero el restaurante todavía no ha ' +
                'abierto. Danos un momento y vuelve a escribir 🙏',
            '',
            'Mientras tanto puedes ir mirando la carta, con fotos y precios 👇',
            enlace,
        ],
        cerrado_sin_horario: [
            'El restaurante está cerrado ahora mismo. Vuelve a escribirme más tarde 🙏',
            '',
            'Mientras tanto puedes ir mirando la carta, con fotos y precios 👇',
            enlace,
        ],
        // El texto de siempre: en horario y con caja abierta (o sin horario configurado y con
        // caja abierta — un negocio que nunca cargó horario no queda restringido por eso).
        abierto: [
            'Aquí tienes la carta completa, con fotos y precios 👇',
            enlace,
            '',
            'Armas tu pedido ahí y vuelves a este chat con todo listo 🛵',
            '',
            'O si prefieres, dime por aquí qué se te antoja y yo te lo anoto. ' +
                'También te digo precios o en qué va un pedido que ya hiciste.',
        ],
    };
    return textosPorEstado[estado] || textosPorEstado.abierto;
}

/**
 * Estados en los que el negocio no está atendiendo: `tomar_pedido` rechazaría un pedido en
 * cualquiera de los tres, así que ahí no hay nada que el modelo pueda ofrecer sin mentir.
 */
const ESTADOS_SIN_SERVICIO = new Set(['fuera_de_horario', 'aun_no_abre', 'cerrado_sin_horario']);

/** Si ya se avisó de que está cerrado hace menos que esto, el siguiente aviso va corto. */
const AVISO_CERRADO_MS = 30 * 60 * 1000;

/**
 * Y si el aviso CORTO salió hace menos que esto, el siguiente no sale: silencio.
 *
 * El aviso corto arregló la longitud y se olvidó de la cuenta. Zona Burger, 2026-10-08 17:12: un
 * cliente escribió tres veces seguidas y recibió tres veces la misma frase en 35 segundos. En la
 * ventana auditada (2026-10-05 → 10-10) fueron **12 de los 33 avisos de cerrado**, todos a menos
 * de cinco minutos del anterior, y cada uno es un mensaje facturado que repite lo que el cliente
 * acaba de leer.
 *
 * Callar aquí es seguro y es la excepción consciente a «el modo de fallo caro es el silencio»
 * (`manejadorEscalera.js`), por lo mismo que la cortesía repetida: la respuesta ya está en la
 * pantalla del cliente, a unos segundos de distancia. Pasados los cinco minutos vuelve a salir,
 * porque entonces ya puede ser otra persona o otra intención.
 */
const SILENCIO_CERRADO_MS = 5 * 60 * 1000;

/**
 * ¿Está el negocio fuera de servicio para ESTE mensaje? Devuelve el estado, o `null` si no.
 *
 * ## Por qué existe (Zona Burger, 2026-10-02, 23:02)
 *
 * El local cierra a las 22:50. A las 23:02 llegó «Buenas noches, ¿realizas domicilios?» y lo
 * contestó el modelo: «Sí, hacemos domicilios. ¿Qué te gustaría pedir?». No miró el horario —no
 * es un saludo puro, así que no pasó por la bienvenida— y `tomar_pedido` habría rechazado el
 * pedido después, con la promesa ya hecha. Decisión del dueño: con el local cerrado contesta el
 * flujo, que dice el horario y deja la carta, y además no se gasta el modelo.
 *
 * ## Cuándo NO
 *
 * - Un pedido a medias o una confirmación esperando el sí: ese hilo es del flujo, y si el local
 *   cerró entre medio, `tomar_pedido` lo dirá al confirmar.
 * - Un chat con un pedido tomado en las últimas horas: quien pidió a las 22:40 y pregunta a las
 *   23:00 «¿ya salió?» tiene que recibir respuesta de su pedido, no «estamos cerrados».
 *
 * Ante cualquier fallo, `null`: se atiende como antes. Saber si está cerrado es una mejora; que
 * esa consulta tumbe una conversación no lo sería.
 */
async function fueraDeServicio(
    conversacion,
    {
        ahora = new Date(),
        estadoAtencion = horarioService.estadoDeAtencion,
        tienePedidoReciente = pedidoRecienteEnLaConversacion,
    } = {}
) {
    if (!conversacion?.id_negocio) return null;
    if (conversacion.tarea_actual === TAREA_PEDIDO) return null;
    if (confirmacion.pendiente(conversacion)) return null;
    let estado;
    try {
        ({ estado } = await estadoAtencion({ idNegocio: Number(conversacion.id_negocio), ahora }));
    } catch (error) {
        console.warn(`[restaurante] no se pudo leer el estado de atención: ${error.message}`);
        return null;
    }
    if (!ESTADOS_SIN_SERVICIO.has(estado)) return null;
    if (await tienePedidoReciente(conversacion)) return null;
    return estado;
}

/**
 * Lo que contesta el flujo con el negocio fuera de servicio, sin el modelo.
 *
 * - Primer mensaje (o vuelve tras un rato): la bienvenida entera, que ya dice el estado.
 * - Ya se le avisó hace poco: una línea, sin repetirle el enlace — tres mensajes seguidos de un
 *   cliente con hambre no merecen tres veces la carta.
 * - Y si esa línea salió hace menos de `SILENCIO_CERRADO_MS`: nada. Tres mensajes seguidos
 *   tampoco merecen tres veces la línea.
 * - Si no: el estado y la carta, sin volver a saludar.
 */
async function avisoFueraDeServicio(ctx, estado, { proximaApertura = horarioService.proximaApertura } = {}) {
    const previas = ctx.conversacion.variables || {};
    const sello = { aviso_cerrado_en: ctx.ahora().toISOString() };
    const pasoCerrado = paso('fuera_de_servicio', { estado });

    if (!Number(previas.turnos || 0) || previas._sesion_nueva === true) {
        const decision = await bienvenida(ctx, [pasoCerrado], {
            estadoAtencion: async () => ({ estado }),
            proximaApertura,
        });
        return { ...decision, variables: { ...decision.variables, ...sello } };
    }

    const cuandoAbre = await cuandoAbreDe(ctx, estado, proximaApertura);
    const avisadoEn = Date.parse(previas.aviso_cerrado_en || '');
    const reciente = Number.isFinite(avisadoEn) && ctx.ahora().getTime() - avisadoEn < AVISO_CERRADO_MS;

    // La línea corta ya salió hace nada: no se repite. Las variables sí se guardan (el turno
    // cuenta), para que `aviso_cerrado_en` siga midiendo desde el aviso largo y la carta vuelva
    // a salir a la media hora como siempre.
    const cortoEn = Date.parse(previas.aviso_cerrado_corto_en || '');
    if (reciente && Number.isFinite(cortoEn) && ctx.ahora().getTime() - cortoEn < SILENCIO_CERRADO_MS) {
        return {
            pasos: [paso('fuera_de_servicio', { estado, repetido: true })],
            respuestas: [],
            variables: conMemoria(ctx.conversacion, {
                enlace_menu: previas.enlace_menu ?? null,
                aviso_cerrado_en: previas.aviso_cerrado_en,
                aviso_cerrado_corto_en: previas.aviso_cerrado_corto_en,
            }),
            tarea: null,
            resultado: 'sin_respuesta',
            nivel: 'determinista',
        };
    }

    const texto = reciente
        ? [
              estado === 'fuera_de_horario'
                  ? `Seguimos fuera de nuestro horario de atención.${cuandoAbre ? ` ${cuandoAbre}` : ''}`
                  : 'Todavía no estamos atendiendo.',
              'Apenas abramos te atendemos 🙏',
          ].join(' ')
        : cuerpoPorEstado(estado, cuandoAbre, enlaceDelMenu(ctx.idNegocio)).join('\n');

    return {
        pasos: [pasoCerrado],
        respuestas: [texto],
        variables: conMemoria(ctx.conversacion, {
            enlace_menu: previas.enlace_menu ?? null,
            // El sello solo se renueva con el aviso largo: así cada media hora vuelve a ir la carta.
            aviso_cerrado_en: reciente ? previas.aviso_cerrado_en : sello.aviso_cerrado_en,
            // Este sí se renueva siempre: mide cuándo se le dijo esto por última vez, sea la
            // línea corta o la larga, que es lo que decide el silencio del próximo.
            aviso_cerrado_corto_en: sello.aviso_cerrado_en,
        }),
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
                    `Claro, aquí tienes la carta 👉 ${enlace}\n\n` +
                    'Elige lo que quieras y, cuando termines, el mismo menú te trae de vuelta ' +
                    'aquí con el pedido listo. Solo tendrás que decirme la dirección 🛵',
            },
        ],
        variables: conMemoria(ctx.conversacion, { enlace_menu: enlace }),
        tarea: null,
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

/**
 * Arranca el pedido por chat: enseña QUÉ HAY y CUÁNTO VALE, y se aparta.
 *
 * ## Por qué esto ya no pregunta por categorías
 *
 * Hasta el 2026-08-26 este paso decía «esto es lo que tenemos» y pintaba las categorías como
 * botones: Entradas, Platos, Bebidas. Se hizo así por un motivo bueno —que el modelo no se
 * inventara un id de categoría, que es lo que pasó en producción el 24— y resolvió ese fallo.
 * Pero le pasó al cliente el problema de organización del restaurante.
 *
 * Las categorías existen para que el negocio ordene su carta. **A quien pide comida no le
 * importan**: quiere ver los platos y los precios. Preguntarle por cuál empieza es un turno
 * entero gastado en no decirle nada, y en un chat cada turno de más es una oportunidad de que
 * se vaya.
 *
 * Así que ahora se enseñan los productos directamente, los más pedidos primero. El fallo del 24
 * sigue cubierto y por una vía mejor: si nadie tiene que elegir una categoría, no hay id que
 * inventar. Y sigue siendo el flujo quien lo pinta —no el modelo— porque leer una tabla es
 * determinista y gastar un turno de modelo en eso es tirar dinero (ADR-018).
 *
 * El texto dice «dime qué se te antoja» y no «elige una opción» a propósito: quien ya sabe lo
 * que quiere no debería tener que navegar nada.
 */
async function abrirPedidoPorChat(ctx, leerCarta) {
    const enlace = enlaceDelMenu(ctx.idNegocio);
    const carta = await leerCarta(ctx.idNegocio).catch(() => ({ productos: [], total: 0 }));
    const productos = carta.productos || [];

    // Sin carta cargada no se finge una: se pregunta. Un restaurante que aún no ha subido sus
    // productos sigue pudiendo vender por aquí, y el modelo se apaña con lo que le digan.
    if (productos.length === 0) {
        return {
            pasos: [paso('pedido_por_chat_delegado', { a: 'nivel4', productos: 0 })],
            respuestas: ['¡De una! Dime qué quieres pedir y la dirección de entrega 📝'],
            variables: conMemoria(ctx.conversacion),
            tarea: null,
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    const lineas = productos.map((p) => `• *${p.nombre}* — ${enPesos(p.precio)}`);
    const hayMas = carta.total > productos.length;

    return {
        pasos: [
            paso('pedido_por_chat_delegado', {
                a: 'nivel4',
                productos: productos.length,
                de: carta.total,
            }),
        ],
        respuestas: [
            {
                texto: [
                    hayMas ? '¡De una! 😋 Esto es lo que más nos piden:' : '¡De una! 😋 Esto es lo que tenemos:',
                    '',
                    ...lineas,
                    '',
                    hayMas ? `Y hay más en la carta completa 👉 ${enlace}` : `Y la carta con fotos está aquí 👉 ${enlace}`,
                    '',
                    'Dime qué se te antoja y cuántos, y yo te lo anoto 📝',
                ].join('\n'),
                // Sin opciones: las que había eran las categorías. Un producto como botón
                // tampoco serviría —el título de un botón son 20 caracteres y no cabe el
                // precio— y una lista de diez filas devolvería un id que este flujo tendría que
                // saber convertir en un pedido, que es justo lo que no hace (ver la cabecera).
            },
        ],
        variables: conMemoria(ctx.conversacion, { enlace_menu: enlace }),
        // **Sin tarea a propósito.** Es lo que hace que el siguiente mensaje caiga en la regla
        // `pregunta_libre` de la política de enrutado y lo atienda el Nivel 4. Abrir una tarea
        // aquí lo devolvería a este flujo, que no sabe tomar un pedido.
        tarea: null,
        resultado: 'resuelto',
        nivel: 'determinista',
    };
}

/**
 * El pedido que llega del menú digital, de principio a fin y sin modelo.
 *
 * ## Por qué esto SÍ es un formulario, cuando pedir por chat no lo era
 *
 * La cabecera de este archivo defiende que pedir comida no se parece a agendar una cita: «dos
 * bandejas, una sin chicharrón, y una limonada sin azúcar» es una frase, no cinco pulsaciones.
 * Sigue siendo verdad **para quien pide escribiendo**.
 *
 * Un carrito armado en el menú es lo contrario: los productos ya están elegidos, exactos y con
 * su id. No queda nada que interpretar — faltan dos datos, el nombre y la dirección, y eso es un
 * formulario de dos campos. Dárselo a un modelo era pagar por que lo hiciera peor, y el
 * 2026-08-26 lo hizo peor de la forma cara: se le olvidó el carrito y preguntó «¿qué quieres
 * pedir hoy?» a alguien que acababa de mandarle su pedido.
 *
 * ## Por qué los productos van en la TAREA y no en `variables`
 *
 * ADR-014: la tarea es lo acotado y retomable; `variables` es la memoria infinita. Un pedido a
 * medias es exactamente lo primero — y además, mientras la tarea está abierta, la política de
 * enrutado devuelve cada mensaje a este flujo (`tarea_en_curso`), que es lo que impide que el
 * modelo se lleve la conversación a mitad de camino.
 *
 * Hasta hoy se dejaban en `variables.pedido_pendiente` y **nadie los leía nunca**: ni el modelo
 * —que no ve las variables— ni este flujo, que cerraba sin tarea. Eran un apunte para nadie.
 *
 * ## El sí sigue siendo del cliente
 *
 * Con nombre y dirección no se crea nada: se pide la confirmación por el mismo camino que usa el
 * modelo (`engine/confirmacion.js`), y es el Policy Gate quien se niega a ejecutar sin la prueba
 * (ADR-010). Este flujo no tiene una puerta trasera a `tomar_pedido`.
 */
/**
 * ⚠️ Se llama `pedido_domicilio` desde antes de que existiera el pedido para recoger, y **se
 * queda así a propósito**. Este valor está guardado en `tarea_actual` de las conversaciones que
 * hay abiertas ahora mismo: renombrarlo dejaría a quien esté a mitad de un pedido con una tarea
 * que ningún manejador reclama, o sea con el carrito hecho y el bot sin saber de qué le hablan.
 * Un nombre interno impreciso cuesta menos que eso.
 */
const TAREA_PEDIDO = 'pedido_domicilio';

/**
 * Los pasos del pedido, en orden.
 *
 * `TELEFONO` **solo aparece cuando el canal no probó ninguno**. Desde el cambio de identidad de
 * WhatsApp (BSUID, 2026) hay clientes que escriben sin enseñar su número, y un domicilio sin un
 * número al que llamar es un domicilio que se pierde en la puerta cuando el domiciliario no
 * encuentra la casa. Para todos los demás —que hoy son casi todos— no hay paso de más: el
 * teléfono ya lo probó el canal y preguntarlo sería pedir dos veces lo que ya tienes.
 *
 */
/**
 * Cómo recibe el cliente su pedido. Son **los valores del dominio** (`pedid_orden.tipo_pedido`),
 * no una traducción: lo que se elige aquí viaja hasta la columna sin que nadie lo convierta, y
 * una tabla de equivalencias en medio es un sitio más donde equivocarse.
 */
const ENTREGA = {
    DOMICILIO: 'DOMICILIO',
    RECOGER: 'LLEVAR',
    /**
     * En el local. Entra de dos formas: desde la carta virtual (`~m=L` con su mesa) o, desde el
     * 2026-10-02, por chat como «para servir»: el cliente viene en camino, no tiene mesa que decir,
     * y el sistema le guarda una libre (`datos.para_servir`). Antes esto solo entraba por la carta
     * y «para servir veci, ya vamos» terminaba convertido en «para recoger».
     */
    MESA: 'MESA',
};

const PASO_PEDIDO = {
    NOMBRE: 'nombre',
    /**
     * ¿Se lo llevamos o pasa a recogerlo?
     *
     * Va **antes** que la dirección y no junto a ella, porque es la respuesta que decide si la
     * dirección hace falta. Meterla en la pregunta combinada obligaría a preguntar la dirección
     * sin saber todavía si sobra — y pedirle la casa a quien va a pasar por el local es el tipo
     * de detalle por el que se nota que al otro lado no hay nadie.
     */
    ENTREGA: 'entrega',
    /**
     * Todo lo demás en una sola pregunta: teléfono (a quien haga falta) y dirección.
     *
     * Hasta el 2026-08-27 se pedían de uno en uno, y estaba escrito por qué: «un cuestionario de
     * cinco campos es lo que se hace cuando al otro lado hay una persona leyendo a mano». El
     * argumento era bueno y el resultado, no: un turno y una espera por cada dato que el cliente
     * tiene en la cabeza a la vez. Decisión del dueño ese día.
     *
     * El nombre se queda aparte a propósito. Es el primero, se contesta con una palabra y es lo
     * que convierte el trámite en una conversación; mezclarlo con la dirección lo volvería la
     * primera casilla de un formulario.
     *
     * Los sueltos siguen existiendo porque **una respuesta parcial vuelve a preguntar solo lo
     * que falte**, y ahí sí se pregunta de a uno.
     */
    DATOS: 'datos',
    TELEFONO: 'telefono',
    DIRECCION: 'direccion',
    /**
     * El barrio de un domicilio, cuando el negocio cobra el domicilio por barrio y el cliente no
     * lo trajo elegido de la carta. Va **antes** que la dirección: el valor del domicilio
     * depende de él y es lo que el cliente quiere saber antes de dar su casa.
     */
    BARRIO: 'barrio',
    /** La mesa de quien pide desde el local, cuando no la trajo o la que trajo no vale. */
    MESA: 'mesa',
};

/** Lo que hace falta para crear la orden, y que nadie más sabe. */
function datosDelPedido(conversacion) {
    return conversacion.tarea_actual === TAREA_PEDIDO ? conversacion.tarea_datos || {} : {};
}

function tareaPedido(datos) {
    return { nombre: TAREA_PEDIDO, datos };
}

function unidades(items) {
    return items.reduce((n, i) => n + i.cantidad, 0);
}

/**
 * El siguiente hueco por llenar, o `null` si ya está todo.
 *
 * Una sola función decide el orden de las preguntas, y por eso saltarse una es no devolverla
 * aquí. La alternativa —cada paso decidiendo cuál es el siguiente— es donde se cuela el camino
 * que nadie probó: basta que dos de ellos discrepen sobre si el teléfono hace falta.
 */
/**
 * Los huecos que quedan, en orden y sin el nombre. Vacío = ya no falta nada.
 *
 * Una sola función decide qué se pide y cuándo, por lo mismo de siempre: si cada paso decidiera
 * su siguiente, bastaría que dos discreparan sobre si el teléfono hace falta para que apareciera
 * el camino que nadie probó.
 */
function huecosDelCliente(datos, { telefonoProbado }) {
    const faltan = [];
    // Solo a quien llegó sin número. Ver la cabecera de `PASO_PEDIDO`.
    //
    // El teléfono se pide en los dos casos, pero **no por lo mismo**: en un domicilio es para
    // que el domiciliario llame desde la puerta; en un pedido para recoger es para poder
    // avisarle cuando esté listo. Como el motivo cambia, el texto de la pregunta también.
    // Ni en una mesa: quien está sentado no necesita que lo llamen ni que le avisen.
    if (datos.entrega !== ENTREGA.MESA && !datos.telefono && !telefonoProbado) {
        faltan.push(PASO_PEDIDO.TELEFONO);
    }
    // La dirección **solo** si se lo llevamos. Quien pasa a recoger no tiene que dar su casa,
    // y pedírsela sería recoger un dato que no se va a usar.
    if (datos.entrega === ENTREGA.DOMICILIO && !datos.direccion) {
        faltan.push(PASO_PEDIDO.DIRECCION);
    }
    return faltan;
}

/**
 * ¿Hay que preguntar el barrio? Solo si es un domicilio, el negocio cobra el domicilio por barrio
 * (y tiene alguno cargado) y todavía no se sabe: ni elegido, ni un «otro barrio» dicho.
 */
function necesitaBarrio(datos, ctx) {
    return (
        datos.entrega === ENTREGA.DOMICILIO &&
        Boolean(ctx?.barrios?.habilitado) &&
        (ctx.barrios.barrios || []).length > 0 &&
        !datos.id_barrio &&
        !datos.barrio_otro
    );
}

function loQueFalta(datos, ctx) {
    if (!datos.nombre) return PASO_PEDIDO.NOMBRE;
    // Antes que nada de lo demás: de esta respuesta depende qué más se pregunta.
    if (!datos.entrega) return PASO_PEDIDO.ENTREGA;
    // El barrio y la mesa, antes de nada más: de ellos depende lo que cuesta y adónde va.
    if (necesitaBarrio(datos, ctx)) return PASO_PEDIDO.BARRIO;
    if (datos.entrega === ENTREGA.MESA && !datos.id_mesa && !datos.para_servir) return PASO_PEDIDO.MESA;
    const faltan = huecosDelCliente(datos, ctx);
    if (faltan.length === 0) return null;
    // Uno solo se pregunta por su nombre; varios, todos juntos. Preguntar «necesito una cosita»
    // y listar un solo punto se lee peor que preguntarla directamente.
    return faltan.length === 1 ? faltan[0] : PASO_PEDIDO.DATOS;
}

/**
 * Los datos que faltan, en un solo mensaje.
 *
 * Se enumera con viñetas y no en prosa a propósito: una lista corta se contesta mirándola, y el
 * cliente puede mandar las dos cosas en una línea o en dos. Lo que llegue se lee con
 * `interpretarDatos`, y **lo que no se entienda se vuelve a preguntar solo**.
 *
 * Hoy son como mucho dos —teléfono y dirección—, porque el paso del pago se retiró el
 * 2026-08-27 (ver `docs/asistente-restaurante.md`). La función sigue escrita para una lista de
 * largo cualquiera: es lo único que hace falta el día que vuelva a haber un tercero.
 */
function preguntaCombinada(datos, ctx) {
    const faltan = huecosDelCliente(datos, ctx || {});
    const lineas = faltan.map((hueco) =>
        hueco === PASO_PEDIDO.TELEFONO
            ? `📱 Un número de contacto, ${motivoDelTelefono(datos.entrega)}`
            : '📍 La dirección, con el barrio o alguna indicación para llegar'
    );

    return {
        texto:
            'Para mandártelo necesito dos cositas. Puedes contestarme todo junto 👇' +
            `\n\n${lineas.join('\n\n')}`,
    };
}

/**
 * Para qué se pide el teléfono, que **no es lo mismo en los dos casos**.
 *
 * En un domicilio es para que el domiciliario llame desde la puerta; en un pedido para recoger
 * es para poder avisarle cuando esté listo. Se dice el motivo de verdad y no uno genérico: un
 * bot que pide un teléfono sin explicarse parece que está recogiendo datos, y el motivo es
 * justamente lo que hace que la gente lo dé.
 */
const MOTIVO_DEL_TELEFONO = {
    [ENTREGA.DOMICILIO]: 'para que el domiciliario te llame al llegar',
    [ENTREGA.RECOGER]: 'para avisarte en cuanto esté listo',
};

function motivoDelTelefono(entrega) {
    return MOTIVO_DEL_TELEFONO[entrega] || MOTIVO_DEL_TELEFONO[ENTREGA.DOMICILIO];
}

/** Qué se le dice al cliente en cada paso. */
function pregunta(paso, datos, ctx) {
    switch (paso) {
        case PASO_PEDIDO.NOMBRE:
            return { texto: '¿A nombre de quién lo dejo? 📝' };
        case PASO_PEDIDO.ENTREGA:
            // Con el formulario encendido (solo WhatsApp, ver `formularioEntrega.js`), un botón
            // que lo abre en vez de los dos de siempre: cómo lo recibe, barrio, dirección y pago de
            // una vez. Las palabras siguen valiendo, por eso este paso las sigue leyendo.
            if (ctx?.formularioEntrega) {
                return formularioEntrega.pregunta({
                    flowId: ctx.formularioEntrega,
                    idConversacion: ctx.conversacion?.id_conversacion ?? null,
                    conMesas: (ctx.mesas || []).length > 0,
                });
            }
            // Dos botones, y sin `detalle`: con detalle el canal lo pinta como una LISTA que hay
            // que desplegar, y una elección entre dos merece un toque, no un menú.
            //
            // Las palabras siguen en el texto aunque haya botones, y no es redundancia: el botón
            // no viaja si alguien reenvía el mensaje o responde citándolo, y un canal sin
            // botones solo recibe texto. Decir las dos que valen deja abierto ese camino.
            // «Para servir» solo si el negocio tiene mesas: sin mesas no hay dónde guardarle una.
            if ((ctx?.mesas || []).length > 0) {
                return {
                    texto:
                        '¿Te lo llevamos a domicilio, pasas a recogerlo o es para servir aquí? 🛵\n\n' +
                        'Toca una opción, o escríbeme *domicilio*, *recoger* o *para servir*.',
                    opciones: [
                        { id: OPCION.ENTREGA_DOMICILIO, etiqueta: 'A domicilio 🛵' },
                        { id: OPCION.ENTREGA_RECOGER, etiqueta: 'Paso a recogerlo 🛍️' },
                        { id: OPCION.ENTREGA_SERVIR, etiqueta: 'Para servir aquí 🍽️' },
                    ],
                };
            }
            return {
                texto:
                    '¿Te lo llevamos a domicilio o pasas a recogerlo? 🛵\n\n' +
                    'Toca una opción, o escríbeme *domicilio* o *recoger*.',
                opciones: [
                    { id: OPCION.ENTREGA_DOMICILIO, etiqueta: 'A domicilio 🛵' },
                    { id: OPCION.ENTREGA_RECOGER, etiqueta: 'Paso a recogerlo 🛍️' },
                ],
            };
        case PASO_PEDIDO.TELEFONO:
            return {
                texto: `¿Me das un número de contacto? 📱 Es ${motivoDelTelefono(datos.entrega)}.`,
            };
        case PASO_PEDIDO.DIRECCION:
            return {
                texto:
                    '¿A qué dirección te lo llevamos? 🛵 Dime también si hay alguna indicación ' +
                    'para llegar.',
            };
        case PASO_PEDIDO.DATOS:
            return preguntaCombinada(datos, ctx);
        case PASO_PEDIDO.BARRIO: {
            const barrios = ctx?.barrios?.barrios || [];
            // Pocos barrios: se listan todos con su precio, como siempre. Una ciudad entera
            // cargada por comunas (~550) no cabe en un mensaje de WhatsApp: se resume por zona y
            // se le pide el nombre, que `elegirBarrio` busca.
            if (barrios.length <= MAX_BARRIOS_EN_LISTA) {
                const lista = barrios.map((b) => `• ${nombreConZona(b)} — ${enPesos(b.valor)}`).join('\n');
                return {
                    texto:
                        '¿En qué barrio estás? 📍 Esto es lo que cuesta el domicilio a cada uno:\n\n' +
                        `${lista}\n\n` +
                        'Escríbeme el tuyo, o *otro* si no aparece: el restaurante te confirma el valor.',
                };
            }
            const zonas = resumenPorZona(barrios)
                .map((z) =>
                    z.minimo === z.maximo
                        ? `• ${z.zona} — ${enPesos(z.minimo)}`
                        : `• ${z.zona} — desde ${enPesos(z.minimo)}`
                )
                .join('\n');
            return {
                texto:
                    '¿En qué barrio o vereda estás? 📍 Escríbeme el nombre y te digo lo que cuesta ' +
                    'el domicilio. Esto es lo que vale por zona:\n\n' +
                    `${zonas}\n\n` +
                    'Si no aparece, escríbeme *otro*: el restaurante te confirma el valor.',
            };
        }
        case PASO_PEDIDO.MESA: {
            const numeros = (ctx?.mesas || []).map((m) => m.numero).join(', ');
            return {
                texto:
                    '¿En qué mesa estás? 🪑 Escríbeme el número.' +
                    (numeros ? ` (Tenemos las mesas: ${numeros})` : ''),
            };
        }
        default:
            return { texto: '¿Seguimos?' };
    }
}

/**
 * Avanza al siguiente hueco, o pide la confirmación si ya no queda ninguno.
 *
 * `apertura` es la cortesía que arrastra el paso anterior («Gracias, Nicolás.»): va aquí y no
 * dentro de `pregunta` porque depende de lo que se acaba de contestar, no de lo que se va a
 * preguntar.
 */
function seguirOConfirmar(ctx, datos, pasos, { apertura = '', solicitarConfirmacion }) {
    const falta = loQueFalta(datos, ctx);

    if (falta) {
        const q = pregunta(falta, datos, ctx);
        return {
            pasos,
            respuestas: [{ ...q, texto: `${apertura}${q.texto}` }],
            variables: conMemoria(ctx.conversacion, datos.nombre ? { nombre: datos.nombre } : {}),
            tarea: tareaPedido({ ...datos, paso: falta }),
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // Ya no falta nada. **No se crea nada**: se pregunta, y el Policy Gate se niega a ejecutar
    // `tomar_pedido` sin la prueba de que el cliente dijo que sí (ADR-010).
    return solicitarConfirmacion({
        capacidad: 'tomar_pedido',
        args: {
            items: itemsParaArgumentos(datos.items),
            ...(datos.sin_descartadas ? { sin_descartadas: datos.sin_descartadas } : {}),
            cliente_nombre: datos.nombre,
            tipo_entrega: datos.entrega,
            // Solo va si existe. Un pedido para recoger no tiene dirección, y mandar la clave
            // en `undefined` la convierte en un `null` que el validador tendría que perdonar.
            ...(datos.direccion ? { direccion: datos.direccion } : {}),
            ...(datos.telefono ? { cliente_telefono: datos.telefono } : {}),
            // Solo los que aplican al tipo de entrega: un barrio en un pedido para recoger, o
            // una mesa en un domicilio, son basura que el servidor tendría que ignorar.
            ...(datos.entrega === ENTREGA.DOMICILIO && datos.id_barrio
                ? { id_barrio: datos.id_barrio }
                : {}),
            ...(datos.entrega === ENTREGA.MESA && datos.id_mesa ? { id_mesa: datos.id_mesa } : {}),
            // La nota que dejó en el paso «tus datos» de la carta (cualquier tipo de pedido; opcional). Es la misma
            // que se puede decir por chat; si ya vino de la carta no hace falta preguntarla.
            ...(datos.nota ? { nota: datos.nota } : {}),
        },
        conversacion: {
            ...ctx.conversacion,
            variables: conMemoria(ctx.conversacion, {
                nombre: datos.nombre,
                ...(datos.telefono ? { telefono: datos.telefono } : {}),
            }),
        },
        pasos,
        nivel: 'determinista',
    });
}

/**
 * Deja en `datos.items` solo las exclusiones válidas y en `datos.sin_descartadas` los nombres de
 * las que no. Si no se puede leer (el catálogo falla), las líneas se quedan como llegaron: no se
 * guarda nada sin pasar por `tomar_pedido.ejecutar`, que las vuelve a comprobar.
 */
/**
 * Lo que el cliente escribió en el bloque de la carta (nombre, dirección, nota), ANTES de la línea
 * `#P…`. Es una SUGERENCIA: se relee en la confirmación, igual que el barrio o la mesa (ADR-010 no
 * se salta por venir de un formulario en vez de una pregunta).
 *
 *  - El nombre del formulario MANDA sobre el que el bot recordaba de otras conversaciones: es lo que
 *    el cliente acaba de escribir para ESTE pedido (puede pedir a nombre de otra persona). Antes
 *    ganaba el recordado y el pedido salía a nombre equivocado.
 *  - La nota y la dirección, igual: son de este pedido.
 *  - El teléfono **solo si el canal no probó ninguno** (2026-10-12). Es la única regla de
 *    precedencia que no la decide el formulario: el número que prueba la red por la que escribe
 *    el cliente gana siempre sobre uno escrito a mano, que es lo que dice ADR-010 de la identidad.
 *    El del formulario es para el cliente que llega **sin número** (BSUID de WhatsApp): antes
 *    había que preguntárselo por chat —un mensaje del bot, uno suyo y a veces un turno de IA— y,
 *    cuando el modelo se lo saltaba, el restaurante recibía un domicilio sin nadie a quien llamar.
 *    Sigue siendo dato de CONTACTO: viaja como `cliente_telefono` y no autoriza nada.
 */
function sembrarDatosCliente(ctx, datos) {
    const bloque = datosCliente.leerBloque(ctx.texto);
    if (bloque.nombre) datos.nombre = bloque.nombre;
    if (bloque.direccion) datos.direccion = bloque.direccion;
    if (bloque.nota) datos.nota = bloque.nota;
    if (bloque.telefono && !ctx.telefonoProbado) datos.telefono = bloque.telefono;
}

async function sembrarExclusiones(ctx, datos) {
    if (!datos.items.some((i) => i.exclusiones?.length)) return;
    const resolver = ctx.catalogo?.resolverExclusiones;
    if (!resolver) return;
    try {
        const resultado = await resolver({
            idNegocio: ctx.idNegocio,
            lineas: datos.items.map((i) => ({ id_producto: i.id_producto, ids: i.exclusiones || [] })),
        });
        const descartadas = [];
        datos.items = datos.items.map((i, k) => {
            const { exclusiones: _viejas, ...resto } = i;
            const validas = resultado[k].validas.map((v) => v.id_ingrediente);
            descartadas.push(...resultado[k].descartadas);
            return validas.length ? { ...resto, exclusiones: validas } : resto;
        });
        const nombres = exclusiones.nombresLegibles(descartadas);
        if (nombres) datos.sin_descartadas = nombres;
    } catch (error) {
        console.warn(`[restaurante] no se pudieron comprobar los ingredientes quitados: ${error.message}`);
    }
}

/**
 * Los items del pedido tal como los recibe `tomar_pedido`: `exclusiones` viaja como `sin: "12.15"`
 * y las adiciones como `con: "31.31.40"` (el motor de argumentos no anida listas).
 */
function itemsParaArgumentos(items) {
    return (items || []).map(({ exclusiones: quitadas, adiciones: agregadas, ...resto }) => ({
        ...resto,
        ...(quitadas?.length ? { sin: exclusiones.escribirSin(quitadas) } : {}),
        ...(agregadas?.length ? { con: adiciones.escribirCon(agregadas) } : {}),
    }));
}

/**
 * Vuelca en `datos` la modalidad, el barrio y la mesa que el cliente eligió en la carta.
 *
 * Nada de esto se acepta a ciegas:
 *  - `m=R` → para recoger. `m=D` → domicilio. `m=L` → mesa, **solo si el negocio tiene mesas
 *    activas**; si no, se ignora y se pregunta como siempre.
 *  - Domicilio con barrio (`z=<id>`): se relee; si ya no existe o es de otro negocio
 *    (`ZONA_INVALIDA`) NO se pierde el carrito: se vuelve a preguntar el barrio. `z=0` o sin `z` =
 *    «otro barrio»: no hay valor, y se le avisa que el restaurante se lo confirma.
 *  - Mesa (`t=<id>`): igual con `MESA_INVALIDA`; se vuelve a preguntar la mesa.
 * Un código sin modalidad (los de antes) no toca nada: se pregunta domicilio o recoger.
 */
async function sembrarEleccionDelMenu(ctx, pedido, datos) {
    const pasosEleccion = [];
    let avisoEleccion = '';
    const catalogo = ctx.catalogo;

    if (pedido.modalidad === ENTREGA.RECOGER) {
        datos.entrega = ENTREGA.RECOGER;
    } else if (pedido.modalidad === ENTREGA.DOMICILIO) {
        datos.entrega = ENTREGA.DOMICILIO;
        if (ctx.barrios?.habilitado && (ctx.barrios.barrios || []).length > 0) {
            if (pedido.idBarrio > 0) {
                try {
                    const barrio = await catalogo.resolverBarrio({
                        idNegocio: ctx.idNegocio,
                        idBarrio: pedido.idBarrio,
                    });
                    datos.id_barrio = barrio.id_barrio;
                    datos.barrio_nombre = nombreConZona(barrio);
                    pasosEleccion.push(paso('pedido_barrio_del_menu', { id_barrio: barrio.id_barrio }));
                } catch (error) {
                    if (error.code !== 'ZONA_INVALIDA') throw error;
                    // Se pregunta de nuevo (`necesitaBarrio` seguirá siendo verdad).
                    avisoEleccion = 'Ese barrio no aparece en mi lista de domicilios. ';
                    pasosEleccion.push(paso('pedido_barrio_invalido', { id_barrio: pedido.idBarrio }));
                }
            } else {
                datos.barrio_otro = true;
                avisoEleccion = 'El valor del domicilio te lo confirma el restaurante. ';
                pasosEleccion.push(paso('pedido_barrio_otro'));
            }
        }
    } else if (pedido.modalidad === ENTREGA.MESA && (ctx.mesas || []).length > 0) {
        datos.entrega = ENTREGA.MESA;
        if (pedido.idMesa) {
            try {
                const mesa = await catalogo.resolverMesa({
                    idNegocio: ctx.idNegocio,
                    idMesa: pedido.idMesa,
                });
                datos.id_mesa = mesa.id_mesa;
                datos.mesa_nombre = mesa.nombre;
                pasosEleccion.push(paso('pedido_mesa_del_menu', { id_mesa: mesa.id_mesa }));
            } catch (error) {
                if (error.code !== 'MESA_INVALIDA') throw error;
                avisoEleccion = 'No encontré esa mesa. ';
                pasosEleccion.push(paso('pedido_mesa_invalida', { id_mesa: pedido.idMesa }));
            }
        }
    }

    return { avisoEleccion, pasosEleccion };
}

/**
 * Empieza el pedido del menú.
 *
 * ## El negocio del código se comprueba
 *
 * El código lleva el id del negocio donde se armó. Si no coincide con este, se dice: alguien
 * armó el carrito en la carta de un restaurante y lo mandó al WhatsApp de otro. Sin comprobarlo,
 * el pedido se crearía con ids de productos que aquí son otra cosa — o no existen.
 *
 * ## Lo que ya se sabe no se pregunta
 *
 * El nombre vive en `variables` (memoria larga) y el teléfono lo prueba el canal. Preguntar dos
 * veces lo que ya te dijeron es lo que hace que un bot parezca un formulario.
 */
async function recibirPedidoDelMenu(ctx, pedido, { solicitarConfirmacion }) {
    if (pedido.idNegocio !== ctx.idNegocio) {
        return {
            pasos: [
                paso('pedido_de_otro_negocio', { venia_de: pedido.idNegocio, aqui: ctx.idNegocio }),
            ],
            respuestas: [
                'Ese pedido lo armaste en la carta de otro negocio, así que no puedo tomarlo aquí. ' +
                    `Abre el menú de ${ctx.negocio.tratamiento} y vuelve a elegir: ${enlaceDelMenu(ctx.idNegocio)}`,
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: null,
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    const previas = ctx.conversacion.variables || {};
    const cuantos = unidades(pedido.items);
    const datos = {
        items: pedido.items,
        // Lo dicho en la conversación, la ficha del cliente o el perfil de WhatsApp: el primero que
        // haya. Se enseña en la confirmación, donde el cliente puede corregirlo («a nombre de…»).
        ...(ctx.identidad?.nombre || previas.nombre
            ? { nombre: ctx.identidad?.nombre || previas.nombre }
            : {}),
    };

    // Lo que escribió en el paso «tus datos» de la carta: nombre, teléfono, dirección, nota.
    // Va ANTES que las exclusiones y la elección: si ya trae el nombre, esas dos secciones no
    // tienen que repetir la pregunta por él.
    sembrarDatosCliente(ctx, datos);

    // Los ingredientes que quitó en la carta se RELEEN: se queda solo lo que de verdad se puede
    // quitar de ese plato, y lo descartado se guarda para decírselo en la confirmación.
    await sembrarExclusiones(ctx, datos);

    // Lo que el cliente ya eligió en la carta (`~m`, `~z`, `~t` del código) para no volver a
    // preguntárselo. Son sugerencias: el barrio y la mesa se RELEEN de la base aquí —para
    // enseñarle el valor real— y otra vez en `tomar_pedido.ejecutar`, que es quien manda.
    const { avisoEleccion, pasosEleccion } = await sembrarEleccionDelMenu(ctx, pedido, datos);

    return seguirOConfirmar(
        ctx,
        datos,
        [
            paso('pedido_del_menu_recibido', { items: pedido.items.length, unidades: cuantos }),
            ...pasosEleccion,
        ],
        {
            apertura:
                `¡Listo, ya tengo tu pedido! ${cuantos === 1 ? 'Es 1 producto' : `Son ${cuantos} productos`}` +
                `${datos.nombre ? `, a nombre de ${datos.nombre}` : ''}. ${avisoEleccion}`,
            solicitarConfirmacion,
        }
    );
}

/**
 * Sigue el pedido con lo que acaba de escribir el cliente.
 *
 * Solo se llega aquí con la tarea abierta, o sea con los productos ya guardados. Lo que se lee
 * es texto libre —un nombre, una dirección— y **casi** no se valida: quien sabe si
 * «Carrera 3e 19 a» es una dirección real es el domiciliario, no una expresión regular. Los
 * límites de longitud los pone la capacidad, que es donde tienen que estar.
 *
 * El «casi» lo puso el 2026-08-27: el dueño escribió una broma donde iba la dirección y el
 * pedido se creó con ella. Desde entonces `pareceDireccion` **repregunta una vez** cuando lo
 * que llega no se parece de lejos a una dirección —y acepta a la segunda—. El guardarraíl avisa;
 * no manda.
 */
function seguirPedido(ctx, { solicitarConfirmacion }) {
    const datos = datosDelPedido(ctx.conversacion);
    const dicho = ultimaLinea(ctx.texto).trim();

    // El formulario de entrega respondido: trae varias respuestas a la vez y se lee entero,
    // antes que nada que mire solo la última línea (unas indicaciones que digan «cancelar» no
    // cancelan el pedido).
    const formulario = formularioEntrega.leer(ctx.texto);
    if (formulario) return aplicarFormulario(ctx, datos, formulario, { solicitarConfirmacion });

    // «Cancelar» durante el pedido significa cancelar el pedido, no salir de la conversación.
    if (esComando(ctx.texto, COMANDO.CANCELAR)) {
        return {
            pasos: [paso('pedido_cancelado', { paso: datos.paso ?? null })],
            respuestas: ['Listo, no te lo apunto. Si quieres pedir otra cosa, dime 😊'],
            variables: conMemoria(ctx.conversacion),
            tarea: null,
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    if (!dicho) {
        const q = pregunta(datos.paso, datos, ctx);
        return {
            pasos: [paso('pedido_dato_vacio', { paso: datos.paso ?? null })],
            respuestas: [q],
            variables: conMemoria(ctx.conversacion),
            tarea: tareaPedido(datos),
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    // Lo que llega no siempre es la respuesta. «¿Y cuánto sale el domicilio?» no es un nombre
    // ni una dirección, y apuntarlo como tal deja un pedido a nombre de una pregunta.
    //
    // Se repregunta, y **siempre se ofrece la salida**. La tarea NO se suelta sola: soltarla
    // dejaría el carrito huérfano —el modelo no ve la tarea— y el cliente tendría que armarlo
    // otra vez. Y callarse tampoco es opción: en este sistema el modo de fallo caro es el
    // silencio, no la insistencia. Quien quiera irse escribe «cancelar», que está en el mensaje.
    if (/[?¿]/.test(dicho)) {
        const q = pregunta(datos.paso, datos, ctx);
        const cortesia =
            Number(datos.repreguntas || 0) < 1
                ? 'Ahora te cuento 😊 '
                : 'Perdona, es que sin eso no puedo mandarlo. ';
        return {
            pasos: [paso('pedido_respuesta_no_era', { paso: datos.paso })],
            respuestas: [
                {
                    ...q,
                    texto: `${cortesia}${q.texto} Si prefieres dejarlo, escríbeme *cancelar*.`,
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: tareaPedido({ ...datos, repreguntas: Number(datos.repreguntas || 0) + 1 }),
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    const conLoDicho = { ...datos, repreguntas: 0 };
    let apertura = '';

    // ── La respuesta que trae varias cosas a la vez ────────────────────────────────────────
    //
    // Se lee lo que se entienda y se guarda; lo que no, `seguirOConfirmar` lo vuelve a preguntar
    // —y ya de a uno, porque quedará uno solo—. Nunca se descarta lo que sí llegó: hacerle
    // repetir la dirección porque no se entendió el teléfono sería castigarle por habernos
    // contestado.
    if (datos.paso === PASO_PEDIDO.DATOS) {
        const faltan = huecosDelCliente(datos, ctx);
        const leido = interpretarDatos(dicho, { faltan });

        if (Object.keys(leido).length === 0) {
            const q = pregunta(PASO_PEDIDO.DATOS, datos, ctx);
            return {
                pasos: [paso('pedido_datos_no_entendidos', { faltan })],
                respuestas: [
                    {
                        ...q,
                        texto: `Perdona, no logré sacar los datos de ahí 🙈\n\n${q.texto}`,
                    },
                ],
                variables: conMemoria(ctx.conversacion),
                tarea: tareaPedido(datos),
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        Object.assign(conLoDicho, leido);
        // La dirección leída de un mensaje mezclado pasa por el mismo filtro que la suelta: si
        // no se parece a una dirección no se apunta, y se vuelve a preguntar sola.
        if (leido.direccion && !pareceDireccion(leido.direccion)) delete conLoDicho.direccion;

        return seguirOConfirmar(
            ctx,
            conLoDicho,
            [paso('pedido_datos_recibidos', { leidos: Object.keys(leido), faltaban: faltan })],
            { apertura: '¡Anotado! ', solicitarConfirmacion }
        );
    }

    switch (datos.paso) {
        case PASO_PEDIDO.NOMBRE:
            conLoDicho.nombre = dicho;
            // Dos palabras de cortesía: la diferencia entre un formulario y alguien atendiendo.
            apertura = `Gracias, ${dicho.split(/\s+/)[0]}. `;
            break;
        case PASO_PEDIDO.ENTREGA: {
            const entrega = leerEntrega(dicho);
            // Se repregunta las veces que haga falta, y **no se elige por defecto**: un
            // domicilio supuesto es una moto saliendo a una dirección que nadie dio.
            if (!entrega) {
                const q = pregunta(PASO_PEDIDO.ENTREGA, datos, ctx);
                return {
                    pasos: [paso('pedido_entrega_no_entendida', { dijo: dicho.slice(0, 40) })],
                    respuestas: [
                        {
                            ...q,
                            texto:
                                'Perdona, no me quedó claro 🙈 ' +
                                `${q.texto}\n\nSi prefieres dejarlo, escríbeme *cancelar*.`,
                        },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido(datos),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            // «Para servir» en un negocio sin mesas: no hay dónde guardarle una. Se dice y se
            // vuelve a preguntar con las opciones que sí hay.
            if (entrega === ENTREGA.MESA && (ctx.mesas || []).length === 0) {
                const q = pregunta(PASO_PEDIDO.ENTREGA, datos, ctx);
                return {
                    pasos: [paso('pedido_servir_sin_mesas')],
                    respuestas: [
                        { ...q, texto: `Por aquí solo puedo tomarlo a domicilio o para recoger 🙏\n\n${q.texto}` },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido(datos),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            conLoDicho.entrega = entrega;
            if (entrega === ENTREGA.MESA) conLoDicho.para_servir = true;
            apertura =
                entrega === ENTREGA.RECOGER
                    ? '¡Listo, te lo dejamos preparado! '
                    : entrega === ENTREGA.MESA
                      ? '¡Listo, te guardamos una mesa! '
                      : '¡De una! ';
            break;
        }
        case PASO_PEDIDO.BARRIO: {
            const barrio = elegirBarrio(dicho, ctx.barrios?.barrios || [], datos.barrio_opciones);
            // Varios con ese nombre («San José» está en tres zonas): se pregunta cuál, numerados.
            if (barrio && barrio.ambiguos) {
                const opciones = barrio.ambiguos.slice(0, MAX_OPCIONES_BARRIO);
                const lista = opciones
                    .map((b, k) => `${k + 1}. ${nombreConZona(b)} — ${enPesos(b.valor)}`)
                    .join('\n');
                return {
                    pasos: [paso('pedido_barrio_ambiguo', { dijo: dicho.slice(0, 40), opciones: opciones.length })],
                    respuestas: [
                        {
                            texto:
                                `Tengo varios con ese nombre 📍 ¿Cuál es el tuyo?\n\n${lista}\n\n` +
                                'Escríbeme el número, o *otro* si no es ninguno.',
                        },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido({ ...datos, barrio_opciones: opciones.map((b) => b.id_barrio) }),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            if (barrio === null) {
                const q = pregunta(PASO_PEDIDO.BARRIO, datos, ctx);
                return {
                    pasos: [paso('pedido_barrio_no_entendido', { dijo: dicho.slice(0, 40) })],
                    respuestas: [
                        {
                            ...q,
                            texto: `Perdona, no encontré ese barrio 🙈\n\n${q.texto}`,
                        },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido(datos),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            delete conLoDicho.barrio_opciones;
            if (barrio === OTRO_BARRIO) {
                conLoDicho.barrio_otro = true;
                apertura = 'Listo, el restaurante te confirma el valor del domicilio. ';
            } else {
                conLoDicho.id_barrio = barrio.id_barrio;
                conLoDicho.barrio_nombre = nombreConZona(barrio);
                apertura = `${nombreConZona(barrio)} (${enPesos(barrio.valor)} de domicilio), anotado. `;
            }
            break;
        }
        case PASO_PEDIDO.MESA: {
            const mesa = elegirMesa(dicho, ctx.mesas || []);
            if (!mesa) {
                const q = pregunta(PASO_PEDIDO.MESA, datos, ctx);
                return {
                    pasos: [paso('pedido_mesa_no_entendida', { dijo: dicho.slice(0, 40) })],
                    respuestas: [
                        { ...q, texto: `Perdona, no encontré esa mesa 🙈\n\n${q.texto}` },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido(datos),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            conLoDicho.id_mesa = mesa.id_mesa;
            conLoDicho.mesa_nombre = mesa.nombre;
            apertura = `Mesa ${mesa.numero}, anotado. `;
            break;
        }
        case PASO_PEDIDO.TELEFONO: {
            // Solo el número; lo que venga detrás es una nota para el local. Zona Burger,
            // 2026-10-04: «3169932352 , porfa es que pago es con tarjeta» se guardó entero como
            // teléfono, `tomar_pedido` lo rechazó por largo y el cliente leyó un error técnico.
            const tel = leerTelefono(dicho);
            if (tel) {
                conLoDicho.telefono = tel;
                const resto = dicho.replace(CELULAR_CO, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim();
                if (resto.split(/\s+/).filter((p) => /[a-záéíóúñ]{2,}/i.test(p)).length >= 2) {
                    conLoDicho.nota = [datos.nota, resto].filter(Boolean).join('. ');
                }
            } else {
                conLoDicho.telefono = dicho;
            }
            break;
        }
        case PASO_PEDIDO.DIRECCION:
            // Si no se parece a una dirección se pregunta otra vez, **una sola**. A la segunda
            // se apunta lo que diga: el cliente manda sobre su propia dirección, y bloquearle
            // el pedido por no gustarle a una expresión regular sería cambiar una venta por una
            // discusión. Queda el rastro para que se vea desde fuera cuál pasó así.
            if (!pareceDireccion(dicho) && !datos.direccion_dudosa) {
                const q = pregunta(PASO_PEDIDO.DIRECCION, datos, ctx);
                return {
                    pasos: [paso('pedido_direccion_dudosa', { largo: dicho.length })],
                    respuestas: [
                        {
                            ...q,
                            texto:
                                'Perdona, no me quedó clara la dirección \uD83D\uDE45\u200D♂️ ' +
                                '¿Me la escribes con la calle y el número? ' +
                                'Si prefieres dejarlo, escríbeme *cancelar*.',
                        },
                    ],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido({ ...datos, direccion_dudosa: true }),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            conLoDicho.direccion = dicho;
            // Se anota que entró tras insistir: si un domicilio sale mal, esto lo explica.
            if (!pareceDireccion(dicho)) conLoDicho.direccion_forzada = true;
            delete conLoDicho.direccion_dudosa;
            break;
        default:
            break;
    }

    return seguirOConfirmar(ctx, conLoDicho, [paso('pedido_dato_recibido', { paso: datos.paso })], {
        apertura,
        solicitarConfirmacion,
    });
}

/**
 * Lo que llegó en el formulario de entrega, aplicado al pedido abierto.
 *
 * Sirve en cualquier paso —el cliente puede abrir el formulario aunque ya se le haya preguntado
 * otra cosa—, y lo que no traiga se sigue preguntando como siempre (`seguirOConfirmar`).
 *
 *  - **Entrega**: el id del formulario. Uno que no se reconozca no se supone: se repregunta.
 *  - **Indicaciones** van pegadas a la dirección, que es lo que lee el domiciliario.
 *  - **Pago** va en la nota del pedido: el pedido no tiene columna de forma de pago a la hora de
 *    tomarlo (se elige al cobrar), y la nota es lo que caja y despacho ya leen.
 *  - **Barrio**: si el negocio cobra por barrio, se resuelve con el mismo paso del barrio —un
 *    nombre repetido se pregunta numerado, uno que no existe se repregunta—; si no, se pega a la
 *    dirección.
 */
const ENTREGA_DEL_FORMULARIO = {
    [formularioEntrega.ENTREGA.DOMICILIO]: ENTREGA.DOMICILIO,
    [formularioEntrega.ENTREGA.RECOGER]: ENTREGA.RECOGER,
    [formularioEntrega.ENTREGA.SERVIR]: ENTREGA.MESA,
};

/**
 * La nota con «Pago: …» puesto, en vez del que ya tuviera: un formulario enviado dos veces con
 * otra forma de pago no deja «Pago: Nequi. Pago: Efectivo» en la nota de caja.
 */
function notaConPago(nota, pago) {
    const sinPago = String(nota || '')
        .split(/\.\s+/)
        .map((t) => t.trim().replace(/\.$/, ''))
        .filter((t) => t && !/^pago:/i.test(t));
    return [...sinPago, `Pago: ${pago}`].join('. ');
}

/** La entrega que eligió en el formulario (`DOMICILIO`, `LLEVAR`, `MESA`) o `null`. */
function entregaDelFormulario(formulario) {
    return (
        ENTREGA_DEL_FORMULARIO[String(formulario?.entrega || '').toLowerCase()] ||
        leerEntrega(formulario?.entrega || '')
    );
}

function aplicarFormulario(ctx, datos, formulario, { solicitarConfirmacion }) {
    const entrega = entregaDelFormulario(formulario);
    const marca = paso('pedido_formulario_recibido', { campos: Object.keys(formulario) });

    if (!entrega || (entrega === ENTREGA.MESA && (ctx.mesas || []).length === 0)) {
        const q = pregunta(PASO_PEDIDO.ENTREGA, datos, ctx);
        return {
            pasos: [marca, paso('pedido_formulario_sin_entrega')],
            respuestas: [{ ...q, texto: `Perdona, no me quedó claro cómo lo recibes 🙈 ${q.texto}` }],
            variables: conMemoria(ctx.conversacion),
            tarea: tareaPedido({ ...datos, paso: PASO_PEDIDO.ENTREGA }),
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    const conLoDicho = { ...datos, repreguntas: 0, entrega };
    delete conLoDicho.direccion_dudosa;
    if (entrega === ENTREGA.MESA) conLoDicho.para_servir = true;
    if (formulario.pago) {
        conLoDicho.nota = notaConPago(datos.nota, formulario.pago);
    }

    if (entrega === ENTREGA.DOMICILIO) {
        // El teléfono del formulario es de CONTACTO, como el escrito: solo hace falta si el canal
        // no probó ninguno, y no autoriza nada.
        const tel = leerTelefono(formulario.telefono);
        if (tel && !ctx.telefonoProbado) conLoDicho.telefono = tel;
        const direccion = [formulario.direccion, formulario.indicaciones].filter(Boolean).join(' — ');
        const porBarrio = Boolean(ctx?.barrios?.habilitado) && (ctx.barrios.barrios || []).length > 0;
        if (direccion) {
            conLoDicho.direccion =
                formulario.barrio && !porBarrio ? `${direccion}, ${formulario.barrio}` : direccion;
        }
        // El barrio pasa por el paso de siempre, con lo que el cliente escribió como respuesta.
        if (formulario.barrio && necesitaBarrio(conLoDicho, ctx)) {
            const resultado = seguirPedido(
                {
                    ...ctx,
                    texto: formulario.barrio,
                    conversacion: {
                        ...ctx.conversacion,
                        tarea_datos: { ...conLoDicho, paso: PASO_PEDIDO.BARRIO },
                    },
                },
                { solicitarConfirmacion }
            );
            return Promise.resolve(resultado).then((r) => ({ ...r, pasos: [marca, ...(r.pasos || [])] }));
        }
    } else {
        // Quien no pide domicilio no deja dirección ni barrio, aunque los hubiera dicho antes.
        delete conLoDicho.direccion;
        delete conLoDicho.id_barrio;
        delete conLoDicho.barrio_nombre;
        delete conLoDicho.barrio_otro;
    }

    return seguirOConfirmar(ctx, conLoDicho, [marca], { apertura: '¡Anotado! ', solicitarConfirmacion });
}

/**
 * El formulario de entrega llega con un resumen YA esperando el sí.
 *
 * Pasa porque el botón del formulario sigue vivo en el chat: el cliente escribió «domicilio» a
 * mano, vio el resumen, y después tocó el formulario —o lo envió dos veces—. Hasta el
 * 2026-10-16 sus líneas se anotaban en la nota de cocina («Entrega: recoger») y el resumen
 * seguía igual: un domicilio esperando el sí con una nota que decía lo contrario, y el siguiente
 * «sí» mandaba la moto. Es el mismo error que ORD-7877, por otra puerta.
 *
 *  - **Lo mismo que ya decía el resumen** (misma entrega y, a domicilio, misma dirección): se
 *    enseña el resumen otra vez, con la forma de pago en la nota si es nueva. Nada más.
 *  - **Otra cosa**: el resumen ya no es lo que quiere. Se suelta —no se ha enviado nada— y el
 *    modelo rehace el pedido con lo anotado y el formulario, que pasa otra vez por las guardias.
 */
async function formularioConResumenEsperando(ctx, formulario) {
    const datos = ctx.conversacion.tarea_datos || {};
    const args = datos.args || {};
    const pendiente = args.tipo_entrega ?? null;
    const entrega = entregaDelFormulario(formulario);
    const marca = paso('confirmacion_formulario_recibido', { de: pendiente, a: entrega });

    const mismaDireccion =
        entrega !== ENTREGA.DOMICILIO ||
        (Boolean(formulario.direccion) &&
            normalizar(args.direccion || '').includes(normalizar(formulario.direccion)));

    // Lo que espera no es un pedido (anular uno, añadirle productos): el formulario no le dice
    // nada. Se pide el sí otra vez, sin anotar sus líneas en ninguna parte.
    if (!pendiente) {
        return {
            pasos: [marca, paso('confirmacion_formulario_ignorado', { capacidad: datos.capacidad ?? null })],
            respuestas: [
                {
                    texto: 'Todavía no he enviado nada 🙏 ¿Confirmo lo de arriba? Respóndeme sí o no.',
                    opciones: [
                        { id: 'si', etiqueta: 'Sí, confirmo' },
                        { id: 'no', etiqueta: 'No' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: confirmacion.TAREA, datos },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    if (entrega === pendiente && mismaDireccion) {
        const pagoNuevo =
            Boolean(formulario.pago) &&
            !normalizar(args.nota || '').includes(normalizar(`Pago: ${formulario.pago}`));
        const nuevos = {
            ...datos,
            args: pagoNuevo ? { ...args, nota: notaConPago(args.nota, formulario.pago) } : args,
            pregunta_abierta: false,
            // El cliente ve el resumen otra vez: el siguiente «sí» es a ESTE.
            preguntado_en: ctx.ahora().toISOString(),
        };
        return {
            pasos: [marca, paso('confirmacion_formulario_igual', { pago_nuevo: pagoNuevo })],
            respuestas: [
                {
                    texto:
                        `Ya tenía esos datos 👍${pagoNuevo ? ` Anoté que pagas con ${formulario.pago}.` : ''}\n\n` +
                        `${await confirmacion.textoDePregunta(nuevos.capacidad, nuevos.args, {
                            idNegocio: ctx.conversacion.id_negocio ?? null,
                        })} Respóndeme sí o no.`,
                    opciones: [
                        { id: 'si', etiqueta: 'Sí, confirmo' },
                        { id: 'no', etiqueta: 'No' },
                    ],
                },
            ],
            variables: conMemoria(ctx.conversacion),
            tarea: { nombre: confirmacion.TAREA, datos: nuevos },
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    }

    const antes = ENTREGA_EN_PALABRAS[pendiente] ? ` (${ENTREGA_EN_PALABRAS[pendiente]})` : '';
    return {
        ...delegar(ctx),
        soltarTarea: true,
        notaParaElModelo:
            `[Nota del sistema, no del cliente: había un pedido esperando el sí${antes} y el cliente ` +
            'acaba de enviar el formulario de entrega con otros datos (arriba). Esa confirmación se ' +
            'DESCARTÓ: no se ha enviado nada. Vuelve a llamar la herramienta del pedido con TODO lo ' +
            'que estaba anotado y lo que dice el formulario: cómo lo recibe, y si es a domicilio el ' +
            'barrio (en `barrio`), la dirección y las indicaciones; la forma de pago va en la nota como «Pago: …». ' +
            'Si es para recoger o para servir, sin dirección. Lo que estaba anotado: ' +
            `${JSON.stringify(args)}]`,
        pasos: [marca, paso('confirmacion_soltada_por_formulario')],
    };
}

/**
 * Un teléfono colombiano dentro de un texto que también lleva una dirección.
 *
 * ## Por qué solo el celular, y no «cualquier grupo de dígitos»
 *
 * Porque una dirección **está llena de números**: «Calle 45 #12-30 apto 502» tiene cuatro
 * grupos. Un patrón laxo se llevaría el primero y dejaría al domiciliario llamando a un número
 * inventado, que es peor que no tener número — el paso del teléfono existe precisamente para
 * que alguien pueda llamar.
 *
 * Así que se busca solo lo inequívoco: un celular colombiano, diez dígitos empezando por 3, con
 * o sin `+57` delante y con los separadores que la gente escribe. Un fijo de siete dígitos se
 * queda fuera a propósito: es indistinguible de un número de calle, y prefiero repreguntar.
 */
const CELULAR_CO = /(?:\+?57[\s.-]?)?(3\d{2})[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/;

function leerTelefono(texto) {
    const m = CELULAR_CO.exec(String(texto || ''));
    if (!m) return null;
    return `${m[1]}${m[2]}${m[3]}`;
}

/** Cuánto vale un «sí» de más tras confirmar: el tiempo de tocar el segundo botón, no más. */
const MINUTOS_SI_REPETIDO = 5;

/** Lo que devuelve `elegirBarrio` cuando el cliente dice que su barrio no está en la lista. */
const OTRO_BARRIO = Symbol('otro_barrio');

/** Hasta cuántos barrios se listan enteros al preguntar; con más, se resume por zona. */
const MAX_BARRIOS_EN_LISTA = 25;
/** Cuántos candidatos se le dan a elegir cuando el nombre no basta. */
const MAX_OPCIONES_BARRIO = 8;

/**
 * El barrio que nombra el cliente, entre los que el negocio atiende.
 *
 * Devuelve el barrio, `OTRO_BARRIO` («otro», «no aparece»…) o `null` si no se entiende. Compara
 * sin tildes ni mayúsculas y acepta que diga solo una parte («Poblado» por «El Poblado») siempre
 * que sea **una sola coincidencia**: con dos posibles no se elige, se vuelve a preguntar. Elegir
 * por el cliente un barrio equivocado es cobrarle un domicilio que no es.
 */
function elegirBarrio(texto, barrios, opciones = null) {
    const t = claveBarrio(texto);
    if (!t) return null;

    // Contestando a «¿cuál de estos?»: por número («2») o por la zona («el de la comuna 1»).
    if (Array.isArray(opciones) && opciones.length > 0) {
        const pool = opciones.map((id) => barrios.find((b) => b.id_barrio === id)).filter(Boolean);
        const numero = /^(?:el |la |opcion |numero )?(\d{1,2})$/.exec(t);
        if (numero && pool[Number(numero[1]) - 1]) return pool[Number(numero[1]) - 1];
        const porZona = pool.filter((b) => b.zona && contieneFrase(t, claveBarrio(b.zona)));
        if (porZona.length === 1) return porZona[0];
    }

    // «San José comuna 1»: el nombre y la zona en la misma frase.
    const conZona = barrios.filter(
        (b) => b.zona && contieneFrase(t, claveBarrio(b.nombre)) && contieneFrase(t, claveBarrio(b.zona))
    );
    if (conZona.length === 1) return conZona[0];

    // Sin «barrio» delante: «barrio betania» y «b/ betania» son «betania».
    const sinPrefijo = t.replace(PREFIJO_BARRIO, '').trim() || t;
    const exactos = barrios.filter((b) => claveBarrio(b.nombre) === sinPrefijo);
    if (exactos.length === 1) return exactos[0];
    if (exactos.length > 1) return { ambiguos: exactos };
    if (/^(otro|otra|ninguno|ninguna)\b|\b(no aparece|no esta|no sale|otro barrio)\b/.test(t)) {
        return OTRO_BARRIO;
    }
    if (sinPrefijo.length < 3) return null;
    let parciales = barrios.filter((b) => {
        const n = claveBarrio(b.nombre);
        return n.includes(sinPrefijo) || contieneFrase(sinPrefijo, n);
    });
    // «corazon de jesus 2» contiene a «Corazón De Jesús» y a «Corazón De Jesús II»: el que el
    // cliente escribió entero gana. Elegir el corto era cobrar el domicilio de otra comuna.
    const enteros = parciales.filter((b) => contieneFrase(sinPrefijo, claveBarrio(b.nombre)));
    if (enteros.length > 0) parciales = soloLosMasLargos(enteros);
    // «Torres de San Luis» en el campo del barrio es un conjunto, no la vereda San Luis.
    parciales = parciales.filter((b) => !soloComoConjunto(texto, b));
    if (parciales.length === 1) return parciales[0];
    // Pocos candidatos: se le dan a elegir. Muchos («la»): mejor que lo escriba completo.
    if (parciales.length > 1 && parciales.length <= MAX_OPCIONES_BARRIO) return { ambiguos: parciales };
    return null;
}

/**
 * El barrio que aparece DENTRO de un texto libre —la dirección o la nota de un pedido—, o `null`.
 *
 * Pregonchos, 2026-10-16: el modelo recibe «Barrio: Corazón de jesus» del formulario y lo copia en
 * la dirección («Mz 1 cs 24, Corazón de jesus») o en la nota («Barrio: Betania»), pero no en el
 * campo del barrio: el domicilio salía en $0. Copiar un dato de un sitio a otro no se le deja al
 * modelo. Solo cuenta un nombre entero, y uno solo: si caben dos («Avenida Boyacá» de las comunas
 * 1 y 2) y el texto no dice la comuna, no se elige — mejor $0 para que el cajero lo ajuste que
 * cobrar el domicilio de otro barrio. Un nombre dentro de otro que también aparece («Praga» en
 * «Niño Jesús de Praga») cede ante el largo.
 */
function barrioEnTexto(texto, barrios) {
    const t = claveBarrio(texto);
    if (!t || !Array.isArray(barrios) || barrios.length === 0) return null;
    // ¿Va justo después de «barrio» (con o sin su artículo)?
    const marcado = (b) => {
        const sinArticulo = claveBarrio(b.nombre).replace(ARTICULO, '');
        const escapado = sinArticulo.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
        return new RegExp(`(^|[^a-z0-9])${MARCA_BARRIO} (?:(?:el|la|los|las) )?${escapado}([^a-z0-9]|$)`).test(t);
    };
    let hallados = barrios.filter((b) => {
        const n = claveBarrio(b.nombre);
        // «Centro» suelto es un sitio («frente al centro comercial»), no el barrio: solo cuenta
        // con «barrio» delante. Igual un nombre sin su artículo («barrio pilar» por «El Pilar»).
        if (NOMBRES_DE_SITIO.has(n)) return marcado(b);
        if (marcado(b)) return true;
        // «Torres de San Luis», «Hotel casa Madrigal», «Condominio mirador de San Andrés»: el
        // conjunto se llama como un barrio, pero no dice que esté en él (San Luis es una vereda de
        // La Laguna). El cliente vería «Domicilio (San Luis)» y le parecería bien: no se elige.
        return contieneFrase(t, n) && !nombreDeConjunto(t, n);
    });
    hallados = soloLosMasLargos(hallados);
    if (hallados.length > 1) {
        // «barrio centro atrás de san Andresito»: el que va después de «barrio» es el barrio.
        const conMarca = hallados.filter(marcado);
        if (conMarca.length > 0) hallados = conMarca;
    }
    if (hallados.length > 1) {
        const conZona = hallados.filter((b) => b.zona && contieneFrase(t, claveBarrio(b.zona)));
        if (conZona.length > 0) hallados = conZona;
    }
    return hallados.length === 1 ? hallados[0] : null;
}

/** Quita los que son parte de otro nombre que también está («Praga» dentro de «Niño Jesús De Praga»). */
function soloLosMasLargos(lista) {
    return lista.filter((b) => {
        const corto = claveBarrio(b.nombre);
        return !lista.some((o) => {
            const largo = claveBarrio(o.nombre);
            return largo.length > corto.length && contieneFrase(largo, corto);
        });
    });
}

/**
 * Cómo se compara un nombre de barrio: sin tildes, minúsculas, la puntuación como espacio y los
 * números como cifras. El catálogo de Pasto dice «Quito López III», «Chambú II», «Tamasagra I», y
 * los clientes escriben «quito López 3», «chambu 2», «quito lopez dos» (Zona Burger, 2026-10).
 * «el.Prado» y «B/la florida» también (la barra y el punto separan palabras).
 */
const NUMERAL = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', dos: '2', tres: '3', cuatro: '4', cinco: '5' };
function claveBarrio(texto) {
    return normalizar(texto || '')
        .replace(/[^a-z0-9ñ]+/g, ' ')
        .trim()
        .split(' ')
        .map((p) => NUMERAL[p] ?? p)
        .join(' ');
}
/** Cómo marca un cliente que lo que sigue es el barrio («barrio», «b/», «brr», «Bsrrio»). */
const MARCA_BARRIO = '(?:barrio|barrrio|bsrrio|brr|bario|b)';
const PREFIJO_BARRIO = /^(?:barrio|barrrio|bsrrio|brr|bario|b)\s+/;
const ARTICULO = /^(?:el|la|los|las)\s+/;
/** ¿El nombre va como nombre de un conjunto, torre, hotel o edificio? (sobre `claveBarrio`). */
const CONJUNTO = '(?:torres?|condominio|conjunto|edificio|edif|hotel|mirador|bosques|urbanizacion|ciudadela|residencias|unidad|apartamentos)';
const UNION = '(?: (?:de|del|la|las|los|el|residencial|cerrado|casa|mirador))*';
function nombreDeConjunto(t, n) {
    const escapado = n.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
    return new RegExp(`(^|[^a-z0-9])${CONJUNTO}${UNION} ${escapado}([^a-z0-9]|$)`).test(t);
}
/**
 * ¿En este texto el barrio solo aparece como nombre de un conjunto («Torres de San Luis») y nunca
 * suelto ni con «barrio» delante? Lo usa también `tomar_pedido` con el `barrio` que pasa el modelo:
 * con «Torres de san Luis» de dirección, el modelo mandó `barrio: "San Luis"` (evaluación del
 * 2026-10-16) y se cobraba la vereda.
 */
function soloComoConjunto(texto, barrio) {
    const t = claveBarrio(texto);
    const n = claveBarrio(barrio?.nombre);
    if (!t || !n || !nombreDeConjunto(t, n)) return false;
    const escapado = n.replace(ARTICULO, '').replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
    const conMarca = new RegExp(`(^|[^a-z0-9])${MARCA_BARRIO} (?:(?:el|la|los|las) )?${escapado}([^a-z0-9]|$)`);
    if (conMarca.test(t)) return false;
    // ¿Aparece también fuera del conjunto? Se quitan las menciones de conjunto y se vuelve a mirar.
    const sinConjuntos = t.replace(
        new RegExp(`(^|[^a-z0-9])${CONJUNTO}${UNION} ${n.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)}`, 'g'),
        ' '
    );
    return !contieneFrase(sinConjuntos, n);
}

/** Nombres de barrio que también son un sitio cualquiera: solo valen con «barrio» delante. */
const NOMBRES_DE_SITIO = new Set(['centro']);

/** ¿La frase `aguja` aparece en `texto` como palabras enteras? («comuna 1» no está en «comuna 10»). */
function contieneFrase(texto, aguja) {
    if (!aguja) return false;
    const escapada = aguja.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
    return new RegExp(`(^|[^a-z0-9])${escapada}([^a-z0-9]|$)`).test(texto);
}

/** «San José (Comuna 1)»; un barrio suelto, solo su nombre. */
function nombreConZona(barrio) {
    return barrio.zona ? `${barrio.nombre} (${barrio.zona})` : barrio.nombre;
}

/**
 * El precio por zona, para no listar 550 barrios: `[{zona, minimo, maximo}]` en el orden en que
 * llegan. Los barrios sueltos (sin zona) van cada uno con su nombre.
 */
function resumenPorZona(barrios) {
    const zonas = new Map();
    for (const b of barrios) {
        const clave = b.zona || b.nombre;
        const z = zonas.get(clave) || { zona: clave, minimo: Infinity, maximo: -Infinity };
        z.minimo = Math.min(z.minimo, Number(b.valor));
        z.maximo = Math.max(z.maximo, Number(b.valor));
        zonas.set(clave, z);
    }
    return [...zonas.values()];
}

/** La mesa que nombra el cliente: por número («5», «mesa 5») o por nombre exacto. */
function elegirMesa(texto, mesas) {
    const t = normalizar(texto).trim();
    if (!t) return null;
    const numero = /(?:^|\D)(\d{1,4})(?:\D|$)/.exec(t);
    if (numero) {
        const n = Number(numero[1]);
        const porNumero = mesas.filter((m) => Number(m.numero) === n);
        if (porNumero.length === 1) return porNumero[0];
    }
    const porNombre = mesas.filter((m) => normalizar(m.nombre).trim() === t);
    return porNombre.length === 1 ? porNombre[0] : null;
}

/**
 * Domicilio o recoger, o `null` si lo que llegó no lo dice claro.
 *
 * ## La trampa está en la palabra «llevar»
 *
 * Es la única de todo el flujo que significa **las dos cosas a la vez**. «Para llevar» es como
 * se pide en el mostrador y quiere decir que pasa por él; «me lo llevan» quiere decir justo lo
 * contrario. Así que la frase de dos palabras se acepta y la palabra suelta **no**: se
 * repregunta, que cuesta un mensaje.
 *
 * Equivocarse aquí no es un error cosmético. Leerlo al revés manda un domiciliario a una
 * dirección que nadie dio, o deja a alguien esperando en el local un pedido que salió en moto.
 * Cuando las dos familias de palabras aparecen —o ninguna— se devuelve `null` a propósito: en
 * este nivel no se adivina (ADR-018), se pregunta otra vez.
 */
/** «Para servir», «para comer aquí», «consumir en el local»: comer en el local (Pasto, 2026-10-02). */
const DICE_SERVIR =
    /\b(para servir|servir(lo|la|los|las)? (aqui|aca)|comer(lo|la|los|las)? (aqui|aca|alla|en el local)|consumir(lo|la|los|las)? (aqui|aca|en el local)|para la mesa)\b/;
const DICE_RECOGER = /\b(recoger|recogerlo|recogerla|recojo|recogemos|retiro|retirar|paso|pasar|voy)\b/;
const DICE_DOMICILIO =
    /\b(domicilio|domis?|delivery|envio|enviar|envien|mandan|manden|mandar|mandalo|lleven|llevenlo|llevan)\b/;

function leerEntrega(texto) {
    const t = normalizar(ultimaLinea(texto)).replace(/[¡¿!?.,;:]/g, ' ').trim();

    // El botón, primero y sin ambigüedad posible: lo que llega es el id que mandamos nosotros.
    if (t === OPCION.ENTREGA_DOMICILIO) return ENTREGA.DOMICILIO;
    if (t === OPCION.ENTREGA_RECOGER) return ENTREGA.RECOGER;
    if (t === OPCION.ENTREGA_SERVIR) return ENTREGA.MESA;

    // «Para servir» gana a todo lo demás: «para servir, ya voy» lleva un «voy» que, solo, sería
    // recoger; y quien dice que viene a comer aquí no está pidiendo que se lo lleven.
    if (DICE_SERVIR.test(t)) return ENTREGA.MESA;

    if (/\bpara llevar\b/.test(t)) return ENTREGA.RECOGER;

    const recoger = DICE_RECOGER.test(t);
    const domicilio = DICE_DOMICILIO.test(t);
    // Las dos, o ninguna: no se elige por mayoría ni por orden. Se repregunta.
    if (recoger === domicilio) return null;
    return recoger ? ENTREGA.RECOGER : ENTREGA.DOMICILIO;
}

/**
 * Lee de un mensaje suelto los datos que se le pidieron juntos.
 *
 * Devuelve **solo lo que reconoce**. Lo que no, se vuelve a preguntar: adivinar aquí sale caro
 * en la puerta de una casa, y el coste de repreguntar es un mensaje.
 *
 * ## El orden importa, y no es casual
 *
 * Se saca primero el teléfono y **lo que sobra** es la dirección. Al revés, el número de
 * contacto se quedaría pegado al número de la casa. La dirección es lo más difícil de reconocer
 * y lo más fácil de describir por descarte: es el resto.
 */
function interpretarDatos(texto, { faltan }) {
    const original = String(texto || '').trim();
    let resto = original;
    const leido = {};

    if (faltan.includes(PASO_PEDIDO.TELEFONO)) {
        const tel = leerTelefono(resto);
        if (tel) {
            leido.telefono = tel;
            resto = resto.replace(CELULAR_CO, ' ');
        }
    }

    if (faltan.includes(PASO_PEDIDO.DIRECCION)) {
        // De lo que queda, la línea que más se parezca a una dirección. Si vino todo en una
        // línea, esa misma línea es la candidata.
        const candidatas = resto
            .split(/\r?\n|\s{2,}/)
            .map((l) => limpiarBordes(l))
            .filter(Boolean);
        const direccion = candidatas.find((c) => pareceDireccion(c));
        if (direccion) leido.direccion = direccion;
    }

    return leido;
}

/**
 * Palabras de relleno que quedan colgando cuando se recorta el teléfono.
 *
 * «Calle 45 #12-30, barrio El Prado. Mi cel es 3152812484» deja, tras quitar el número, un
 * «Mi cel es» pegado al final de la dirección. No estorba al domiciliario, pero se guarda en la
 * orden y se imprime en la comanda.
 *
 * Solo se limpian los **bordes**, nunca el medio: una de estas palabras dentro de la dirección
 * —«vereda El Contacto»— es parte de ella.
 */
const RELLENO = new Set([
    'mi', 'me', 'es', 'son', 'y', 'e', 'o', 'el', 'la', 'los', 'las', 'de', 'del', 'al', 'a',
    'en', 'por', 'con', 'para', 'cel', 'celu', 'celular', 'tel', 'telefono', 'numero', 'num',
    'contacto', 'direccion', 'dir', 'pago', 'pagar', 'queda', 'vivo', 'llevar',
]);

/**
 * Quita puntuación y palabras de relleno de los dos extremos. Nunca del medio.
 *
 * ## La excepción que costó una prueba
 *
 * «Carrera 3e 19 a» es una dirección real y es **el ejemplo canónico** de este proyecto — la
 * frase que justifica que las direcciones casi no se validen. La primera versión de esto le
 * comió la «a» final, porque «a» está en la lista de relleno, y devolvió «Carrera 3e 19»: otra
 * casa. Lo cazó un test que ya existía, que para eso estaba.
 *
 * La regla que lo arregla no es una lista de excepciones sino una observación sobre la
 * nomenclatura: **una letra suelta detrás de un número es parte de la dirección** —19 a, 3 e—,
 * mientras que detrás de una palabra es relleno («mi cel es»). Una palabra entera detrás de un
 * número no se salva: en «Av. Boyacá 100, tel 300…» el «tel» sobra igual.
 */
function limpiarBordes(texto) {
    const soloBordes = (t) => t.replace(BORDES, '').trim();
    const partes = soloBordes(String(texto || '')).split(/\s+/).filter(Boolean);

    const esRelleno = (palabra) => RELLENO.has(normalizar(soloBordes(palabra)));
    // Una LETRA suelta detrás de un número: «19 a», «3 e». Una palabra no.
    const esSufijoDeNomenclatura = (i) =>
        i > 0 &&
        /^[a-zñ]$/.test(normalizar(soloBordes(partes[i]))) &&
        /\d$/.test(soloBordes(partes[i - 1]));

    while (partes.length && esRelleno(partes[partes.length - 1])) {
        if (esSufijoDeNomenclatura(partes.length - 1)) break;
        partes.pop();
    }
    while (partes.length && esRelleno(partes[0])) partes.shift();

    return soloBordes(partes.join(' '));
}

/** Puntuación y espacios pegados a los extremos. */
const BORDES = /^[\s•\-*·:,.]+|[\s•\-*·:,.]+$/g;

/**
 * Palabras con las que empieza una dirección por aquí. No pretende ser exhaustiva.
 */
const PALABRAS_DE_DIRECCION =
    /\b(calle|cll|cl|carrera|cra|kra|kr|avenida|av|ave|diagonal|dg|transversal|tv|tr|manzana|mz|apto|apartamento|torre|bloque|casa|barrio|conjunto|edificio|vereda|km|kilometro|autopista|circunvalar|sector|etapa|local|piso)\b/;

/**
 * ¿Esto se parece siquiera a una dirección?
 *
 * ## Lo que esta función NO hace, y es deliberado
 *
 * **No valida que la dirección exista ni que esté bien escrita.** Quien sabe si «Carrera 3e 19 a»
 * lleva a algún sitio es el domiciliario, no una expresión regular, y ése era el argumento por el
 * que aquí no había ninguna comprobación. Sigue siendo bueno: una validación estricta rechazaría
 * direcciones reales de barrios que no siguen la nomenclatura, y dejar a un cliente sin poder
 * pedir es mucho peor que un pedido con una dirección rara.
 *
 * Lo que sí hace es cazar lo que **evidentemente** no es una dirección — «jajaja», un emoji
 * suelto, cuatro letras— para **repreguntar una vez**. Si el cliente insiste, se acepta: ver
 * `PASO_PEDIDO.DIRECCION` en `seguirPedido`. El guardarraíl avisa; no manda.
 *
 * Se aprueba con **cualquiera** de las dos señales, no con las dos:
 *   - un número (casi toda dirección lleva al menos uno), o
 *   - una palabra de las de arriba (para «el conjunto de siempre, casa blanca»).
 */
function pareceDireccion(texto) {
    const t = String(texto || '').trim();
    if (t.length < 6) return false;

    const normalizado = normalizar(t);
    // Al menos tres letras: descarta emojis sueltos y garabatos.
    if ((normalizado.match(/[a-z]/g) || []).length < 3) return false;

    return /\d/.test(normalizado) || PALABRAS_DE_DIRECCION.test(normalizado);
}

/**
 * Cede el turno al modelo sin escribir nada.
 *
 * `respuestas: []` es deliberado: el motor cierra el turno como `sin_respuesta` y el cliente no
 * ve un mensaje de relleno. Se usa cuando llega algo que este flujo no reconoce pero la
 * conversación ya está en marcha — decir «no te entendí» cuando el modelo sí lo entendería es
 * peor que callarse.
 */
function delegar(ctx) {
    return {
        pasos: [paso('cedido_al_modelo')],
        respuestas: [],
        variables: conMemoria(ctx.conversacion),
        tarea: null,
        resultado: 'sin_respuesta',
        nivel: 'determinista',
    };
}

/**
 * Lo que se enseña de la carta en el chat: productos con su precio, los más pedidos primero.
 *
 * Lectura directa del modelo de la vertical y no de una capacidad: esto no lo pide el cliente ni
 * lo decide el asistente, es el flujo pintando su propio mensaje. Pasarlo por el Policy Gate
 * gastaría una clave de idempotencia y una fila de Ledger por cada saludo, para leer una tabla
 * pública que ya se sirve sin autenticación en el menú digital.
 *
 * Devuelve también el `total` de la carta, no solo lo que cabe: es lo que permite decir «y hay
 * más» en vez de dar a entender que eso es todo lo que hay.
 */
async function cartaDe(idNegocio) {
    const cartaService = require('../../../app_restaurante_api/services/cartaService');
    // La carta que enseña el asistente sigue SU decisión sobre el inventario, no la de caja.
    const stock = await cartaService
        .asistenteMiraStock(idNegocio)
        .then((miraStock) => ({ miraStock }), () => ({}));
    const categorias = await cartaService.getCartaPublica(idNegocio, stock);

    const todos = [];
    for (const c of categorias) {
        for (const p of c.productos || []) {
            todos.push({ nombre: p.nombre, precio: p.precio, es_popular: Boolean(p.es_popular) });
        }
    }

    // `sort` es estable en V8, así que los populares suben a la cabeza sin descolocar el orden
    // que la carta ya trae (el que puso el negocio, categoría por categoría).
    const ordenados = todos.slice().sort((a, b) => Number(b.es_popular) - Number(a.es_popular));

    return { productos: ordenados.slice(0, MAX_EN_EL_CHAT), total: todos.length };
}

/**
 * ¿Es este mensaje de este flujo? Lo pregunta la política de enrutado (`engine/flujos.js`).
 *
 * Solo el pedido del menú: es un dato exacto con un código que una expresión regular lee mejor
 * que un modelo. Todo lo demás sigue decidiéndolo la tabla — un «¿tienen sopa?» tiene que poder
 * irse al Nivel 4, y reclamar de más convertiría este flujo en un contestador.
 *
 * Hasta el 2026-08-26 esto no existía y el pedido **nunca llegaba aquí**: caía en el comodín
 * `pregunta_libre` y se lo quedaba el modelo, que se apañaba decodificando el código a mano
 * hasta que se le olvidó el carrito a mitad de conversación.
 */
/**
 * Una foto, un audio, un video, un documento o una ubicación SIN texto: el canal lo trae como
 * `[image]`, `[audio]`… El asistente no los ve. Es casi siempre el comprobante de la transferencia
 * o la ubicación del domicilio, y antes se contestaba con el modelo: «¿quieres que revise algo de las
 * imágenes o te ayudo a elegir otra hamburguesa?» (Zona Burger, 2026-10-03). Los stickers los calla
 * `cortesia`.
 */
const MEDIA_PARA_PERSONA = {
    image: 'tu foto',
    audio: 'tu audio',
    video: 'tu video',
    document: 'tu documento',
    location: 'tu ubicación',
    contacts: 'ese contacto',
};

function mediaSuelta(texto) {
    const m = String(ultimaLinea(texto) || '').trim().match(/^\[(image|audio|video|document|location|contacts)\]$/);
    return m ? m[1] : null;
}

function reclama(texto) {
    return (
        Boolean(codigoPedido.leer(texto)) ||
        // El formulario de entrega: lo ofreció este flujo y lo lee él (o le deja la nota al modelo).
        Boolean(formularioEntrega.leer(texto)) ||
        esPreguntaDeTiempo(texto) ||
        preguntaPorSuPedido(texto) ||
        preguntaPorEmpaque(texto) ||
        esPreguntaDeDomicilio(texto) ||
        Boolean(mediaSuelta(texto)) ||
        pago.esCancelarAmbiguo(texto) ||
        pago.eligioAnular(texto) ||
        pago.eligioPagar(texto) ||
        pago.esPreguntaDePago(texto, { hayPedido: true })
    );
}

/**
 * ¿Pregunta cuánto tarda su pedido? («¿cuánto se demora?», «¿cuánto tiempo tarda?», «¿en cuánto
 * llega?»).
 *
 * Observado en producción (2026-10-01, Zona Burger): es de las preguntas más repetidas, y el bot
 * contestaba «no tengo el tiempo estimado, confírmalo con el negocio» porque nadie le había dicho
 * cuál era. Ahora lo dice el propio negocio (Bandeja → configuración) y esto solo reconoce la
 * pregunta, sin gastar un modelo.
 *
 * Es deliberadamente estricto: frases cortas y con la forma de la pregunta. Un mensaje largo que
 * contiene «demora» por otra razón («si se demora mucho cancelo, pero quiero dos salchipapas…») es
 * un pedido o una queja, no esta pregunta, y no se le contesta con un tiempo.
 */
const PREGUNTA_TIEMPO = [
    // «te demoras», «le demora», y la errata «tienpo» (Zona Burger, 2026-10-03: «Cuánto te demoras?»
    // y «cuanto tienpo se demora» no se reconocían y acabaron en el modelo o en la nota del pedido).
    /\bcuanto (ti?em?n?po )?(se |me |les |lo |te |nos |le )?(demora|demoran|demoras|demoraria|demorarian|tarda|tardan|tardas|tardaria|toma|tomaria|falta|faltan)\b/,
    /\bque tanto (se |me |te )?(demora|demoran|demoras|tarda|tardan|tardas)\b/,
    /\bcuanto (de )?(demora|espera|tiempo de espera|tiempo de entrega)\b/,
    /\b(tiempo|demora) (estimado )?de (entrega|espera|preparacion)\b/,
    /\ben cuanto (tiempo )?(llega|llegaria|esta|estaria|lo tienen|me lo traen|me lo entregan|me llega)\b/,
    // Quien recoge pregunta por SU llegada, no por la del pedido (Zona Burger, 2026-10-01: «en
    // cuánto puedo pasar», «en cuánto tiempo puede recoger», «en cuánto tiempo recojo el pedido»).
    /\ben cuanto (tiempo )?(puedo|podria|puede|paso|pasar|recojo|recoger|lo recojo|vengo|voy|queda|quedaria|estara)\b/,
    /\ba que hora (llega|llegaria|esta|estaria|estara|paso|puedo pasar|recojo|lo recojo|me llega|queda)\b/,
];
const MAX_PALABRAS_PREGUNTA = 14;

function esPreguntaDeTiempo(texto) {
    const t = normalizar(ultimaLinea(texto)).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > MAX_PALABRAS_PREGUNTA) return false;
    return PREGUNTA_TIEMPO.some((patron) => patron.test(t));
}

/**
 * La respuesta con el tiempo que declaró el negocio, o `null` si no lo ha configurado (entonces
 * no se inventa ninguno). Primero el dato, y después la promesa amable: si sale antes, se avisa.
 */
function fraseDeTiempo(tiempo, { hayPedido = true, ofrecerTomarlo = false } = {}) {
    const min = Number(tiempo?.min);
    if (!Number.isInteger(min) || min < 1) return null;
    const max = Number(tiempo?.max);
    const rango = Number.isInteger(max) && max > min;
    if (hayPedido) {
        const cuanto = rango ? `de *${min} a ${max} minutos*` : `de unos *${min} minutos*`;
        return `El tiempo estimado de tu pedido es ${cuanto} ⏱️. Si está listo antes, te avisaremos 😊`;
    }
    // Sin pedido confirmado, «tu pedido» es mentira. Zona Burger, 2026-10-02: una clienta
    // preguntó «¿en cuánto está?», le contestamos «el tiempo estimado de TU pedido es de 40 a 60
    // minutos», y se fue a pagar un pedido que nadie había tomado.
    const cuanto = rango ? `*${min} a ${max} minutos*` : `unos *${min} minutos*`;
    const frase = `Los pedidos están saliendo en ${cuanto} ⏱️, contados desde que se confirman.`;
    return ofrecerTomarlo
        ? `${frase}\nTodavía no tengo ningún pedido tuyo: si quieres, te lo tomo por aquí 😊`
        : frase;
}

/**
 * Qué tiempo aplica según cómo se recibe el pedido: el de recoger para quien pasa por el local
 * (o el estimado de siempre si el negocio no lo ha dicho aparte) y el estimado —cocina más
 * camino— para un domicilio. Sin saber cómo lo recibe, el estimado.
 */
function tiempoPara(negocio, tipoEntrega) {
    const enElLocal = tipoEntrega === 'LLEVAR' || tipoEntrega === 'MESA';
    return enElLocal ? negocio?.tiempoRecoger || negocio?.tiempoEstimado : negocio?.tiempoEstimado;
}

function minutosEnPalabras(tiempo) {
    const min = Number(tiempo?.min);
    if (!Number.isInteger(min) || min < 1) return null;
    const max = Number(tiempo?.max);
    return Number.isInteger(max) && max > min ? `*${min} a ${max} minutos*` : `unos *${min} minutos*`;
}

/**
 * «¿Cuánto se demora?» de quien todavía no tiene pedido ni ha dicho cómo lo recibe: los dos
 * tiempos en una frase, cuando el negocio declaró el de recoger aparte. Decirle «40 a 60
 * minutos» —el del domicilio— a quien iba a pasar por el local es espantarlo (Zona Burger,
 * 2026-10-07: pedidos para recoger listos en 9 y 23 minutos). `null` si no hay dos tiempos.
 */
function fraseDeLosDosTiempos(negocio, { ofrecerTomarlo = false } = {}) {
    const recoger = minutosEnPalabras(negocio?.tiempoRecoger);
    const domicilio = minutosEnPalabras(negocio?.tiempoEstimado);
    if (!recoger || !domicilio) return null;
    const frase =
        `Para recoger, ${recoger} ⏱️; a domicilio, ${domicilio}. ` +
        'Se cuentan desde que se confirma el pedido.';
    return ofrecerTomarlo
        ? `${frase}\nTodavía no tengo ningún pedido tuyo: si quieres, te lo tomo por aquí 😊`
        : frase;
}

/**
 * «¿Cuánto vale el domicilio?» — se contesta con el RANGO que declaró el negocio.
 *
 * Desde 2026-10-02: cargar el precio barrio por barrio era tedioso y el negocio prefirió decir un
 * rango («en Pasto entre $7.000 y $9.000; fuera de la ciudad, desde $10.000»). Igual de estricto
 * que `PREGUNTA_TIEMPO`: frase corta y con forma de pregunta; un pedido largo que menciona el
 * domicilio no es esta pregunta.
 */
const PREGUNTA_DOMICILIO = [
    /\bcuanto (vale|valen|cuesta|cuestan|sale|es|seria|valdria|costaria|cobran|cobrarian|me cobran)( el| los)? (domicilio|domicilios|domi|envio|envios)\b/,
    /\b(valor|precio|costo|tarifa)s? (del |de los |de )?(domicilio|domicilios|domi|envio)\b/,
    /\bcuanto (me )?(cobran|cobrarian|vale|cuesta|sale) (por )?(el |la )?(domicilio|envio|llevarlo|traerlo|traermelo|llevarmelo|traida|llevada)\b/,
    /\b(domicilio|envio|domi) (cuanto|que valor|que precio|en cuanto|que costo)\b/,
    /\b(tiene|tienen|cobran) (costo|valor|recargo) (el |los )?(domicilio|domicilios|envio)\b/,
    // Después de oír el total: «¿Con el domicilio?», «¿Cuánto es con domicilio?» (Zona Burger,
    // 2026-10-03: tres clientes lo preguntaron así y acabaron con una persona). Solo si el
    // mensaje ENTERO es eso: es la pregunta corta, no un pedido que menciona el domicilio.
    /^(y |entonces |osea )?(cuanto (me )?(es|seria|sale|son|queda|quedaria) )?(con|incluyendo|incluido|mas|sumando)( el| los)? (domicilio|domicilios|domi|envio)( incluido)?$/,
    // «¿Vale 7.000 el domicilio?», «¿me cobran 8 mil el domi?», «¿el domicilio es de 7 mil?»
    // (Zona Burger, 2026-10-02: «Pero es cerca, ¿vale 7.000 el domicilio?» no se reconocía).
    // Ojo: al normalizar se quitan puntos y comas, así que «7.000» llega como «7 000».
    /\b(vale|valdria|cuesta|costaria|sale|saldria|cobran|cobrarian|seria|es) (de )?(unos? )?\$? ?\d[\d ]*?( mil| pesos)? (el |los )?(domicilio|domicilios|domi|envio)\b/,
    /\b(domicilio|domi|envio) (vale|cuesta|sale|seria|es de|queda en) (unos? )?\$? ?\d/,
];

function esPreguntaDeDomicilio(texto) {
    const t = normalizar(ultimaLinea(texto)).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > MAX_PALABRAS_PREGUNTA) return false;
    return PREGUNTA_DOMICILIO.some((patron) => patron.test(t));
}

/**
 * Cuánto vale el domicilio, en pocas palabras: «entre $7.000 y $9.000», «desde $7.000» o
 * «gratis». `null` si el negocio no dio un valor (puede haber dado solo la nota).
 */
function rangoEnPalabras(rango) {
    const min = rango?.min;
    if (!Number.isInteger(min) || min < 0) return null;
    const max = rango?.max;
    if (Number.isInteger(max) && max > min) return `entre ${enPesos(min)} y ${enPesos(max)}`;
    if (min === 0) return 'gratis';
    return `desde ${enPesos(min)}`;
}

/**
 * La respuesta con el rango que declaró el negocio, o `null` si no lo ha configurado (entonces no
 * se inventa ninguno y lo atiende el modelo, que mira barrios y notas).
 */
function fraseDeDomicilio(rango) {
    const cuanto = rangoEnPalabras(rango);
    const nota = String(rango?.nota || '').trim();
    if (!cuanto && !nota) return null;
    const lineas = [];
    if (cuanto) {
        lineas.push(
            cuanto === 'gratis'
                ? 'El domicilio es *gratis* 🛵'
                : `El domicilio vale *${cuanto}*, según dónde estés 🛵`
        );
    }
    if (nota) lineas.push(nota);
    lineas.push('El valor exacto te lo confirma el restaurante al despachar tu pedido 😊');
    return lineas.join('\n');
}

/** Cuánto vale como «reciente» un pedido para decirle al cliente «tu pedido». */
const HORAS_PEDIDO_RECIENTE = 6;

/**
 * ¿Pregunta por un pedido que ya hizo? («ya salió mi pedido», «se demora aún el domicilio», «ya
 * hice el pedido»). Solo se reclama para un caso: si una persona del local atendió este chat hace
 * poco, el pedido lo tomó ELLA (a mano, en la caja) y el asistente no lo ve.
 *
 * Observado en producción (2026-10-04, Zona Burger): el personal tomó dos pedidos por el chat, el
 * plazo de reactivación devolvió la conversación al asistente y, cuando el cliente preguntó cómo
 * iba, el bot contestó «todavía no tengo ningún pedido tuyo, ¿te lo tomo?». Uno de los dos
 * clientes casi lo pide dos veces, y se quejó: «Sean serios de verdad».
 */
const PREGUNTA_POR_SU_PEDIDO = [
    /\bya (viene|vienen|salio|sale|llega|llego|despacharon|despacho|mandaron|enviaron|esta listo|esta lista|mero)\b/,
    /\b(hice|realice|mande|envie|pedi) (el|mi|un) (pedido|domicilio|domi)\b/,
    /\b(como va|como vamos con|que paso con|que hubo de|y) (mi|el) (pedido|domicilio|domi)\b/,
    /\bse demora (aun |todavia |mucho )?(el|mi) (pedido|domicilio|domi)\b/,
    /\b(mi|el) (pedido|domicilio|domi) (ya |aun |todavia )?(viene|sale|salio|llega|esta|demora)\b/,
    // Reclamos de demora: «pues ya son los 60 minutos que me dijeron, ¿se demora aún más?».
    /\bse demora(n)? (aun |todavia )?mas\b/,
    /\bya (son|van|paso|pasaron|llevo|llevamos) (los |mas de |casi )?(\d+|una hora|media hora)\b/,
    /\b(no ha llegado|no llega|todavia no llega|aun no llega|no ha salido|cuanto falta|falta mucho)\b/,
];

/** La entrega que nombra una frase, o `null`. */
function entregaNombrada(t) {
    if (/\b(para servir|servir aqui|(consumir|comer|como|consumo) (aqui|alla|en el local)|sin empaque|no necesito (el )?empaque|no (me )?empaque)/.test(t)) return 'MESA';
    if (/\b(para recoger|recoger(lo|la|los|las)?|la recojo|lo recojo|paso a recoger|para llevar)\b/.test(t)) return 'LLEVAR';
    if (/\b(a domicilio|domicilio|me lo (traen|mandan|envian)|me la (traen|mandan|envian))\b/.test(t)) return 'DOMICILIO';
    return null;
}

const PIDE_CAMBIO = /\b(cambio|cambios|cambiar|cambia|cambiale|cambiame|quitar|quita|quitale|quitame|mejor|en vez|en lugar|agrega|agregar|agregale|agregame|anade|adiciona|adicionar|tambien quiero|otra cosa)\b/;
const PREGUNTA = /^(cuanto|cuantos|cuanta|que|cual|cuales|como|donde|cuando|tienen|tiene|tienes|hay|me pueden|puedo|podria|se puede|lo tienen|lo tienes|viene|vienen|trae|traen)\b/;
const HABLA_DE_COBRO = /\b(cobran|cobra|cobro|cobraron|valor|precio|cuesta|vale|combo|promo|promocion|descuento)\b/;

/**
 * Con un pedido esperando el sí, ¿el mensaje AÑADE un producto? «Y una salchilimon», «Una viciosa
 * mediana», «Mas 2 jugos de maracuya», «Adición de costilla». Eso no es una nota de cocina: es
 * otra línea del pedido, con su precio, y solo el modelo puede buscarla en la carta y rehacer el
 * resumen. Zona Burger, 2026-10-06: cuatro chats donde el añadido acabó en la nota con el total
 * sin tocar; uno de $16.000 era en realidad de $45.000 y lo terminó el cajero a mano.
 *
 * No lo es lo que empieza por un número y sigue con una seña de la dirección («3 piso», «2
 * cuadras abajo»): eso sí va a la nota, que es lo que lee el domiciliario.
 */
const CANTIDAD = '(?:un|una|unos|unas|dos|tres|cuatro|cinco|seis|\\d{1,2})';
const SENA_DE_DIRECCION = '(?:pisos?|aptos?|apartamentos?|casas?|torres?|manzanas?|etapas?|bloques?|cuadras?|calles?|minutos?|horas?|veces|momento|momentico|segundo|ratico|rato)\\b';
const ANADE_PRODUCTO = new RegExp(
    `^(?:(?:y|mas|tambien|ademas)\\s+)?${CANTIDAD}\\s+(?!${SENA_DE_DIRECCION})[a-zñ]{3,}` +
        `|^(?:y|mas|tambien|ademas)\\s+(?:la|el|las|los)\\s+[a-zñ]{3,}` +
        '|\\badicion(?:es|al|ales)?\\b'
);
function anadeProducto(texto) {
    const t = normalizar(ultimaLinea(texto)).replace(/[¡¿!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
    return ANADE_PRODUCTO.test(t);
}

/**
 * Con un pedido esperando el sí, ¿este mensaje es una pregunta o un cambio que tiene que contestar
 * el modelo? No lo es un sí, un no, «a nombre de…» ni lo que se anota (una nota de cocina).
 */
function vaAlModeloDuranteLaConfirmacion(texto, datos) {
    const linea = ultimaLinea(texto);
    const t = normalizar(linea).replace(/[¡¿!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (esComando(texto, COMANDO.NO) || esComando(texto, COMANDO.CANCELAR)) return false;
    if (/\b(a nombre de|me llamo|mi nombre es)\b/.test(t)) return false;
    const entregaPendiente = datos?.args?.tipo_entrega ?? null;
    if (esAfirmacionConEntrega(texto, entregaPendiente) && !PIDE_CAMBIO.test(t)) return false;
    if (PIDE_CAMBIO.test(t) || anadeProducto(texto)) return true;
    const nombrada = entregaNombrada(t);
    if (nombrada && entregaPendiente && nombrada !== entregaPendiente) return true;
    // «Que me regalen salsa de ajo» empieza como pregunta y es un añadido: va a la nota.
    return linea.includes('?') || (PREGUNTA.test(t) && !esPeticionConQue(t)) || HABLA_DE_COBRO.test(t);
}

const ENTREGA_EN_PALABRAS = {
    LLEVAR: 'para recoger en el local',
    DOMICILIO: 'a domicilio',
    MESA: 'para comer en el local',
};

/**
 * Con un pedido esperando el sí que NO es a domicilio, ¿el mensaje habla de domicilio?
 * Devuelve `{ de, a }` o `null`. Solo pedidos (los que traen `tipo_entrega`).
 */
function entregaQueCambia(texto, datos) {
    const pendiente = datos?.args?.tipo_entrega ?? null;
    if (!pendiente || !ENTREGA_EN_PALABRAS[pendiente]) return null;
    const t = normalizar(ultimaLinea(texto)).replace(/[¡¿!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
    const nombrada = entregaNombrada(t);
    // Cualquier entrega distinta de la del resumen, no solo hacia DOMICILIO. Hasta el 2026-10-07
    // «mejor la recojo» dejaba el pendiente en su sitio, contando con que el modelo rehiciera el
    // pedido en el mismo turno; con un domicilio esperando, «¿o me queda cerca para ir a
    // recoger?» se contestó («sí, puedes pasar; habría que cambiarlo»), el resumen siguió vivo y
    // el «sí» siguiente tomó el domicilio que el cliente ya no quería (ORD-7877).
    return nombrada && nombrada !== pendiente ? { de: pendiente, a: nombrada } : null;
}

/**
 * ¿Alguien del local escribió en este chat DESPUÉS de que se enseñara el resumen que espera el sí?
 *
 * Entonces el «sí» que llega puede ser para esa persona y no para el resumen. Zona Burger,
 * 2026-10-07: la clienta pidió que le llevaran el pedido, el cajero contestó «cobrarían el domi»,
 * ella dijo «sí» y el asistente tomó el pedido «para recoger» (ORD-7876); la noche anterior, lo
 * mismo creó un domicilio con dirección «pendiente» y repitió uno que ya estaba despachado.
 */
function personaEscribioTrasElResumen(conversacion, datos) {
    const persona = Date.parse(conversacion?.humano_ultimo_en || '');
    const resumen = Date.parse(datos?.preguntado_en || '');
    return Number.isFinite(persona) && Number.isFinite(resumen) && persona > resumen;
}

/**
 * Lo que se le recuerda al modelo cuando el cliente añade o cambia algo con un resumen esperando
 * el sí: sin esto rehacía el pedido SOLO con lo nuevo. Zona Burger, 2026-10-07: el cliente dictó
 * tres productos en tres mensajes, cada resumen traía solo el último y tuvo que escribirlos
 * todos otra vez (ORD-7878).
 */
function notaDeLoAnotado(datos) {
    return (
        '[Nota del sistema, no del cliente: hay un pedido esperando el sí, con esto anotado: ' +
        `${JSON.stringify(datos?.args ?? {})}. Si el cliente AÑADE un producto, vuelve a llamar la ` +
        'herramienta del pedido con TODO lo que ya estaba anotado MÁS lo nuevo, no solo con lo ' +
        'nuevo. Quita o cambia algo de lo anotado únicamente si lo pide. Conserva la entrega, la ' +
        'dirección, el nombre y el teléfono que ya había.]'
    );
}

/**
 * ¿Pregunta cuántas cajas, empaques o recipientes trae? Es un dato que ningún sistema guarda.
 */
const PREGUNTA_EMPAQUE = /\bcuant[oa]s? (cajas?|empaques?|recipientes?|bolsas?|tarrinas?|cajitas?)\b|\b(en cuant[oa]s?|cuant[oa]s?) (cajas?|empaques?)\b|\b(viene|vienen|trae|traen) (en )?(una|dos|1|2) (caja|cajas)\b|\bcaja y media\b/;
function preguntaPorEmpaque(texto) {
    const t = normalizar(ultimaLinea(texto)).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > MAX_PALABRAS_PREGUNTA) return false;
    return PREGUNTA_EMPAQUE.test(t);
}

function preguntaPorSuPedido(texto) {
    const t = normalizar(ultimaLinea(texto)).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.split(' ').length > MAX_PALABRAS_PREGUNTA) return false;
    return PREGUNTA_POR_SU_PEDIDO.some((patron) => patron.test(t));
}

/** ¿Una persona del local escribió en este chat dentro de las últimas horas? */
function personaAtendioHacePoco(conversacion, ahora) {
    const ultima = conversacion?.humano_ultimo_en ? new Date(conversacion.humano_ultimo_en) : null;
    if (!ultima || Number.isNaN(ultima.getTime())) return false;
    return ahora.getTime() - ultima.getTime() <= HORAS_PEDIDO_RECIENTE * 3600 * 1000;
}

/**
 * ¿El asistente tomó un pedido en esta conversación en las últimas horas? Lo dice el Ledger:
 * `tomar_pedido` con resultado `ok` es un pedido que se creó (la petición que queda esperando
 * el «sí» no se registra como `ok`). Un pedido que alguien del local creó a mano desde la caja
 * no sale aquí: eso lo sabrá el día que la caja ligue el pedido a la conversación.
 *
 * Ante cualquier fallo, `false`: lo peor que pasa es decir «desde que se confirma» a quien ya
 * pidió, que es inexacto pero no engaña a nadie. Lo contrario sí engañó (Zona Burger, 2026-10-02).
 */
async function pedidoRecienteEnLaConversacion(conversacion) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM intelligence.invocacion_capacidad
              WHERE id_conversacion = :c AND capacidad = 'tomar_pedido'
                AND resultado = 'ok' AND NOT dry_run
                AND creado_en >= now() - (:horas * interval '1 hour')
              LIMIT 1;`,
            {
                replacements: { c: conversacion.id_conversacion, horas: HORAS_PEDIDO_RECIENTE },
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );
        return Boolean(fila);
    } catch (error) {
        console.warn(`[restaurante] no se pudo saber si hay un pedido reciente: ${error.message}`);
        return false;
    }
}

/**
 * ¿Ya se le dijo a este cliente cómo va su pedido, después de tomarlo? Cuenta el tiempo contestado
 * por el flujo y `consultar_estado_pedido` del modelo, solo desde el último pedido del asistente.
 * Ante un fallo, `false`: se contesta como la primera vez, que no engaña a nadie.
 */
async function yaSeContestoElEstado(conversacion) {
    try {
        const [fila] = await Models.sequelize.query(
            `WITH ult AS (
                 SELECT max(creado_en) AS en FROM intelligence.invocacion_capacidad
                  WHERE id_conversacion = :c AND capacidad = 'tomar_pedido' AND resultado = 'ok'
                    AND NOT dry_run AND creado_en >= now() - (:horas * interval '1 hour'))
             SELECT 1 AS hay FROM ult
              WHERE ult.en IS NOT NULL AND (
                    EXISTS (SELECT 1 FROM intelligence.paso p
                              JOIN intelligence.turno t ON t.id_turno = p.id_turno
                             WHERE t.id_conversacion = :c AND p.creado_en > ult.en
                               AND p.decision = 'tiempo_estimado_respondido')
                 OR EXISTS (SELECT 1 FROM intelligence.invocacion_capacidad i
                             WHERE i.id_conversacion = :c AND i.creado_en > ult.en
                               AND i.capacidad = 'consultar_estado_pedido' AND i.resultado = 'ok'))
              LIMIT 1;`,
            {
                replacements: { c: conversacion.id_conversacion, horas: HORAS_PEDIDO_RECIENTE },
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );
        return Boolean(fila);
    } catch (error) {
        console.warn(`[restaurante] no se pudo saber si ya se contestó el estado: ${error.message}`);
        return false;
    }
}

/**
 * Crea el manejador. La inyección existe para los tests, igual que en el flujo de `reserva`.
 * `ahora` también se inyecta: el saludo depende de la hora y una prueba no puede esperar a que
 * sean las ocho de la tarde.
 */
function crearFlujoRestaurante({
    contextoNegocio: ctxNegocio = contextoNegocio,
    leerCarta = cartaDe,
    ahora = () => new Date(),
    // El Gate y la identidad solo hacen falta para cerrar un pedido: son lo que convierte el
    // «sí» del cliente en una orden. Se inyectan por lo mismo que en la FSM de citas — que un
    // test del flujo no necesite Postgres.
    gate = policyGate,
    identidad = identidadReal,
    // Mismo motivo: el saludo lee esto para saber en cuál de los tres estados está el negocio,
    // y sin poder sustituirlo un test del saludo necesitaría Postgres para algo que no es su
    // dominio (ver `bienvenida`).
    estadoAtencion = horarioService.estadoDeAtencion,
    // Cuándo abre, para decirlo en el saludo fuera de horario. Misma razón: inyectable.
    proximaApertura = horarioService.proximaApertura,
    // Barrios con precio y mesas del negocio: lo que hace falta para leer lo que el cliente
    // eligió en la carta. Se inyecta por lo mismo que lo demás. Si leer falla, se sigue como si
    // el negocio no tuviera ni barrios ni mesas: pedir no se rompe por un extra.
    // ¿Este chat tiene un pedido de verdad, reciente? Decide si el tiempo se dice como «tu
    // pedido» o como «desde que se confirma». Se inyecta para que los tests no necesiten Postgres.
    tienePedidoReciente = pedidoRecienteEnLaConversacion,
    yaSeLeContestoSuPedido = yaSeContestoElEstado,
    catalogo = {
        barrios: (idNegocio) => barrioService.listarPublico(idNegocio),
        mesas: (idNegocio) => mesaPublicaService.listarPublicas(idNegocio),
        resolverBarrio: (args) => barrioService.resolverBarrio(args),
        resolverMesa: (args) => mesaPublicaService.resolverMesa(args),
        resolverExclusiones: (args) => exclusiones.resolver(args),
        formularioEntrega: (idNegocio) => formularioEntrega.flowIdDe(idNegocio),
    },
} = {}) {
    /** Barrios y mesas en el contexto, para las preguntas y para leer el código de la carta. */
    async function conCatalogo(ctx) {
        ctx.catalogo = catalogo;
        try {
            ctx.barrios = await catalogo.barrios(ctx.idNegocio);
        } catch (error) {
            console.warn(`[restaurante] no se pudieron leer los barrios: ${error.message}`);
            ctx.barrios = { habilitado: false, barrios: [] };
        }
        try {
            ctx.mesas = await catalogo.mesas(ctx.idNegocio);
        } catch (error) {
            console.warn(`[restaurante] no se pudieron leer las mesas: ${error.message}`);
            ctx.mesas = [];
        }
        // El formulario de entrega solo existe en WhatsApp, y solo si el negocio lo encendió.
        ctx.formularioEntrega =
            ctx.conversacion?.canal === 'whatsapp' && catalogo.formularioEntrega
                ? await catalogo.formularioEntrega(ctx.idNegocio)
                : null;
        return ctx;
    }

    /**
     * Rellena el contexto con quién es el cliente.
     *
     * `telefonoProbado` es la mitad que decide si hay que pedirle el número: es lo que el canal
     * **probó**, no lo que nadie dijo. Con el BSUID de WhatsApp puede ser nulo, y ahí es donde
     * aparece el paso del teléfono.
     */
    async function conIdentidad(ctx) {
        // El nombre del perfil de WhatsApp entra como última opción (después de lo que dijo y de la
        // ficha del cliente): así no se le pregunta lo que el canal ya trajo.
        ctx.identidad = await identidad.resolver(ctx.conversacion, {
            nombrePerfil: identidadReal.nombreDelPerfil(ctx.mensajes),
        });
        ctx.principal = ctx.identidad.principal;
        ctx.telefonoProbado = ctx.principal?.telefono_verificado || null;
        return ctx;
    }

    return async function manejarRestaurante({ conversacion, mensajes, turno, texto }) {
        const negocio = await ctxNegocio.obtener(conversacion.id_negocio);
        const invocaciones = [];
        const ctx = {
            conversacion,
            mensajes,
            turno,
            texto,
            negocio,
            invocaciones,
            idNegocio: Number(conversacion.id_negocio),
            ahora,
        };

        // Un «sí» suelto justo después de tomar el pedido: no hay nada que confirmar. Zona Burger,
        // 2026-10-16 19:25 (ORD-8360): el formulario volvió a enseñar el resumen con su botón, la
        // clienta tocó los dos «Sí», el segundo fue al modelo y este pasó el chat a una persona —
        // y el asistente se quedó mudo con ella. Se le dice que ya quedó, sin modelo.
        const recien = conversacion.variables?.ultima_confirmacion;
        if (
            recien?.numero &&
            !confirmacion.pendiente(conversacion) &&
            esAfirmacion(texto) &&
            ahora().getTime() - Date.parse(recien.en) < MINUTOS_SI_REPETIDO * 60 * 1000
        ) {
            return {
                pasos: [paso('si_tras_confirmar', { numero: recien.numero })],
                respuestas: [
                    recien.capacidad === 'tomar_pedido'
                        ? `¡Ya quedó! 👍 Tu pedido ${recien.numero} está tomado. Si quieres cambiarle algo, dímelo.`
                        : `¡Ya quedó! 👍 (${recien.numero})`,
                ],
                variables: conMemoria(conversacion, { ultima_confirmacion: recien }),
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }

        // ⚠️ La confirmación pendiente manda sobre todo lo demás.
        //
        // Cuando hay una mutación esperando el sí, la política de enrutado manda el turno al
        // Nivel 1 — y desde el 24, «Nivel 1» significa **el flujo de esta vertical**, no la FSM
        // de citas. Sin esta rama, el cliente decía «sí» a «¿confirmo tu pedido?» y caía en
        // `delegar`: turno sin respuesta, silencio, y un pedido que nunca se creó. Nadie lo vio
        // porque hasta hoy ninguna confirmación de restaurante llegó a abrirse.
        if (confirmacion.pendiente(conversacion)) {
            // El formulario de entrega con un resumen ya esperando: no es un sí ni una nota de
            // cocina (ver `formularioConResumenEsperando`). Va antes que todo lo que mira solo la
            // última línea, que en un formulario es «Pago: …».
            const formularioTardio = formularioEntrega.leer(texto);
            if (formularioTardio) return formularioConResumenEsperando(ctx, formularioTardio);

            // Lo último que dijo el asistente fue una pregunta SUYA (la escalera lo marca con
            // `pregunta_abierta`): lo que llega ahora contesta esa pregunta, no la confirmación.
            // Un «sí» no ejecuta nada —se enseña el resumen otra vez, para que el sí sea a ESO—
            // y cualquier otra cosa la lee el modelo, que es quien preguntó. Un «no» sigue
            // siendo un no. Zona Burger, 2026-10-05: «¿Cuáles dos sabores prefieres?» → «si» →
            // pedido tomado sin los hervidos.
            const esNo = esComando(texto, COMANDO.NO) || esComando(texto, COMANDO.CANCELAR);
            // Una persona del local escribió después del resumen: este «sí» puede ser para ella.
            // No se ejecuta a ciegas —se enseña el resumen otra vez, para que el sí sea a ESO— y
            // el reloj del resumen se pone en hora, así el siguiente «sí» ya cuenta. No se suelta
            // la confirmación: los cajeros también le piden al cliente que confirme con el botón.
            const esperando = conversacion.tarea_datos || {};
            if (
                personaEscribioTrasElResumen(conversacion, esperando) &&
                esAfirmacionConEntrega(texto, esperando.args?.tipo_entrega)
            ) {
                const datos = {
                    ...esperando,
                    pregunta_abierta: false,
                    preguntado_en: ahora().toISOString(),
                };
                return {
                    pasos: [paso('confirmacion_si_tras_persona', { capacidad: datos.capacidad })],
                    respuestas: [
                        {
                            texto:
                                'Para no enviar algo distinto de lo que hablaste con el equipo, ' +
                                `te lo muestro otra vez 👇\n\n${await confirmacion.textoDePregunta(
                                    datos.capacidad,
                                    datos.args,
                                    { idNegocio: conversacion.id_negocio ?? null }
                                )} Respóndeme sí o no.`,
                            opciones: [
                                { id: 'si', etiqueta: 'Sí, confirmo' },
                                { id: 'no', etiqueta: 'No' },
                            ],
                        },
                    ],
                    variables: conMemoria(conversacion),
                    tarea: { nombre: confirmacion.TAREA, datos },
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            if (conversacion.tarea_datos?.pregunta_abierta && !esNo) {
                const datos = { ...conversacion.tarea_datos, pregunta_abierta: false };
                if (esAfirmacionConEntrega(texto, datos.args?.tipo_entrega)) {
                    return {
                        pasos: [paso('confirmacion_si_ambiguo', { capacidad: datos.capacidad })],
                        respuestas: [
                            {
                                texto: `${await confirmacion.textoDePregunta(datos.capacidad, datos.args, {
                                    idNegocio: conversacion.id_negocio ?? null,
                                })} Respóndeme sí o no.`,
                                opciones: [
                                    { id: 'si', etiqueta: 'Sí, confirmo' },
                                    { id: 'no', etiqueta: 'No' },
                                ],
                            },
                        ],
                        variables: conMemoria(conversacion),
                        tarea: { nombre: confirmacion.TAREA, datos },
                        resultado: 'resuelto',
                        nivel: 'determinista',
                    };
                }
                const { tarea: _sinTocar, ...cedido } = delegar(ctx);
                return { ...cedido, pasos: [paso('confirmacion_respuesta_al_modelo')] };
            }
            // «¿Vale 7.000 el domicilio?» o «¿cuánto se demora?» mientras se le pide el sí: son
            // preguntas razonables ANTES de confirmar. Se contestan y se vuelve a pedir el sí, sin
            // gastar la repregunta (el cliente no se desvió: está decidiendo). Antes se le repetía
            // el resumen entero sin contestarle (Zona Burger, 2026-10-02).
            const respuestaPrevia = esPreguntaDeDomicilio(texto)
                ? fraseDeDomicilio(negocio.domicilioRango)
                : esPreguntaDeTiempo(texto)
                  ? fraseDeTiempo(tiempoPara(negocio, conversacion.tarea_datos?.args?.tipo_entrega), {
                        hayPedido: false,
                    })
                  : null;
            if (respuestaPrevia) {
                return {
                    pasos: [paso('confirmacion_pregunta_contestada', {
                        tema: esPreguntaDeDomicilio(texto) ? 'domicilio' : 'tiempo',
                    })],
                    respuestas: [
                        {
                            texto: `${respuestaPrevia}\n\n¿Entonces confirmo tu pedido? Respóndeme sí o no.`,
                            opciones: [
                                { id: 'si', etiqueta: 'Sí, confirmo' },
                                { id: 'no', etiqueta: 'No' },
                            ],
                        },
                    ],
                    variables: conMemoria(conversacion),
                    // El pendiente sigue igual: ni se toca su hora ni sus repreguntas.
                    tarea: { nombre: confirmacion.TAREA, datos: conversacion.tarea_datos },
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            // Cualquier otra pregunta («¿lo tienes en combo?», «el domicilio siempre me cobran 6
            // mil») o un cambio («cambios», «no necesito empaque, allá voy a consumir») lo atiende
            // el modelo, con el pedido todavía esperando su sí: antes se le repetía el resumen sin
            // contestarle, o la frase acababa en la nota de cocina (2026-10-04). La tarea no se
            // toca (`sin tarea` en la decisión) y el motor la conserva; el modelo puede rehacer
            // el pedido con el cambio, lo que abre una confirmación nueva.
            if (vaAlModeloDuranteLaConfirmacion(texto, conversacion.tarea_datos)) {
                // Habla de OTRA entrega que la del resumen («¿hacen domicilio?» con un pedido
                // «para recoger» esperando, o «¿me queda cerca para ir a recoger?» con un
                // domicilio): ese resumen ya no es lo que quiere, y dejarlo vivo
                // es dejar un «sí» que crea el pedido equivocado. Zona Burger, 2026-10-05: el
                // bot pidió la dirección y a la vez «¿lo confirmo?»; el cliente tocó «Sí» y el
                // domicilio quedó tomado para recoger. Se suelta la confirmación y el modelo
                // rehace el pedido con lo que falte.
                const cambio = entregaQueCambia(texto, conversacion.tarea_datos);
                if (cambio) {
                    return {
                        ...delegar(ctx),
                        soltarTarea: true,
                        notaParaElModelo:
                            '[Nota del sistema, no del cliente: había un pedido esperando el sí ' +
                            `(${ENTREGA_EN_PALABRAS[cambio.de]}) y el cliente ahora habla de ` +
                            `${ENTREGA_EN_PALABRAS[cambio.a]}. Esa confirmación se DESCARTÓ: no se ha ` +
                            'enviado nada. Contesta lo que pregunta y averigua cómo lo quiere recibir; ' +
                            'si es a domicilio pide la dirección y un número de contacto. Cuando lo ' +
                            'tengas, vuelve a llamar la herramienta del pedido. Lo que estaba ' +
                            `anotado: ${JSON.stringify(conversacion.tarea_datos?.args ?? {})}]`,
                        pasos: [paso('confirmacion_soltada_por_entrega', cambio)],
                    };
                }
                const { tarea: _sinTocar, ...cedido } = delegar(ctx);
                return {
                    ...cedido,
                    notaParaElModelo: notaDeLoAnotado(conversacion.tarea_datos),
                    pasos: [paso('confirmacion_pregunta_al_modelo')],
                };
            }
            await conIdentidad(ctx);
            const decision = await confirmacion.resolver(ctx, { gate });
            return { ...decision, invocaciones: [...invocaciones, ...(decision.invocaciones || [])] };
        }

        // Una foto, un audio o una ubicación suelta, sin pedido a medias: no se ve, se le pasa a una
        // persona (que además la ve en la Bandeja) en vez de improvisar con el modelo.
        const media = conversacion.tarea_actual === TAREA_PEDIDO ? null : mediaSuelta(texto);
        if (media) {
            const quien = String(negocio.tratamiento || '').trim();
            const equipo = quien && quien !== 'el negocio' ? `alguien del equipo de ${quien}` : 'alguien del equipo';
            return {
                pasos: [paso('media_a_persona', { tipo: media })],
                respuestas: [
                    `Recibí ${MEDIA_PARA_PERSONA[media]} 🙌 Se la paso a ${equipo}, que la revisa y te contesta por este mismo chat.`,
                ],
                variables: conMemoria(conversacion),
                tarea: null,
                estado: 'handoff_humano',
                resultado: 'handoff',
                nivel: 'determinista',
            };
        }

        // Lo PRIMERO después: ¿viene con el carrito del menú digital? Va antes que cualquier
        // otra lectura porque el mensaje trae texto humano delante («Hola, quiero pedir…») que
        // si no se confundiría con un saludo, y el cliente recibiría la bienvenida en vez de su
        // pedido.
        const delMenu = codigoPedido.leer(texto);
        if (delMenu) {
            await conIdentidad(ctx);
            await conCatalogo(ctx);
            return recibirPedidoDelMenu(ctx, delMenu, {
                solicitarConfirmacion: (peticion) => confirmacion.solicitar(peticion),
            });
        }

        // Con el negocio fuera de servicio contesta el flujo, no el modelo: dice el horario y
        // deja la carta (ver `fueraDeServicio`). Va después del carrito —un pedido de la carta
        // tiene su propio camino y su propio rechazo— y antes del tiempo y del domicilio:
        // «¿cuánto vale el domicilio?» a las 11 de la noche se contesta con «estamos cerrados».
        const cerrado = await fueraDeServicio(conversacion, {
            ahora: ahora(),
            estadoAtencion,
            tienePedidoReciente,
        });
        if (cerrado) return avisoFueraDeServicio(ctx, cerrado, { proximaApertura });

        // El formulario de entrega: con el pedido a medias lo lee el pedido, antes que las
        // preguntas de tiempo o de domicilio —que miran la última línea, y unas indicaciones
        // pueden terminar en «¿cuánto se demora?»—. Sin pedido abierto (lo ofreció el modelo) lo
        // atiende el modelo, con una nota de qué es y de dónde va la forma de pago.
        const formularioSuelto = formularioEntrega.leer(texto);
        if (formularioSuelto && conversacion.tarea_actual === TAREA_PEDIDO) {
            await conIdentidad(ctx);
            await conCatalogo(ctx);
            return seguirPedido(ctx, {
                solicitarConfirmacion: (peticion) => confirmacion.solicitar(peticion),
            });
        }
        if (formularioSuelto) {
            return {
                ...delegar(ctx),
                notaParaElModelo:
                    '[Nota del sistema, no del cliente: este mensaje es el formulario de entrega que ' +
                    'llenó el cliente. Úsalo para el pedido que está armando: llama la herramienta del ' +
                    'pedido con esa entrega y, si es a domicilio, ese barrio (en `barrio`) y esa dirección (las ' +
                    'indicaciones van con la dirección; el teléfono, si viene, en `cliente_telefono`); ' +
                    'la forma de pago va en la nota como «Pago: …». ' +
                    'No le vuelvas a preguntar lo que ya llenó. Si en la conversación no hay ningún ' +
                    'pedido, pregúntale qué quiere pedir.]',
                pasos: [paso('formulario_sin_pedido_al_modelo')],
            };
        }

        // ── «Cancelar» y pagar ──────────────────────────────────────────────────────────────
        // En Colombia «cancelar» es PAGAR. Con cualquier «cancel…» se pregunta qué quiere, con dos
        // botones, y NO se anula nada por una palabra ambigua (ver `pago.js`). Solo sin un pedido a
        // medias: durante uno, «cancelar» ya significa dejar de armarlo.
        if (!conversacion.tarea_actual) {
            if (pago.eligioAnular(texto)) {
                await conIdentidad(ctx);
                const pedido = await pago.ultimoPedidoVivo(conversacion);
                if (!pedido) {
                    return {
                        pasos: [paso('anular_sin_pedido')],
                        respuestas: [
                            'No encuentro un pedido tuyo vivo por aquí. Si quieres anular uno, escríbeme su número (ORD-…) o llama al restaurante 🙏',
                        ],
                        variables: conMemoria(conversacion),
                        tarea: null,
                        resultado: 'resuelto',
                        nivel: 'determinista',
                    };
                }
                return confirmacion.solicitar({
                    capacidad: 'cancelar_pedido',
                    args: { numero_orden: pedido.numero_orden },
                    conversacion,
                    pasos: [paso('anular_elegido', { numero_orden: pedido.numero_orden })],
                    nivel: 'determinista',
                });
            }

            const preguntaDePago = pago.esPreguntaDePago(texto, { hayPedido: true });
            if (pago.eligioPagar(texto) || preguntaDePago) {
                const pedido = await pago.ultimoPedidoVivo(conversacion);
                // «Nequi» a secas solo cuenta con un pedido ya hecho; sin él lo atiende el modelo.
                const vale = pago.eligioPagar(texto) || pago.esPreguntaDePago(texto, { hayPedido: Boolean(pedido) });
                const frase = vale ? pago.frasePago(pedido?.tipo_pedido, await pago.textosDePago(ctx.idNegocio)) : null;
                if (frase) {
                    return {
                        pasos: [paso('pago_respondido', { tipo: pedido?.tipo_pedido ?? null })],
                        respuestas: [frase],
                        variables: conMemoria(conversacion),
                        tarea: null,
                        resultado: 'resuelto',
                        nivel: 'determinista',
                    };
                }
            }

            if (pago.esCancelarAmbiguo(texto)) {
                return {
                    pasos: [paso('cancelar_ambiguo')],
                    respuestas: [
                        {
                            texto: pago.PREGUNTA_ANULAR_O_PAGAR,
                            opciones: [
                                { id: pago.OPCION_PAGO.ANULAR, etiqueta: 'Anular el pedido' },
                                { id: pago.OPCION_PAGO.PAGAR, etiqueta: 'Pagar' },
                            ],
                        },
                    ],
                    variables: conMemoria(conversacion),
                    tarea: null,
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
        }

        // ¿Pregunta por su pedido y quien lo atendió fue una persona del local? Ese pedido lo
        // tomó ella a mano y aquí no se ve: decir «no tengo ningún pedido tuyo» es falso. Se le
        // devuelve a la persona. Sin persona reciente, lo de siempre (tiempo o modelo).
        const quien = String(negocio.tratamiento || '').trim();
        const equipo = quien && quien !== 'el negocio' ? `alguien del equipo de ${quien}` : 'alguien del equipo';
        const aPersona = (decision, texto) => ({
            pasos: [paso(decision)],
            respuestas: [texto],
            variables: conMemoria(conversacion),
            tarea: null,
            estado: 'handoff_humano',
            resultado: 'handoff',
            nivel: 'determinista',
        });

        // «¿Cuántas cajas vienen?»: ningún dato del sistema lo dice, y el modelo contestó «una
        // sola caja» a quien siempre recibe caja y media (2026-10-04). No se adivina: a una persona.
        if (!conversacion.tarea_actual && preguntaPorEmpaque(texto)) {
            return aPersona(
                'empaque_a_persona',
                `No tengo ese dato con exactitud 🙏 Ya le dejé tu pregunta a ${equipo}, que te responde por este mismo chat.`
            );
        }

        const porSuPedido = preguntaPorSuPedido(texto);
        if (!conversacion.tarea_actual && (porSuPedido || esPreguntaDeTiempo(texto))) {
            const hayPedidoDelBot = await tienePedidoReciente(conversacion);
            // ¿Lo atendió una persona? Ese pedido lo tomó ella a mano y aquí no se ve: decir «no
            // tengo ningún pedido tuyo» es falso. Se le devuelve a la persona.
            if (!hayPedidoDelBot && personaAtendioHacePoco(conversacion, ahora())) {
                return aPersona(
                    'pedido_de_persona_a_persona',
                    `Tu pedido lo está llevando ${equipo} 🙌 Ya le dejé tu mensaje para que te cuente cómo va.`
                );
            }
            // ¿Ya se le contestó cómo va y vuelve a preguntar? La primera vez se contesta; la
            // segunda, repetir el estado («va en 57 minutos…») suena a reproche y no le sirve:
            // lo que necesita es que alguien del local mire su pedido (pedido del dueño, 2026-10-04).
            if (hayPedidoDelBot && (await yaSeLeContestoSuPedido(conversacion))) {
                return aPersona(
                    'pedido_repreguntado_a_persona',
                    `Ya le dejé tu mensaje a ${equipo}, que te cuenta cómo va tu pedido por este mismo chat 🙌`
                );
            }
        }
        if (porSuPedido && !esPreguntaDeTiempo(texto) && !conversacion.tarea_actual) return delegar(ctx);

        // «¿Cuánto se demora?» — se contesta con el tiempo que declaró el negocio. Va ANTES del
        // pedido a medias: ahí cualquier texto se leería como la respuesta al paso pendiente
        // («¿a nombre de quién?» → «cuánto se demora»), y apuntar una pregunta como nombre o
        // dirección es justo lo que ese flujo se esfuerza en no hacer.
        if (esPreguntaDeTiempo(texto)) {
            // A mitad de un pedido todavía no hay pedido: el tiempo se dice «desde que se
            // confirma». Fuera de un pedido, solo se dice «tu pedido» si este chat tiene uno de
            // verdad; si no, se avisa de que aún no hay ninguno y se ofrece tomarlo.
            const armando = conversacion.tarea_actual === TAREA_PEDIDO;
            const hayPedido = !armando && (await tienePedidoReciente(conversacion));
            // Contesta cómo lo recibe Y pregunta el tiempo, sin pedido todavía: «Me confirmas en
            // cuánto está, yo paso a recogerla». Contestarle solo el tiempo era no oírle la
            // mitad: se le dijo «todavía no tengo ningún pedido tuyo» y tuvo que repetirlo entero
            // (Zona Burger, 2026-10-07). Lo sigue el modelo, que lleva el hilo, con el tiempo en
            // la mano para decirlo en el mismo mensaje.
            const entregaDicha = entregaNombrada(
                normalizar(ultimaLinea(texto)).replace(/[¡¿!?.,;:]/g, ' ').replace(/\s+/g, ' ').trim()
            );
            if (!armando && !hayPedido && entregaDicha) {
                const cuanto = minutosEnPalabras(tiempoPara(negocio, entregaDicha));
                return {
                    ...delegar(ctx),
                    notaParaElModelo:
                        '[Nota del sistema, no del cliente: en este mensaje el cliente dice cómo ' +
                        `recibe el pedido (${ENTREGA_EN_PALABRAS[entregaDicha]}) y además pregunta ` +
                        'cuánto tarda. ' +
                        (cuanto
                            ? `El tiempo para esa entrega es ${cuanto.replace(/\*/g, '')}, contado desde que se confirma. `
                            : '') +
                        'Toma su respuesta: si ya tienes todo lo del pedido, llama la herramienta ' +
                        'del pedido ahora (el resumen ya dice el tiempo); si te falta algo, pídeselo ' +
                        'y dile el tiempo en la misma frase. No le digas que no tiene ningún pedido.]',
                    pasos: [paso('tiempo_con_entrega_al_modelo', { entrega: entregaDicha })],
                };
            }
            // Con pedido, el tiempo de cómo lo recibe ESE pedido; armándolo, el de lo que lleva
            // dicho; sin nada, los dos tiempos si el negocio los separó.
            const tipoDelPedido = hayPedido
                ? (await pago.ultimoPedidoVivo(conversacion))?.tipo_pedido ?? null
                : armando
                  ? datosDelPedido(conversacion)?.entrega ?? null
                  : null;
            const frase =
                (!armando && !hayPedido && fraseDeLosDosTiempos(negocio, { ofrecerTomarlo: true })) ||
                fraseDeTiempo(tiempoPara(negocio, tipoDelPedido), {
                    hayPedido,
                    ofrecerTomarlo: !armando && !hayPedido,
                });
            if (frase && armando) {
                // Se contesta Y se retoma lo que faltaba, sin tocar la tarea ni el contador de
                // repreguntas: el cliente preguntó algo razonable, no se equivocó.
                await conIdentidad(ctx);
                await conCatalogo(ctx);
                const datos = datosDelPedido(conversacion);
                const q = pregunta(datos.paso, datos, ctx);
                return {
                    pasos: [paso('tiempo_estimado_respondido', { paso: datos.paso ?? null })],
                    respuestas: [{ ...q, texto: `${frase}\n\n${q.texto}` }],
                    variables: conMemoria(conversacion),
                    tarea: tareaPedido(datos),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            if (frase) {
                return {
                    pasos: [paso('tiempo_estimado_respondido', { hay_pedido: hayPedido })],
                    respuestas: [frase],
                    variables: conMemoria(conversacion),
                    tarea: null,
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            // Sin tiempo configurado no se inventa uno: lo atiende el modelo, como hasta hoy.
            if (conversacion.tarea_actual !== TAREA_PEDIDO) return delegar(ctx);
        }

        // «¿Cuánto vale el domicilio?» — mismo trato que el tiempo, y antes del pedido a medias
        // por la misma razón: la pregunta no es la respuesta al paso pendiente.
        if (esPreguntaDeDomicilio(texto)) {
            const frase = fraseDeDomicilio(negocio.domicilioRango);
            if (frase && conversacion.tarea_actual === TAREA_PEDIDO) {
                await conIdentidad(ctx);
                await conCatalogo(ctx);
                const datos = datosDelPedido(conversacion);
                const q = pregunta(datos.paso, datos, ctx);
                return {
                    pasos: [paso('valor_domicilio_respondido', { paso: datos.paso ?? null })],
                    respuestas: [{ ...q, texto: `${frase}\n\n${q.texto}` }],
                    variables: conMemoria(conversacion),
                    tarea: tareaPedido(datos),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            if (frase) {
                return {
                    pasos: [paso('valor_domicilio_respondido')],
                    respuestas: [frase],
                    variables: conMemoria(conversacion),
                    tarea: null,
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            if (conversacion.tarea_actual !== TAREA_PEDIDO) return delegar(ctx);
        }

        // Un pedido a medias: falta el nombre, el teléfono, la dirección o cómo paga. Mientras
        // la tarea esté abierta, la política de enrutado devuelve aquí cada mensaje, así que el
        // modelo no puede llevarse la conversación a mitad de camino ni olvidarse de lo que ya
        // está apuntado.
        if (conversacion.tarea_actual === TAREA_PEDIDO) {
            await conIdentidad(ctx);
            await conCatalogo(ctx);
            return seguirPedido(ctx, {
                solicitarConfirmacion: (peticion) => confirmacion.solicitar(peticion),
            });
        }

        const t = normalizar(ultimaLinea(texto));

        if (t === OPCION.MENU || /\b(ver el menu|el menu|la carta|menu digital)\b/.test(t)) {
            return mandarElMenu(ctx);
        }
        if (t === OPCION.CHAT || /\b(pedir por aqui|por aqui|por chat)\b/.test(t)) {
            return abrirPedidoPorChat(ctx, leerCarta);
        }

        // ⚠️ Solo un saludo o «menú» reabren la bienvenida.
        //
        // Antes se re-saludaba ante CUALQUIER cosa que llegara aquí, y eso rompía la
        // conversación de una forma difícil de ver: la política de enrutado manda al flujo
        // determinista todo lo que sea un «comando conocido» —y esa lista incluye «sí», «no»,
        // «ok», «vale»—. Así que el cliente contestaba «sí» a una pregunta del modelo y recibía
        // el saludo inicial otra vez, como si el bot se hubiera reiniciado. Visto en producción
        // el 2026-08-24.
        //
        // Ahora, lo que no reconoce se lo pasa al modelo, que es quien tiene el hilo.
        // `esSaludo` además de la lista, y no en su lugar: la lista trae «menu», «inicio» y
        // «empezar», que no son saludos pero sí piden la bienvenida. El saludo suelto lo lee
        // `esSaludo`, que tolera signos, vocales repetidas y faltas —«Buenas!», «holaa»,
        // «buens»—, que era por donde se escapaba al modelo.
        if (esSaludo(texto) || esComando(texto, COMANDO.MENU) || !conversacion.variables?.turnos) {
            return bienvenida(ctx, [paso('inicio_conversacion')], { estadoAtencion, proximaApertura });
        }
        return delegar(ctx);
    };
}

module.exports = {
    VERTICAL,
    TIPOS_NEGOCIO,
    yaSeContestoElEstado,
    OPCION,
    ENTREGA,
    TAREA_PEDIDO,
    PASO_PEDIDO,
    reclama,
    fueraDeServicio,
    avisoFueraDeServicio,
    esPreguntaDeTiempo,
    mediaSuelta,
    fraseDeTiempo,
    esPreguntaDeDomicilio,
    fraseDeDomicilio,
    rangoEnPalabras,
    huecosDelCliente,
    interpretarDatos,
    leerTelefono,
    leerEntrega,
    elegirBarrio,
    barrioEnTexto,
    soloComoConjunto,
    resumenPorZona,
    elegirMesa,
    OTRO_BARRIO,
    // Expuestos para las pruebas, como `tareaCaducada` en la escalera: son las dos piezas de
    // producto que conviene poder ejercitar sin montar una conversación entera.
    pareceDireccion,
    anadeProducto,
    // Lo usa también la pregunta de confirmación (`index.js`). Va desde aquí y no copiado allá
    // porque «cómo se le escribe un precio a un cliente» es una decisión, y dos copias divergen.
    enPesos,
    fraseDeApertura,
    crearFlujoRestaurante,
    manejarRestaurante: crearFlujoRestaurante(),
    enlaceDelMenu,
};
