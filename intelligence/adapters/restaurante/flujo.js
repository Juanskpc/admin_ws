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
const { COMANDO, normalizar, ultimaLinea, esComando, saludoPorLaHora } = require('../../engine/texto');
const codigoPedido = require('./codigoPedido');
const confirmacion = require('../../engine/confirmacion');
const policyGate = require('../../core/policyGate');
const identidadReal = require('../../engine/identidad');

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
 */
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
                    `👋 ${saludoPorLaHora(ctx.ahora())} Te saluda *${ctx.negocio.tratamiento}*.`,
                    '',
                    'Aquí tienes la carta completa, con fotos y precios 👇',
                    enlace,
                    '',
                    'Armas tu pedido ahí y vuelves a este chat con todo listo 🛵',
                    '',
                    'O si prefieres, dime por aquí qué se te antoja y yo te lo anoto. ' +
                        'También te digo precios o en qué va un pedido que ya hiciste.',
                ].join('\n'),
                // Una sola opción y sin `detalle`: con detalle, el canal la pinta como una
                // LISTA —un menú que hay que desplegar para ver una única entrada—, y eso es
                // un toque de más para nada. Sin detalle cabe en un botón, que se pulsa directo.
                opciones: [{ id: OPCION.CHAT, etiqueta: 'Pedir por aquí' }],
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
 * `PAGO` se salta si el negocio no tiene métodos configurados. Quedarse sin poder pedir porque
 * nadie llenó una tabla de catálogo sería peor que tomar el pedido sin saber cómo paga.
 */
const PASO_PEDIDO = {
    NOMBRE: 'nombre',
    /**
     * Todo lo demás, en una sola pregunta: teléfono (a quien haga falta), dirección y cómo paga.
     *
     * Hasta el 2026-08-27 se pedían de uno en uno, y estaba escrito por qué: «un cuestionario de
     * cinco campos es lo que se hace cuando al otro lado hay una persona leyendo a mano». El
     * argumento era bueno y el resultado, no: cuatro turnos y cuatro esperas para tres datos que
     * el cliente tiene en la cabeza a la vez. Decisión del dueño ese día.
     *
     * El nombre se queda aparte a propósito. Es el primero, se contesta con una palabra y es lo
     * que convierte el trámite en una conversación; mezclarlo con la dirección y el pago lo
     * volvería la primera casilla de un formulario.
     *
     * Los tres sueltos siguen existiendo porque **una respuesta parcial vuelve a preguntar solo
     * lo que falte**, y ahí sí se pregunta de a uno.
     */
    DATOS: 'datos',
    TELEFONO: 'telefono',
    DIRECCION: 'direccion',
    PAGO: 'pago',
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
    if (!datos.telefono && !telefonoProbado) faltan.push(PASO_PEDIDO.TELEFONO);
    if (!datos.direccion) faltan.push(PASO_PEDIDO.DIRECCION);
    // Y solo si el negocio tiene métodos que ofrecer.
    if (!datos.id_metodo_pago && (datos.metodos || []).length > 0) faltan.push(PASO_PEDIDO.PAGO);
    return faltan;
}

function loQueFalta(datos, ctx) {
    if (!datos.nombre) return PASO_PEDIDO.NOMBRE;
    const faltan = huecosDelCliente(datos, ctx);
    if (faltan.length === 0) return null;
    // Uno solo se pregunta por su nombre; varios, todos juntos. Preguntar «necesito una cosita»
    // y listar un solo punto se lee peor que preguntarla directamente.
    return faltan.length === 1 ? faltan[0] : PASO_PEDIDO.DATOS;
}

/**
 * La pregunta del pago, con los datos de cada método pegados a su nombre.
 *
 * ## Por qué los datos van AQUÍ y no después de elegir
 *
 * Porque el cliente decide cómo paga **sabiendo** si puede. Preguntar primero y enseñar la
 * cuenta después obliga a quien no tiene Nequi a elegirlo para descubrirlo, y a volver atrás
 * — y volver atrás en un flujo determinista es justo donde se pierde la gente.
 *
 * Un método sin datos sale solo con su nombre, sin guión suelto ni hueco: la mayoría no
 * necesita ninguno («Efectivo» se explica solo).
 *
 * Las opciones estructuradas siguen yendo aparte, en `opciones[]`, para que cada canal las
 * pinte como sepa (ADR-017). Esto es solo el texto que las acompaña.
 */
function lineasDePago(metodos = []) {
    return metodos.map((m) => (m.datos ? `• *${m.nombre}* — ${m.datos}` : `• *${m.nombre}*`));
}

function textoDelPago(metodos = []) {
    const conDatos = (metodos || []).filter((m) => m.datos);
    if (conDatos.length === 0) return '¿Cómo vas a pagar? 💵';
    return `¿Cómo vas a pagar? 💵\n\n${lineasDePago(metodos).join('\n')}`;
}

/**
 * Los dos o tres datos que faltan, en un solo mensaje.
 *
 * Se enumera con viñetas y no en prosa a propósito: una lista corta se contesta mirándola, y el
 * cliente puede mandar las tres cosas en una línea o en tres. Lo que llegue se lee con
 * `interpretarDatos`, y **lo que no se entienda se vuelve a preguntar solo**.
 *
 * Las opciones estructuradas del pago **no** viajan aquí aunque el pago esté entre lo que falta:
 * un botón «Transferencia» al lado de «mándame tu dirección» invita a pulsarlo y dejar el resto
 * sin contestar. Los botones vuelven si hay que repreguntar el pago a solas.
 */
function preguntaCombinada(datos, ctx) {
    const faltan = huecosDelCliente(datos, ctx || {});
    const lineas = faltan.map((hueco) => {
        if (hueco === PASO_PEDIDO.TELEFONO) {
            return '📱 Un número de contacto, para que el domiciliario te llame al llegar';
        }
        if (hueco === PASO_PEDIDO.DIRECCION) {
            return '📍 La dirección, con el barrio o alguna indicación para llegar';
        }
        return `💵 Cómo vas a pagar:\n${lineasDePago(datos.metodos).join('\n')}`;
    });

    return {
        texto:
            `Para mandártelo necesito ${faltan.length === 2 ? 'dos cositas' : 'tres cositas'}. ` +
            `Puedes contestarme todo junto 👇\n\n${lineas.join('\n\n')}`,
    };
}

/** Qué se le dice al cliente en cada paso. Las opciones solo las tiene el del pago. */
function pregunta(paso, datos, ctx) {
    switch (paso) {
        case PASO_PEDIDO.NOMBRE:
            return { texto: '¿A nombre de quién lo dejo? 📝' };
        case PASO_PEDIDO.TELEFONO:
            // Se dice PARA QUÉ. Un bot que pide un teléfono sin explicarse parece que está
            // recogiendo datos; el motivo —que el domiciliario pueda llamar— es real y además
            // es el que hace que la gente lo dé.
            return {
                texto:
                    '¿Me das un número de contacto? 📱 Es para que el domiciliario pueda ' +
                    'llamarte cuando esté cerca.',
            };
        case PASO_PEDIDO.DIRECCION:
            return {
                texto:
                    '¿A qué dirección te lo llevamos? 🛵 Dime también si hay alguna indicación ' +
                    'para llegar.',
            };
        case PASO_PEDIDO.DATOS:
            return preguntaCombinada(datos, ctx);
        case PASO_PEDIDO.PAGO:
            return {
                texto: textoDelPago(datos.metodos),
                // Los ids son los reales del negocio, no ordinales: es la misma lección que
                // dejó la categoría «2» del 2026-08-24. Y el canal los pinta como botones o
                // lista según cuántos haya.
                opciones: datos.metodos.map((m) => ({ id: String(m.id), etiqueta: m.nombre })),
            };
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
            items: datos.items,
            cliente_nombre: datos.nombre,
            direccion: datos.direccion,
            ...(datos.telefono ? { cliente_telefono: datos.telefono } : {}),
            ...(datos.id_metodo_pago ? { id_metodo_pago: datos.id_metodo_pago } : {}),
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
function recibirPedidoDelMenu(ctx, pedido, { solicitarConfirmacion }) {
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
        metodos: ctx.metodosDePago || [],
        ...(previas.nombre ? { nombre: previas.nombre } : {}),
    };

    return seguirOConfirmar(
        ctx,
        datos,
        [paso('pedido_del_menu_recibido', { items: pedido.items.length, unidades: cuantos })],
        {
            apertura:
                `¡Listo, ya tengo tu pedido! ${cuantos === 1 ? 'Es 1 producto' : `Son ${cuantos} productos`}` +
                `${previas.nombre ? `, a nombre de ${previas.nombre}` : ''}. `,
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
    // repetir la dirección porque no se entendió el método de pago sería castigarle por
    // habernos contestado.
    if (datos.paso === PASO_PEDIDO.DATOS) {
        const faltan = huecosDelCliente(datos, ctx);
        const leido = interpretarDatos(dicho, { faltan, metodos: datos.metodos || [] });

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
        case PASO_PEDIDO.TELEFONO:
            conLoDicho.telefono = dicho;
            break;
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
        case PASO_PEDIDO.PAGO: {
            const elegido = elegirMetodo(dicho, datos.metodos || []);
            if (!elegido) {
                // No se adivina. Un método de pago mal leído es una discusión en la puerta con
                // el domiciliario delante — la misma razón por la que el precio se relee del
                // catálogo en vez de creerse el de la conversación.
                const q = pregunta(PASO_PEDIDO.PAGO, datos, ctx);
                return {
                    pasos: [paso('pedido_pago_no_reconocido', { dijo: dicho.slice(0, 40) })],
                    respuestas: [{ ...q, texto: `No te entendí cuál. ${q.texto}` }],
                    variables: conMemoria(ctx.conversacion),
                    tarea: tareaPedido(conLoDicho),
                    resultado: 'resuelto',
                    nivel: 'determinista',
                };
            }
            conLoDicho.id_metodo_pago = elegido.id;
            conLoDicho.metodo_nombre = elegido.nombre;
            break;
        }
        default:
            break;
    }

    return seguirOConfirmar(ctx, conLoDicho, [paso('pedido_dato_recibido', { paso: datos.paso })], {
        apertura,
        solicitarConfirmacion,
    });
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

/**
 * Lee de un mensaje suelto los datos que se le pidieron juntos.
 *
 * Devuelve **solo lo que reconoce**. Lo que no, se vuelve a preguntar: adivinar aquí sale caro
 * en la puerta de una casa, y el coste de repreguntar es un mensaje.
 *
 * ## El orden importa, y no es casual
 *
 * Se saca primero el teléfono y luego el método de pago, y **lo que sobra** es la dirección.
 * Al revés, «Nequi» se colaría dentro de la dirección y el número de contacto se quedaría
 * pegado al número de la casa. La dirección es lo más difícil de reconocer y lo más fácil de
 * describir por descarte: es el resto.
 */
function interpretarDatos(texto, { faltan, metodos = [] }) {
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

    if (faltan.includes(PASO_PEDIDO.PAGO)) {
        // Se busca el nombre del método dentro del texto, no una línea entera: el cliente
        // escribe «pago con Nequi» y no «Nequi» a secas.
        const metodo = metodoMencionado(resto, metodos);
        if (metodo) {
            leido.id_metodo_pago = metodo.id;
            leido.metodo_nombre = metodo.nombre;
            resto = quitarMencion(resto, metodo.nombre);
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
 * Palabras de relleno que quedan colgando cuando se recorta el teléfono y el método de pago.
 *
 * «Calle 45 #12-30, barrio El Prado. Mi cel es 3152812484 y pago con transferencia» deja, tras
 * quitar las dos piezas reconocidas, un «Mi cel es y pago con» pegado al final de la dirección.
 * No estorba al domiciliario, pero se guarda en la orden y se imprime en la comanda.
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

/** ¿Se nombra alguno de los métodos dentro del texto? Devuelve el más largo que case. */
function metodoMencionado(texto, metodos) {
    const t = normalizar(texto);
    if (!t) return null;
    // El más largo primero: si hay «Nequi» y «Nequi Bancolombia», gana el específico.
    const ordenados = [...(metodos || [])].sort((a, b) => b.nombre.length - a.nombre.length);
    return ordenados.find((m) => t.includes(normalizar(m.nombre))) || null;
}

function quitarMencion(texto, nombre) {
    const escapado = String(nombre).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return texto.replace(new RegExp(escapado, 'ig'), ' ');
}

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
 * Resuelve lo que dijo el cliente contra los métodos que se le ofrecieron.
 *
 * Tres pasadas, la misma idea que en la FSM de citas: el id exacto (lo que manda un botón), el
 * nombre exacto, y por último que uno contenga al otro («efectivo» ↔ «Efectivo contra entrega»).
 * Se resuelve **contra la lista real** y no sacando un número del texto: el WebChat manda la
 * etiqueta del chip al pulsarlo, y «Efectivo (2)» daría el método 2, que es otro.
 */
function elegirMetodo(dicho, metodos) {
    const t = normalizar(dicho);
    if (!t || metodos.length === 0) return null;

    return (
        metodos.find((m) => String(m.id) === t) ||
        metodos.find((m) => normalizar(m.nombre) === t) ||
        metodos.find((m) => normalizar(m.nombre).includes(t) || t.includes(normalizar(m.nombre))) ||
        null
    );
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
    const categorias = await cartaService.getCartaPublica(idNegocio);

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
 * Los métodos de pago que ofrece ESTE negocio.
 *
 * Lectura directa del contrato público de la vertical, por lo mismo que la carta: es el flujo
 * pintando su propia pregunta, no el asistente decidiendo nada. Pasarlo por el Policy Gate
 * gastaría una clave de idempotencia y una fila de Ledger por cada pedido para leer un catálogo
 * de tres filas.
 *
 * Si falla, se devuelve vacío y el paso del pago **se salta**: quedarse sin poder pedir porque
 * no se pudo leer una tabla de catálogo sería cambiar un dato que falta por una venta que no se
 * hace.
 */
async function metodosDePagoDe(idNegocio) {
    const metodoPagoService = require('../../../app_restaurante_api/services/metodoPagoService');
    const metodos = await metodoPagoService.listar(idNegocio).catch(() => []);
    return metodos.slice(0, 10).map((m) => ({
        id: m.id_metodo_pago,
        nombre: m.nombre,
        // A dónde se paga. Viaja en la tarea junto al resto: el cliente tiene que ver la misma
        // cuenta que se le enseñó, aunque el dueño la cambie a mitad del pedido.
        datos: m.datos_pago || null,
    }));
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
function reclama(texto) {
    return Boolean(codigoPedido.leer(texto));
}

/**
 * Crea el manejador. La inyección existe para los tests, igual que en el flujo de `reserva`.
 * `ahora` también se inyecta: el saludo depende de la hora y una prueba no puede esperar a que
 * sean las ocho de la tarde.
 */
function crearFlujoRestaurante({
    contextoNegocio: ctxNegocio = contextoNegocio,
    leerCarta = cartaDe,
    leerMetodosPago = metodosDePagoDe,
    ahora = () => new Date(),
    // El Gate y la identidad solo hacen falta para cerrar un pedido: son lo que convierte el
    // «sí» del cliente en una orden. Se inyectan por lo mismo que en la FSM de citas — que un
    // test del flujo no necesite Postgres.
    gate = policyGate,
    identidad = identidadReal,
} = {}) {
    /**
     * Rellena el contexto con quién es el cliente.
     *
     * `telefonoProbado` es la mitad que decide si hay que pedirle el número: es lo que el canal
     * **probó**, no lo que nadie dijo. Con el BSUID de WhatsApp puede ser nulo, y ahí es donde
     * aparece el paso del teléfono.
     */
    async function conIdentidad(ctx) {
        ctx.identidad = await identidad.resolver(ctx.conversacion);
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

        // ⚠️ La confirmación pendiente manda sobre todo lo demás.
        //
        // Cuando hay una mutación esperando el sí, la política de enrutado manda el turno al
        // Nivel 1 — y desde el 24, «Nivel 1» significa **el flujo de esta vertical**, no la FSM
        // de citas. Sin esta rama, el cliente decía «sí» a «¿confirmo tu pedido?» y caía en
        // `delegar`: turno sin respuesta, silencio, y un pedido que nunca se creó. Nadie lo vio
        // porque hasta hoy ninguna confirmación de restaurante llegó a abrirse.
        if (confirmacion.pendiente(conversacion)) {
            await conIdentidad(ctx);
            const decision = await confirmacion.resolver(ctx, { gate });
            return { ...decision, invocaciones: [...invocaciones, ...(decision.invocaciones || [])] };
        }

        // Lo PRIMERO después: ¿viene con el carrito del menú digital? Va antes que cualquier
        // otra lectura porque el mensaje trae texto humano delante («Hola, quiero pedir…») que
        // si no se confundiría con un saludo, y el cliente recibiría la bienvenida en vez de su
        // pedido.
        const delMenu = codigoPedido.leer(texto);
        if (delMenu) {
            await conIdentidad(ctx);
            // Los métodos se leen **al empezar** y viajan en la tarea. Es el mismo patrón que
            // los servicios ofrecidos en la FSM de citas: se resuelve la respuesta contra la
            // lista que se enseñó, no contra lo que haya en la base tres mensajes después.
            ctx.metodosDePago = await leerMetodosPago(ctx.idNegocio).catch(() => []);
            return recibirPedidoDelMenu(ctx, delMenu, {
                solicitarConfirmacion: (peticion) => confirmacion.solicitar(peticion),
            });
        }

        // Un pedido a medias: falta el nombre, el teléfono, la dirección o cómo paga. Mientras
        // la tarea esté abierta, la política de enrutado devuelve aquí cada mensaje, así que el
        // modelo no puede llevarse la conversación a mitad de camino ni olvidarse de lo que ya
        // está apuntado.
        if (conversacion.tarea_actual === TAREA_PEDIDO) {
            await conIdentidad(ctx);
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
        if (esComando(texto, COMANDO.MENU) || !conversacion.variables?.turnos) {
            return bienvenida(ctx, [paso('inicio_conversacion')]);
        }
        return delegar(ctx);
    };
}

module.exports = {
    VERTICAL,
    TIPOS_NEGOCIO,
    OPCION,
    TAREA_PEDIDO,
    PASO_PEDIDO,
    reclama,
    huecosDelCliente,
    interpretarDatos,
    leerTelefono,
    // Expuestos para las pruebas, como `tareaCaducada` en la escalera: son las dos piezas de
    // producto que conviene poder ejercitar sin montar una conversación entera.
    pareceDireccion,
    textoDelPago,
    crearFlujoRestaurante,
    manejarRestaurante: crearFlujoRestaurante(),
    enlaceDelMenu,
};
