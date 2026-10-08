/**
 * Capability Adapter de `restaurante` — capa anticorrupción (ADR-009).
 *
 * ## Por qué existe, y por qué llega ahora
 *
 * Hasta hoy el asistente solo sabía agendar citas: las seis capacidades eran de `reserva` y
 * ese era el único adaptador. Pero los dos clientes activos de producción —`6` ZONA BURGER y
 * `14` LA ESQUINA DEL BARRIL— son **restaurantes**. Conectarles el número les habría dado un
 * bot que ofrece cortes de pelo.
 *
 * El andamiaje no se toca: Policy Gate, Registry, Ledger, canal, ventana de 24 h, confirmación
 * humana y escalera de niveles son transversales y ya funcionan. Esto son capacidades nuevas
 * sobre una vertical que ya existe, siguiendo el mismo patrón que `adapters/reserva/`.
 *
 * ## Alcance de esta primera tanda: SOLO CONSULTAS
 *
 * Es el mismo corte que F4-A hizo en `reserva` —consultas primero, mutaciones después— y aquí
 * no es prudencia genérica: **tomar un pedido está bloqueado por tres cosas concretas** que se
 * descubrieron leyendo `pedidoService.crearOrden` y que no se arreglan desde este archivo.
 *
 *   1. **No acepta una transacción externa.** Abre la suya con
 *      `Models.sequelize.transaction()`. El Policy Gate envuelve toda ejecución en una
 *      transacción propia para que el `dry-run` sea genérico y no algo que cada capacidad deba
 *      implementar (y olvidar). Con una transacción anidada por dentro, ni el dry-run deshace
 *      nada ni el rollback del Gate alcanza a la orden. `reserva` no tenía este problema
 *      porque F3 lo resolvió allí: `citaService.crearCita` sí recibe `{ transaction }`. Es el
 *      punto 2 del Contrato de Adopción, y le toca a la vertical, no al adaptador.
 *   2. **Exige `requireCajaAbierta`.** Una orden no existe fuera de un turno de caja. Es una
 *      regla de negocio correcta —y hay que respetarla, no rodearla—, pero significa que un
 *      cliente que escriba a las 3 de la mañana no puede pedir, y el bot tiene que saber
 *      decirlo bien en vez de fallar con un error técnico.
 *   3. **Exige `idUsuario`**, el empleado que toma la orden. Un pedido que llega por WhatsApp
 *      no tiene empleado detrás. Decidir qué se escribe ahí no es una decisión de código: es
 *      quién responde de esa orden en la caja del negocio.
 *
 * Ninguna de las tres se resuelve improvisando aquí. Están anotadas en
 * `docs/mejoras-flujo-agenda.md` §4 para la tanda siguiente.
 *
 * Mientras tanto estas tres consultas **ya valen por sí solas**: la carta, el precio de algo
 * concreto y en qué va un pedido son la mayor parte de lo que le preguntan a un restaurante por
 * WhatsApp, y hoy las contesta una persona a mano.
 *
 * ## Lo que este adaptador NO hace, a propósito
 *
 * No inventa un catálogo paralelo ni normaliza nombres de productos: consume el **contrato
 * público** de la vertical (`cartaService`, `pedidoService`) igual que el de `reserva` consume
 * el suyo. Si mañana `restaurante` cambia ese contrato, se actualiza este archivo y nada más.
 */
'use strict';
const registry = require('../../core/registry');
const { FEATURE } = require('../../core/features');
const { comoLista } = require('../../core/argumentos');
const { TIPO } = require('../../../app_core/authz/principal');
const { normalizarE164Colombia } = require('../../../app_core/helpers/telefono');

const cartaService = require('../../../app_restaurante_api/services/cartaService');
const pedidoService = require('../../../app_restaurante_api/services/pedidoService');
const empaqueService = require('../../../app_restaurante_api/services/empaqueService');
const cajaService = require('../../../app_restaurante_api/services/cajaService');
const cuentaService = require('../../../app_restaurante_api/services/cuentaService');
const horarioService = require('../../../app_restaurante_api/services/horarioService');
const barrioService = require('../../../app_restaurante_api/services/barrioService');
const exclusiones = require('./exclusiones');
const pago = require('./pago');
const mesaPublicaService = require('../../../app_restaurante_api/services/mesaPublicaService');
const usuarioAsistenteDao = require('../../../app_core/dao/usuarioAsistenteDao');
const Models = require('../../../app_core/models/conection');
const { enPesos, enlaceDelMenu, rangoEnPalabras, fraseDeApertura } = require('./flujo');
const contextoNegocio = require('../../core/contextoNegocio');

const VERTICAL = 'restaurante';

/** Cuántos productos se devuelven como mucho. Una lista de WhatsApp son 10 filas. */
const MAX_PRODUCTOS = 10;

function precio(valor) {
    return valor != null ? Number(valor) : null;
}

/** La forma en que un producto llega al modelo. Un solo sitio para que las tres salidas coincidan. */
/** Sin tildes, en minúsculas. Para comparar lo que dijo alguien con lo que hay en la carta. */
function normalizarTexto(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

/**
 * Con qué opción lee la carta el asistente: `{ miraStock }` según lo que el negocio decidió en
 * los ajustes del asistente (`cartaService.asistenteMiraStock`), que es aparte del control de
 * inventario de caja. Si no se puede leer, `{}`: la carta decide como siempre.
 */
async function opcionDeStock(idNegocio) {
    try {
        return { miraStock: await cartaService.asistenteMiraStock(idNegocio) };
    } catch (_) {
        return {};
    }
}

/** El nombre sin espacios, guiones ni tildes: «Salchi-limón» y «salchilimon» son lo mismo. */
const pegado = (t) => normalizarTexto(t).replace(/[^a-z0-9ñ]/g, '');

/**
 * Busca en la carta, y si la frase entera no casa, lo intenta por palabras.
 *
 * ## El fallo que obliga a la segunda pasada
 *
 * `cartaService.buscarProductos` compara la frase **completa** contra el nombre y contra la
 * descripción, cada uno por su lado. Basta con que el cliente —o el modelo— nombre un producto
 * mezclando los dos campos para que no encuentre nada.
 *
 * Pasó en producción el 2026-08-27, y el cliente lo cazó al vuelo. El producto 103 se llama
 * `Empanadas (x3)` y su descripción dice `De carne, con ají`. El modelo ofreció «empanadas **de
 * carne** (x3)» —correcto para un humano, y fusionando los dos campos—, el cliente dijo que sí,
 * y al buscar «empanadas de carne» no apareció: esa frase no está entera en ninguno de los dos
 * lados. El bot contestó «no encuentro las empanadas de carne en la carta» **treinta segundos
 * después de ofrecerlas**, y se llevó la peor respuesta posible del cliente:
 * *«¿por qué no lo encuentras? si me lo acabas de dar como opción...»*.
 *
 * ## Cómo funciona la segunda pasada
 *
 * Se busca por la palabra más larga —la más selectiva— y sobre esos candidatos se exige que
 * **todas** las demás palabras aparezcan en el nombre o en la descripción. Una sola consulta
 * más, y solo cuando la primera no devolvió nada.
 *
 * ## Por qué aquí y no en `cartaService`
 *
 * Por lo mismo que el filtro de `visible` que hay tres líneas más abajo: ese servicio es el
 * contrato de la vertical y lo usa también el panel del negocio. Ensanchar su búsqueda desde
 * aquí sería cambiarle el comportamiento a una pantalla que nadie ha pedido tocar (ADR-009).
 */
async function buscarEnLaCarta(idNegocio, termino) {
    const stock = await opcionDeStock(idNegocio);
    const directa = await cartaService.buscarProductos(idNegocio, termino, stock);

    const palabras = normalizarTexto(termino)
        .split(/\s+/)
        .filter((w) => w.length >= 3);
    // Con una sola palabra la segunda pasada sería idéntica a la primera: se salta a la tercera.
    let segunda = [];
    if (palabras.length >= 2) {
        const ancla = palabras.slice().sort((a, b) => b.length - a.length)[0];
        const candidatos = await cartaService.buscarProductos(idNegocio, ancla, stock);

        segunda = candidatos.filter((c) => {
            const donde = normalizarTexto(`${c.nombre} ${c.descripcion || ''}`);
            return palabras.every((w) => donde.includes(w));
        });
    }

    // La primera, la segunda y la tercera se JUNTAN; ninguna corta el camino a las demás.
    //
    // Zona Burger, 2026-10-03: «hamburguesa» → la primera pasada devolvía solo la Pata-crunch
    // (cuya descripción dice «hamburguesa») y retornaba ahí. La tercera pasada —que recorre la
    // CATEGORÍA HAMBURGUESAS y trae todos los productos— nunca corría. El bot ofrecía una sola
    // hamburguesa como si fuera la única de la carta.
    //
    // Mismo patrón que segunda+tercera (salchipapa criollita, 2026-10-02): la primera puede
    // traer un resultado suelto sin agotar lo que hay en esa categoría.
    const tercera = await buscarPorCategoriaYNombre(idNegocio, termino);
    const vistos = new Set(tercera.map((p) => p.id_producto));
    const deSegunda = segunda.filter((p) => !vistos.has(p.id_producto));
    deSegunda.forEach((p) => vistos.add(p.id_producto));
    return [...tercera, ...deSegunda, ...directa.filter((p) => !vistos.has(p.id_producto))];
}

/**
 * Los productos que coinciden con el término pero hoy NO se pueden vender: marcados como no
 * disponibles, o sin insumos si el negocio controla inventario. Solo nombres —nada de precio—:
 * sirven para decir «se acabó», no para venderlos.
 *
 * Se busca igual que `buscarEnLaCarta` en sus dos primeras pasadas (término completo y palabra
 * más larga), pero con `includeDisabled`, que es la vista que no filtra ni disponibilidad ni
 * stock. Lo oculto (`visible = false`) sigue sin salir: eso el negocio no lo quiere enseñar.
 * Un fallo aquí no tumba la búsqueda: sin la lista, se contesta como antes.
 */
async function agotadosQueCoinciden(idNegocio, termino) {
    try {
        // El término entero y, si no da nada, cada palabra que dice QUÉ es (hasta 4): con
        // «hamburguesa discordia», «hamburguesa» trae las que se venden y «discordia» la agotada.
        const palabras = normalizarTexto(termino)
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !RELLENO.has(w))
            .slice(0, 4);
        const stock = await opcionDeStock(idNegocio);
        const agotados = new Map();
        /** Lo que casa con `t` y hoy no se vende; `cumple` afina sobre el nombre. */
        const mirar = async (t, cumple = () => true) => {
            const [todos, vendibles] = await Promise.all([
                cartaService.buscarProductos(idNegocio, t, { includeDisabled: true }),
                cartaService.buscarProductos(idNegocio, t, stock),
            ]);
            // Agotado = está en la vista completa y NO en la que se puede vender ahora.
            const seVende = new Set(vendibles.map((p) => p.id_producto));
            for (const p of todos) {
                if (p.visible !== false && !seVende.has(p.id_producto) && cumple(p)) {
                    agotados.set(p.id_producto, p.nombre);
                }
            }
        };
        for (const t of [termino, ...palabras]) {
            await mirar(t);
            if (t === termino && agotados.size > 0) break;
        }
        // «salchilimon» no está, letra por letra, dentro de «Salchi-limón», y el servicio
        // compara así. Zona Burger, 2026-10-07: el negocio desactivó la Salchi-limón y a
        // «¿tienes disponible salchilimon?» se le contestó dos veces «no encuentro Salchilimon
        // en la carta». Se trae lo que empieza igual y se compara el nombre pegado.
        if (agotados.size === 0) {
            for (const w of palabras.filter((p) => p.length >= 5)) {
                await mirar(w.slice(0, 4), (p) => pegado(p.nombre).includes(pegado(w)));
            }
        }
        return [...agotados.values()].slice(0, MAX_PRODUCTOS);
    } catch (error) {
        console.warn(`[buscar_producto] no se pudieron leer los agotados: ${error.message}`);
        return [];
    }
}

/**
 * Lo que `buscar_producto` añade cuando lo pedido existe pero hoy no se vende: los nombres y
 * cómo decirlo. La frase va aquí, pegada al dato, para que el modelo no improvise un «no
 * encuentro» (pedido del dueño, 2026-10-07: «agotado por hoy», amable y corto).
 */
async function conAgotados(idNegocio, termino, productos, terminoUsado) {
    if (!noTraeLoPedido(productos, terminoUsado)) return {};
    const agotados = (await agotadosQueCoinciden(idNegocio, termino)).filter(
        (nombre) => !productos.some((p) => p.nombre === nombre)
    );
    if (agotados.length === 0) return { agotados_ahora: agotados };
    return {
        agotados_ahora: agotados,
        nota_agotado:
            'Lo que pidió SÍ está en la carta, pero hoy se agotó. Díselo corto y amable, por ' +
            'ejemplo: «Hoy se nos agotó la *Salchi-limón* 🙏 ¿Te provoca otra cosa?». Si son ' +
            'varios tamaños del mismo plato, nómbralo una sola vez. Nunca digas «no encuentro», ' +
            '«no me aparece» ni «no está en la carta».',
    };
}

/**
 * ¿La búsqueda no trajo lo que se pidió? Vacía, o con otros productos que no llevan la palabra
 * principal del término («hamburguesa discordia» → salen las otras hamburguesas, no la Discordia).
 * Solo entonces vale la pena mirar si lo pedido está agotado.
 */
function noTraeLoPedido(productos, termino) {
    if (productos.length === 0) return true;
    const ancla = normalizarTexto(termino)
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !RELLENO.has(w))
        .sort((a, b) => b.length - a.length)[0];
    if (!ancla) return false;
    // «salchilimon» SÍ es «Salchi-limón»: el nombre se mira también sin guiones ni espacios. Y
    // nada más laxo que eso: con la tolerancia de `mismaPalabra`, «salchibarril» (agotada) casaba
    // con «Salchi-limón» por el prefijo, no se miraban los agotados y el modelo anotó la
    // Salchi-limón en su lugar (2026-10-05, 18:49).
    return !productos.some((p) => {
        const nombre = normalizarTexto(p.nombre);
        return nombre.includes(ancla) || nombre.replace(/[^a-z0-9ñ]/g, '').includes(ancla);
    });
}

/**
 * Dónde empieza el pedido de AHORA dentro del chat: después del último «pedido tomado», del
 * último saludo con la carta o de la última cancelación.
 *
 * El historial son los últimos mensajes de la conversación, y la conversación de WhatsApp no se
 * acaba nunca: un «para recoger» de hace cinco días seguía contando. Zona Burger, 2026-10-07:
 * a «una salchilimón personal» se le armó el pedido «para recoger» sin preguntar, porque la
 * clienta lo había dicho el 2 de octubre; esta vez lo quería a domicilio (ORD-7876).
 */
const FRONTERA_DE_PEDIDO = /tu pedido quedo (tomado|para servir)|lo sume a la cuenta de tu mesa|te saluda \*|tu pedido fue cancelado/;
function pedidoEnCurso(hilo) {
    let desde = 0;
    hilo.forEach((m, i) => {
        if (m.rol !== 'cliente' && FRONTERA_DE_PEDIDO.test(normalizarTexto(m.texto))) desde = i + 1;
    });
    return hilo.slice(desde);
}

/** Lo que NO contesta a «¿a domicilio, para recoger o para comer aquí?»: otro producto, o un sí. */
const SIGUE_PIDIENDO = /^(?:(?:y|mas|tambien|ademas)\s+)?(?:\d+|un|una|unas|unos|dos|tres|cuatro|cinco|media)\s+[a-zñ]{3,}/;
const SI_SUELTO = /^(si|sip|sii+|claro|ok|okay|dale|listo|bueno|vale|de una|por favor|porfa)(\s+(si|claro|por favor|porfa|gracias|senor|senora|veci))*$/;

/**
 * ¿Se le preguntó cómo lo recibe Y contestó? O ya vio un resumen con esa misma entrega, que es
 * lo que hay cuando solo añade un producto o corrige el nombre.
 *
 * Antes bastaba con que el asistente hubiera preguntado. Zona Burger, 2026-10-07: el cliente
 * siguió dictando productos sin contestar, el modelo eligió «para servir» y se le reservó una
 * mesa a un domicilio (ORD-7878). Un «sí» a una pregunta de tres opciones tampoco contesta
 * (2026-10-06: «¿para recoger, a domicilio o para comer aquí?» → «Si» → para recoger).
 */
function contestoComoLoRecibe(enCurso, paraServir) {
    const resumen = paraServir ? /confirmo tu pedido.*para servirlo/ : /confirmo tu pedido.*para recogerlo/;
    let pregunta = -1;
    for (let i = 0; i < enCurso.length; i++) {
        if (enCurso[i].rol === 'cliente') continue;
        const t = normalizarTexto(enCurso[i].texto);
        if (resumen.test(t)) return true;
        if (/recog/.test(t) && String(enCurso[i].texto).includes('?')) pregunta = i;
    }
    if (pregunta < 0) return false;
    return enCurso.slice(pregunta + 1).some((m) => {
        if (m.rol !== 'cliente') return false;
        const t = normalizarTexto(m.texto).replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
        return t.length > 0 && !SIGUE_PIDIENDO.test(t) && !SI_SUELTO.test(t);
    });
}

/**
 * ¿El modelo eligió «para recoger» (o «para servir» sin mesa) sin que el cliente lo dijera?
 *
 * «Para recoger» no se supone. Si el modelo lo pone y en el chat nadie ha hablado de recoger, se
 * le devuelve para que pregunte (Zona Burger, 2026-10-05: un domicilio quedó tomado para
 * recoger). «Para servir» sin mesa tampoco: cerrado el paso a LLEVAR, el modelo probó con MESA en
 * una de cada cuatro rondas de evaluación. Un domicilio ya exige dirección y teléfono.
 *
 * Con el chat en orden se mira solo el pedido en curso, y que se le haya preguntado no basta:
 * tiene que haber contestado (`pedidoEnCurso`, `contestoComoLoRecibe`). Sin el orden —quien
 * llama sin `hilo`— como antes.
 */
function entregaSinDecir({ args, cliente = [], asistente = [], hilo = [] }) {
    const paraServir = args?.tipo_entrega === 'MESA' && !args?.id_mesa;
    if (args?.tipo_entrega !== 'LLEVAR' && !paraServir) return false;
    const dicho = paraServir ? HABLA_DE_COMER_AQUI : HABLA_DE_RECOGER;
    if (hilo.length > 0) {
        const enCurso = pedidoEnCurso(hilo);
        const loDijoAhora = enCurso.some((m) => m.rol === 'cliente' && dicho.test(normalizarTexto(m.texto)));
        return !(loDijoAhora || contestoComoLoRecibe(enCurso, paraServir));
    }
    const loDijo = cliente.some((t) => dicho.test(normalizarTexto(t)));
    const sePregunto = asistente.some((t) => /recog/.test(normalizarTexto(t)));
    return !(loDijo || sePregunto);
}

/**
 * El error que vuelve al modelo cuando le faltan datos que solo puede dar el cliente, o `null`.
 *
 * Con una sola falta, su código de siempre. Con varias, `FALTAN_DATOS` y la orden de pedirlas
 * TODAS en un mensaje, con la frase hecha: un modelo al que se le dice «falta el nombre» pregunta
 * el nombre, y al turno siguiente descubre que también faltaba la entrega.
 */
function loQueFalta({ entrega, direccion, nombre }) {
    const cierre = 'No le cuentes este error.';
    if (entrega) {
        // Sin saber cómo lo recibe no se sabe qué más pedir: se pregunta eso y, de una vez, lo
        // que hará falta según lo que conteste.
        const paraElLocal = nombre
            ? '🏃 *Para recoger o comer aquí*: dime a nombre de quién.'
            : '🏃 *Para recoger o comer aquí*: con eso me basta.';
        return {
            codigo: nombre ? 'FALTAN_DATOS' : 'ENTREGA_SIN_DECIR',
            mensaje:
                'El cliente no ha dicho cómo quiere recibir el pedido' +
                (nombre ? ' ni a nombre de quién queda' : '') +
                '. No lo elijas tú. Pregúntaselo en UN solo mensaje que pida de una vez lo que ' +
                'hará falta según conteste, así: «¿Cómo lo quieres? 🛵 *A domicilio*: mándame la ' +
                `dirección con el barrio y un teléfono. ${paraElLocal}» ` +
                `Vuelve a llamar con lo que conteste. ${cierre}`,
        };
    }
    if (direccion && nombre) {
        return {
            codigo: 'FALTAN_DATOS',
            mensaje:
                'El cliente todavía no ha dicho la dirección ni a nombre de quién queda el pedido. ' +
                'No los rellenes tú. Pídele las dos cosas en UN solo mensaje —la dirección con el ' +
                'barrio o una indicación para llegar, y el nombre— y vuelve a llamar cuando las ' +
                `tengas. ${cierre}`,
        };
    }
    if (direccion) {
        return {
            codigo: 'DIRECCION_REQUERIDA',
            mensaje:
                'Eso no es una dirección: el cliente todavía no la ha dicho. No la ' +
                'rellenes tú: pídele la dirección, con el barrio o una indicación para ' +
                `llegar, y vuelve a llamar cuando la tengas. ${cierre}`,
        };
    }
    if (nombre) {
        return {
            codigo: 'NOMBRE_REQUERIDO',
            mensaje:
                'No sabes cómo se llama el cliente. No pongas «cliente»: pregúntale a ' +
                `nombre de quién queda el pedido y vuelve a llamar con lo que conteste. ${cierre}`,
        };
    }
    return null;
}

/** «20 a 40 minutos» / «unos 20 minutos», o `null` si el negocio no ha dicho ese tiempo. */
function minutosEnPalabras(tiempo) {
    const min = Number(tiempo?.min);
    if (!Number.isInteger(min) || min < 1) return null;
    const max = Number(tiempo?.max);
    return Number.isInteger(max) && max > min ? `${min} a ${max} minutos` : `unos ${min} minutos`;
}

/**
 * La línea del resumen que dice cuánto falta, según cómo lo recibe: el tiempo de recoger para
 * quien pasa por el local (o el estimado de siempre si el negocio no lo ha dicho aparte) y el
 * estimado para un domicilio. `null` si no hay ningún tiempo configurado: no se inventa.
 */
async function lineaDeTiempo(idNegocio, tipoEntrega) {
    try {
        const negocio = await contextoNegocio.obtener(idNegocio);
        const enElLocal = tipoEntrega !== 'DOMICILIO';
        const cuanto = minutosEnPalabras(
            enElLocal ? negocio?.tiempoRecoger || negocio?.tiempoEstimado : negocio?.tiempoEstimado
        );
        if (!cuanto) return null;
        const rango = cuanto.startsWith('unos') ? cuanto : `unos ${cuanto}`;
        return enElLocal
            ? `⏱️ Estará listo en ${rango}, contados desde que confirmes.`
            : `⏱️ Te llega en ${rango}, contados desde que confirmes.`;
    } catch (_) {
        return null;
    }
}

/** El cliente habló de recoger, pasar o ir al local (sobre texto sin tildes). */
const HABLA_DE_RECOGER = /\b(recog\w*|recoj\w*|llevar|llevo|llevarl[oa]s?|paso|pasar|pasare|pasamos|voy|vamos|retir\w*|busc\w*|local|alla|caigo)\b|~m=r\b/;

/** El asistente acaba de decir que el pedido quedó hecho (las tres frases de `hecho`). */
const PEDIDO_TOMADO = /pedido quedo tomado|pedido quedo para servir|lo sume a la cuenta/;

/** El cliente pide OTRO pedido, o el asistente ya le preguntó si es uno nuevo. */
const QUIERE_OTRO_PEDIDO = /\b(otr[oa]s?|nuevo pedido|pedido nuevo|aparte|adicional|de nuevo|tambien quiero|tambien me|ademas)\b/;

/** Cuánto dura «este chat ya tiene un pedido»: lo que tarda en salir de cocina. */
const HORAS_PEDIDO_YA_TOMADO = 2;

/**
 * ¿Se está por crear un SEGUNDO pedido donde el cliente solo quería cambiar el primero?
 *
 * Zona Burger, 2026-10-05, 21:25: con el pedido ORD-7789 ya tomado, la clienta escribió «solo
 * salsa de piña y tomate, menos la BBQ». El asistente no puede editar un pedido hecho, así que
 * llamó otra vez a `tomar_pedido` y le enseñó la confirmación de un pedido NUEVO igual; con un
 * «sí» a cocina le entraban dos.
 *
 * Que hay un pedido lo dice el Ledger (`tomar_pedido` ok de este chat en las últimas horas), no
 * el texto. Se deja pasar cuando, después de ese pedido, el cliente habla de «otro» o el
 * asistente ya le preguntó si es uno nuevo. Ante cualquier fallo, `null`: no se bloquea una
 * venta por no poder leer el Ledger.
 */
async function pedidoQueYaSeTomo({ hilo = [], idConversacion = null, idNegocio = null, telefonos = [] }) {
    // Si este chat no tomó ningún pedido, queda mirar si el negocio se lo tomó A MANO. Ver
    // `pedidoTomadoAMano`. Ese pedido no dejó «pedido tomado» en el chat, así que lo que cuenta
    // como «pide otro» es todo lo que haya en el hilo.
    const tomadoAMano = async () => {
        const aMano = await pedidoTomadoAMano({ idNegocio, telefonos });
        if (!aMano) return null;
        const pideOtro = hilo.some(
            (t) =>
                (t.rol === 'cliente' && QUIERE_OTRO_PEDIDO.test(normalizarTexto(t.texto))) ||
                (t.rol !== 'cliente' && /pedido nuevo/.test(normalizarTexto(t.texto)))
        );
        if (!pideOtro) {
            return {
                codigo: 'YA_HAY_PEDIDO',
                mensaje:
                    `El restaurante ya le tomó a este cliente el pedido ${aMano} hace poco, por fuera ` +
                    'de ti: NO crees otro. Lo que el cliente escribe ahora seguramente es sobre ESE ' +
                    'pedido (la dirección, una indicación, una pregunta): llama a pasar_a_persona. ' +
                    'Solo si de verdad pide otro pedido aparte, pregúntale «¿es un pedido nuevo, ' +
                    'aparte del anterior?» y vuelve a llamar cuando diga que sí.',
            };
        }
        return null;
    };
    if (!idConversacion) return tomadoAMano();
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM intelligence.invocacion_capacidad
              WHERE id_conversacion = :c AND capacidad = 'tomar_pedido'
                AND resultado = 'ok' AND NOT dry_run
                AND creado_en >= now() - (:horas * interval '1 hour')
              LIMIT 1;`,
            {
                replacements: { c: idConversacion, horas: HORAS_PEDIDO_YA_TOMADO },
                type: Models.sequelize.QueryTypes.SELECT,
                logging: false,
            }
        );
        if (!fila) return tomadoAMano();
    } catch (error) {
        console.warn(`[tomar_pedido] no se pudo saber si ya hay un pedido: ${error.message}`);
        return null;
    }

    // Lo dicho DESPUÉS del «pedido tomado» (o todo el hilo, si esa frase ya quedó atrás).
    let desde = -1;
    hilo.forEach((t, i) => {
        if (t.rol !== 'cliente' && PEDIDO_TOMADO.test(normalizarTexto(t.texto))) desde = i;
    });
    const despues = hilo.slice(desde + 1);
    const numero = desde >= 0 ? (String(hilo[desde].texto).match(/ORD-\d+/) || [])[0] : null;
    const pideOtro = despues.some(
        (t) =>
            (t.rol === 'cliente' && QUIERE_OTRO_PEDIDO.test(normalizarTexto(t.texto))) ||
            (t.rol !== 'cliente' && /pedido nuevo/.test(normalizarTexto(t.texto)))
    );
    if (pideOtro) return null;

    const cual = numero ? `el pedido ${numero}` : 'un pedido';
    return {
        codigo: 'YA_HAY_PEDIDO',
        mensaje:
            `En esta conversación ya se tomó ${cual}: NO crees otro. Si el cliente quiere CAMBIAR ` +
            'algo de ese pedido (salsas, una nota, la dirección, quitar algo), llama a ' +
            'pasar_a_persona: tú no puedes editarlo. Si quiere AÑADIR productos, usa ' +
            'agregar_items_pedido con ese número. Solo si de verdad pide otro pedido aparte, ' +
            'pregúntale «¿es un pedido nuevo, aparte del anterior?» y vuelve a llamar cuando diga que sí.',
    };
}

/**
 * El número de un pedido vivo que el negocio le tomó A MANO a este cliente en las últimas horas,
 * o `null`. Se reconoce por el teléfono de contacto (los últimos 10 dígitos), que es lo único que
 * une un pedido hecho en caja con un chat.
 *
 * Zona Burger, 2026-10-06, 18:47: el cajero tomó el domicilio a mano (ORD-7803); a los 25 minutos
 * el asistente volvió, el cliente escribió «habitación 404» y el modelo armó el mismo pedido otra
 * vez. Un «dale» después había dos domicilios iguales, con dos domiciliarios. El Ledger no lo
 * veía: ese pedido no lo tomó el asistente. Ante cualquier fallo, `null`.
 */
async function pedidoTomadoAMano({ idNegocio = null, telefonos = [] }) {
    const finales = [
        ...new Set(
            telefonos
                .map((t) => String(t || '').replace(/\D/g, '').slice(-10))
                .filter((t) => t.length === 10)
        ),
    ];
    if (!idNegocio || finales.length === 0) return null;
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT o.numero_orden
               FROM restaurante.pedid_orden o
              WHERE o.id_negocio = :idNegocio
                AND o.estado <> 'CANCELADA'
                AND o.tipo_pedido IN ('DOMICILIO', 'LLEVAR')
                AND o.fecha_creacion >= (now() AT TIME ZONE 'America/Bogota') - (:horas * interval '1 hour')
                AND right(regexp_replace(coalesce(o.contacto_telefono, ''), '\\D', '', 'g'), 10) IN (:finales)
              ORDER BY o.fecha_creacion DESC
              LIMIT 1;`,
            {
                replacements: { idNegocio, horas: HORAS_PEDIDO_YA_TOMADO, finales },
                type: Models.sequelize.QueryTypes.SELECT,
                logging: false,
            }
        );
        return fila?.numero_orden ?? null;
    } catch (error) {
        console.warn(`[tomar_pedido] no se pudo saber si hay un pedido tomado a mano: ${error.message}`);
        return null;
    }
}

/**
 * Lo que el modelo escribe cuando NO tiene el dato y aun así tiene que llenar el campo. Zona
 * Burger, 2026-10-06: un domicilio salió a nombre de «Cliente» y con dirección «pendiente»; el
 * local consiguió la dirección a mano y el cliente esperó más de una hora. Sobre texto
 * normalizado y entero: «Hotel Nova, habitación por confirmar» sí es una dirección.
 */
const DIRECCION_DE_RELLENO = /^(la )?(pendiente|por confirmar|por definir|por indicar|por verificar|sin direccion|sin definir|no aplica|no indica|no tiene|no se|n\/?a|ninguna|desconocida?|direccion|domicilio|a domicilio|ubicacion|ubicacion en tiempo real|maps|[\W_]*)$/;
const NOMBRE_DE_RELLENO = /^(el |la )?(cliente|clienta|usuario|usuaria|pendiente|por confirmar|sin nombre|anonimo|anonima|desconocid[oa]|n\/?a|whatsapp)$/;

/** El cliente habló de comer en el local («para servir», «vamos para allá»). */
const HABLA_DE_COMER_AQUI = /\b(servir\w*|comer|comemos|consum\w*|mesa|aqui|alla|local|sentad\w*|voy|vamos|llego|llegamos)\b/;

/** Palabras de tamaño que el cliente puede pedir y que la carta puede no tener para ese plato. */
const PIDE_TAMANO = /^(mediana|mediano|medianas|medianos|grande|grandes|familiar|familiares|xl|jumbo|gigante|gigantes)$/;

/**
 * Separa el tamaño del resto: «salchilimon grande» → { resto: 'salchilimon', tamano: 'grande' }.
 * Sin tamaño, o si el término ES solo el tamaño, `tamano` es null.
 */
function sinElTamano(termino) {
    const palabras = String(termino || '').trim().split(/\s+/).filter(Boolean);
    const tamanos = palabras.filter((w) => PIDE_TAMANO.test(normalizarTexto(w)));
    const resto = palabras.filter((w) => !PIDE_TAMANO.test(normalizarTexto(w))).join(' ');
    if (tamanos.length === 0 || resto.length < 2) return { resto: termino, tamano: null };
    return { resto, tamano: normalizarTexto(tamanos[0]) };
}

/** Palabras de relleno: no dicen QUÉ producto es, así que no se le exigen a la carta. */
const RELLENO = new Set([
    'una', 'uno', 'unos', 'unas', 'del', 'los', 'las', 'por', 'favor', 'porfa', 'porfis',
    'con', 'sin', 'para', 'que', 'quiero', 'quisiera', 'pedir', 'dame', 'deme', 'tienen',
    'tiene', 'hay', 'precio', 'cuanto', 'vale', 'cuesta', 'tamano', 'size', 'me', 'regala',
    'regalas', 'regalame', 'mas', 'otra', 'otro', 'también', 'tambien',
    // «gaseosa personal sabor cuatro» no encontraba nada: «sabor» no está en ningún nombre (2026-10-04).
    'sabor', 'sabores',
]);

/** Tamaños que NO figuran en el nombre cuando el producto es el básico («criollita» = personal). */
// Con plurales: «alitas pequeñas» no encontraba nada (2026-10-04) porque «pequenas» no estaba.
const TAMANO_BASICO = new Set([
    'pequena', 'pequeno', 'pequenas', 'pequenos', 'chica', 'chico', 'chicas', 'chicos', 'personal',
    'personales', 'individual', 'individuales', 'sencilla', 'sencillo', 'sencillas', 'sencillos', 'normal',
]);

/** Marcas de tamaño que sí se escriben en el nombre de las variantes grandes. */
const MARCA_TAMANO = /\b(mediana|mediano|grande|familiar|xl|jumbo|gigante)\b/;

/** ¿Estas dos palabras son la misma, salvo plural o diminutivo? («criolla» ~ «criollita») */
function mismaPalabra(a, b) {
    if (a === b) return true;
    const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
    if (corta.length >= 4 && larga.startsWith(corta)) return true;
    let i = 0;
    while (i < corta.length && corta[i] === larga[i]) i++;
    return (i >= 5 && i >= corta.length * 0.7) || conErrata(a, b);
}

/** Distancia de edición (Levenshtein) entre dos palabras cortas. */
function distancia(a, b) {
    let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const fila = [i];
        for (let j = 1; j <= b.length; j++) {
            fila[j] = Math.min(
                previa[j] + 1,
                fila[j - 1] + 1,
                previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        previa = fila;
    }
    return previa[b.length];
}

/**
 * ¿Es la misma palabra con una errata? («visiosa» ~ «viciosa», «limos» ~ «limon», «dulsinea» ~
 * «dulcinea»). Zona Burger, 2026-10-03: «papas con limos» y «visiosa» devolvieron «no la
 * encuentro» con el producto en la carta. Solo palabras de 5+ letras y con 1 error (2 si pasan de
 * 8): con menos, «mora» y «moda» serían lo mismo.
 */
function conErrata(a, b) {
    if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 2) return false;
    return distancia(a, b) <= (Math.min(a.length, b.length) >= 8 ? 2 : 1);
}

/**
 * Tercera pasada: la forma en que HABLA el cliente frente a la forma en que está escrita la carta.
 *
 * Producción, 2026-10-01 (Zona Burger): el cliente pide «una salchipapa criolla pequeña» y la carta
 * tiene, dentro de la categoría SALCHIPAPAS, un producto que se llama solo `criollita`, más
 * `criolla mediana` y `criollita GRANDE`. La palabra «salchipapa» está en la CATEGORÍA, no en el
 * producto, así que las dos pasadas anteriores devolvían vacío —incluso para «salchipapa» a secas—
 * y el bot decía «no hay salchipapas» con diez en la carta.
 *
 * Se busca sobre la carta PÚBLICA (visible y disponible: lo oculto o agotado no se ofrece) y cada
 * palabra con contenido debe casar con la categoría, el nombre o la descripción. Sigue siendo
 * estricta: «hamburguesa doble» no devuelve cualquier hamburguesa si «doble» no aparece.
 */
async function buscarPorCategoriaYNombre(idNegocio, termino) {
    const palabras = normalizarTexto(termino)
        .replace(/[^a-z0-9ñ\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !RELLENO.has(w));
    const pedidoBasico = palabras.some((w) => TAMANO_BASICO.has(w));
    const exigidas = palabras.filter((w) => !TAMANO_BASICO.has(w));
    if (exigidas.length === 0) return [];

    const categorias = await cartaService.getCartaPublicaCompleta(idNegocio, await opcionDeStock(idNegocio));
    const encontrados = [];
    for (const cat of categorias || []) {
        const palabrasCategoria = normalizarTexto(cat.nombre).split(/\s+/);
        for (const p of cat.productos || []) {
            const palabrasProducto = normalizarTexto(`${p.nombre} ${p.descripcion || ''}`)
                .replace(/[^a-z0-9ñ\s]/g, ' ')
                .split(/\s+/)
                .filter(Boolean);
            const bolsa = [...palabrasCategoria, ...palabrasProducto];
            if (!exigidas.every((w) => bolsa.some((b) => mismaPalabra(w, b)))) continue;
            const enNombre = exigidas.filter((w) =>
                palabrasProducto.some((b) => mismaPalabra(w, b))
            ).length;
            encontrados.push({ ...p.toJSON?.() ?? p, categoria: cat.nombre, _afinidad: enNombre });
        }
    }

    // «Pequeña/personal» es el producto básico: sin marca de tamaño en el nombre. Si hay de esos,
    // las variantes mediana/grande no se ofrecen en su lugar.
    const resultado = pedidoBasico
        ? (() => {
              const basicos = encontrados.filter((p) => !MARCA_TAMANO.test(normalizarTexto(p.nombre)));
              return basicos.length > 0 ? basicos : encontrados;
          })()
        : encontrados;

    return resultado.sort((a, b) => b._afinidad - a._afinidad);
}

function producto(p, { conDescripcion = true } = {}) {
    return {
        id_producto: p.id_producto,
        nombre: p.nombre,
        ...(p.categoria ? { categoria: p.categoria } : {}),
        ...(conDescripcion ? { descripcion: p.descripcion || null } : {}),
        precio: precio(p.precio),
        es_popular: Boolean(p.es_popular),
    };
}

/** Con más resultados que esto, `buscar_producto` los manda sin descripción. */
// Cuatro y no tres (2026-10-05): un plato con sus cuatro tamaños —pequeña, mediana, grande y
// familiar— llegaba sin descripción, y a «¿la viciosa trae tocineta?» el modelo contestaba que
// la descripción no lo decía. No la había recibido.
const MAX_CON_DESCRIPCION = 4;

/**
 * Se queda con lo que el cliente NOMBRÓ, no con todo lo que lo menciona.
 *
 * Las tres pasadas de `buscarEnLaCarta` también buscan en las descripciones, y eso es lo que
 * permite encontrar «empanadas de carne»; pero en Zona Burger (2026-10-04) «choripapa» traía diez
 * productos —todas las salchipapas dicen «papa a la francesa»—, unos 870 tokens que el modelo
 * leía en cada búsqueda. Ahora:
 *  - si el término nombra una CATEGORÍA («hamburguesa», «gaseosa»), salen esa categoría y lo que
 *    lo lleve en el nombre;
 *  - si no, y hay productos que lo llevan en el NOMBRE («choripapa», «queso gratinado»), solo esos;
 *  - si no, todo lo encontrado, como antes (ahí la descripción es la única pista).
 * Las palabras de tamaño básico («pequeña», «personal») no cuentan: ese producto no las dice.
 */
function afinarResultado(productos, termino) {
    const tokens = (texto) => normalizarTexto(texto).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);
    const exigidas = tokens(termino).filter((w) => w.length >= 3 && !RELLENO.has(w) && !TAMANO_BASICO.has(w));
    if (exigidas.length === 0 || productos.length <= 1) return productos;
    const cubre = (texto) => {
        const bolsa = tokens(texto);
        return exigidas.every((w) => bolsa.some((b) => mismaPalabra(w, b)));
    };
    const enNombre = (p) => cubre(p.nombre);
    const enCategoria = (p) => Boolean(p.categoria) && cubre(p.categoria);
    if (productos.some(enCategoria)) return productos.filter((p) => enCategoria(p) || enNombre(p));
    if (productos.some(enNombre)) return productos.filter(enNombre);
    return productos;
}

/**
 * En qué va un pedido, dicho como lo entiende el cliente.
 *
 * El modelo recibía `estado`, `estado_cocina` y `estado_pago` en crudo y los interpretaba —mal—.
 * Aquí se decide una sola frase con lo que el negocio sabe: cancelado, entregado, avisado
 * (listo para recoger / en camino), listo, en cocina o recibido.
 */
function estadoParaElCliente(orden) {
    const domicilio = orden.tipo_pedido === 'DOMICILIO';
    if (orden.estado === 'CANCELADA') return 'cancelado';
    if (orden.estado === 'CERRADA') return domicilio ? 'entregado' : 'entregado / recogido';
    if (orden.aviso_listo_en) {
        return domicilio ? 'listo y en camino con el domiciliario' : 'listo para recoger en el local';
    }
    if (orden.estado_cocina === 'LISTO') {
        return domicilio ? 'listo en cocina, a punto de salir' : 'listo para recoger en el local';
    }
    if (orden.estado_cocina === 'EN_PREPARACION') return 'en preparación en la cocina';
    if (orden.estado_cocina === 'PENDIENTE') return 'recibido por el restaurante, en turno para la cocina';
    // Sin etapa de cocina: el negocio no usa la pantalla de Cocina (Zona Burger no la usa: los 36
    // domicilios de un día con `estado_cocina` nulo). Decir «en turno para la cocina» de un pedido
    // que ya iba en la moto fue mentirle a un cliente que reclamaba la demora (2026-10-02).
    return 'recibido por el restaurante (no tengo el detalle de en qué etapa va)';
}

/**
 * Cuánto lleva el pedido desde que se tomó, y si ya pasó el tiempo estimado que declaró el negocio.
 * Es lo que deja contestar con honestidad cuando no hay etapa de cocina: el tiempo SÍ se sabe.
 */
function tiempoDelPedido(orden, tiempoEstimado, ahora = new Date()) {
    const creado = new Date(orden.fecha_creacion).getTime();
    if (!Number.isFinite(creado)) return { minutos_desde_que_se_pidio: null, pasado_del_tiempo_estimado: false };
    const minutos = Math.max(0, Math.round((ahora.getTime() - creado) / 60000));
    const tope = Number(tiempoEstimado?.max) || Number(tiempoEstimado?.min) || null;
    return {
        minutos_desde_que_se_pidio: minutos,
        pasado_del_tiempo_estimado: Boolean(tope) && minutos > tope,
    };
}

/**
 * Tiempo estimado y notas libres del negocio (`gener_negocio`). Con la falla contenida: si las
 * columnas aún no existen en un entorno sin migrar, la capacidad responde sin ellas en vez de
 * fallar entera.
 */
async function leerFichaDelNegocio(idNegocio, transaction) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT tiempo_estimado_min, tiempo_estimado_max, info_asistente
               FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT, transaction }
        );
        return {
            tiempo_estimado_min: fila?.tiempo_estimado_min ?? null,
            tiempo_estimado_max: fila?.tiempo_estimado_max ?? null,
            tiempo_recoger: await contextoNegocio.leerTiempoRecoger(idNegocio, transaction),
            info_asistente: String(fila?.info_asistente || '').trim() || null,
            domicilio_rango: await leerDomicilioRango(idNegocio, transaction),
        };
    } catch (error) {
        console.warn(`[restaurante] no se pudo leer la ficha del negocio ${idNegocio}: ${error.message}`);
        return { tiempo_estimado_min: null, tiempo_estimado_max: null, info_asistente: null, domicilio_rango: null };
    }
}

/**
 * El valor del domicilio como rango (`{ min, max, nota }` o `null`), desde 2026-10-02. Aparte y
 * con la falla contenida, como la ficha: un entorno sin la migración responde sin el rango.
 */
async function leerDomicilioRango(idNegocio, transaction) {
    try {
        const [fila] = await Models.sequelize.query(
            `SELECT domicilio_valor_min AS min, domicilio_valor_max AS max, domicilio_nota AS nota
               FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT, transaction }
        );
        return contextoNegocio.normalizarDomicilioRango(fila);
    } catch (error) {
        console.warn(`[restaurante] no se pudo leer el rango del domicilio ${idNegocio}: ${error.message}`);
        return null;
    }
}

function registrarCapacidades() {
    registry.registrar({
        nombre: 'consultar_carta',
        descripcion:
            'Sin argumentos, devuelve el ENLACE de la carta digital (con fotos y precios) y un ' +
            'índice de categorías —nombre, id y cuántos productos tiene cada una—, pero NO la ' +
            'lista de productos. Úsala cuando el cliente pida ver el menú, la carta, o ' +
            'pregunte qué venden EN GENERAL: la respuesta correcta es darle el enlace y decirle ' +
            'que ahí ve todo con fotos y precios, **nunca transcribir el catálogo en el chat**. ' +
            'Si en cambio el cliente pregunta por una parte concreta de la carta ("¿qué bebidas ' +
            'tienen?", "¿qué hay de postre?"), ahí sí contesta en el chat: vuelve a llamar a ' +
            'esta misma capacidad con el id_categoria exacto que salió en el índice (NO son ' +
            '1, 2, 3). Para un plato suelto ("¿cuánto vale la limonada?") usa buscar_producto.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            id_categoria: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            // Se usan las variantes PÚBLICAS (`getCartaPublica`, `...PublicosByCategoria`) y
            // no las de administración: filtran por `visible` además de por `disponible`, que
            // es justo la diferencia entre lo que el negocio gestiona y lo que le enseña a un
            // cliente. Un producto oculto a propósito no debe salir por el bot.

            // ⚠️ Sin categoría se devuelve el ENLACE y un ÍNDICE, no el catálogo entero.
            //
            // Hasta el 2026-09-22 esto devolvía la carta completa —todas las categorías con
            // todos sus productos y precios— y el modelo la transcribía en el chat tal cual:
            // un mensaje larguísimo de "Entradas / Platos / Bebidas" con precio por línea,
            // justo lo que ya existe —mejor hecho, con fotos— en el menú digital. Visto en
            // producción el 2026-09-21.
            //
            // El índice (sin productos) sostiene lo mismo que ya resolvió el fallo del
            // 2026-08-24: el modelo sigue sin tener que ADIVINAR un id_categoria, porque aquí
            // se lo llevamos. La diferencia es que ya no hace falta preguntarle al cliente «¿cuál
            // categoría?» —el fallo que motivó devolver el catálogo completo— porque ahora hay
            // un tercer camino que no existía entonces: el enlace. Ver el catálogo completo
            // sigue disponible, con id_categoria, para cuando el cliente SÍ pregunta por una
            // parte concreta.
            if (!args.id_categoria) {
                const carta = await cartaService.getCartaPublica(idNegocio, await opcionDeStock(idNegocio));

                const categorias = carta
                    .map((c) => ({
                        id_categoria: c.id_categoria,
                        categoria: c.nombre,
                        cuantos_productos: (c.productos || []).length,
                    }))
                    .filter((c) => c.cuantos_productos > 0);

                return {
                    enlace: enlaceDelMenu(idNegocio),
                    cuantos_productos: categorias.reduce((n, c) => n + c.cuantos_productos, 0),
                    categorias,
                };
            }

            // ⚠️ La categoría tiene que existir Y ser de ESTE negocio.
            //
            // Sin esta comprobación, un id que no existe devolvía lista vacía con resultado
            // `ok`, y el bot se lo creía: el 2026-08-24 el modelo pidió la categoría 2 —un
            // ordinal, «la segunda»— cuando las de ese negocio eran 38, 39 y 40, y el cliente
            // leyó «en Platos no tenemos productos disponibles» con la carta llena de platos.
            //
            // La lección va más allá de este caso: **una capacidad que devuelve vacío ante una
            // entrada inválida le enseña al modelo a mentirle al cliente.** Vacío significa «no
            // hay», y eso tiene que ser cierto. Si el argumento está mal, se dice.
            const categoria = await Models.CartaCategoria.findOne({
                where: { id_categoria: args.id_categoria, id_negocio: idNegocio, estado: 'A' },
                attributes: ['id_categoria', 'nombre'],
                transaction: contexto.transaction,
            });
            if (!categoria) {
                const e = new Error(
                    `No existe la categoría ${args.id_categoria} en la carta de este negocio. ` +
                        'Usa exactamente el id_categoria que devuelve consultar_carta sin argumentos; ' +
                        'no son números correlativos.'
                );
                e.code = 'CATEGORIA_NO_ENCONTRADA';
                e.statusCode = 404;
                throw e;
            }

            const productos = await cartaService.getProductosPublicosByCategoria(
                idNegocio,
                args.id_categoria,
                await opcionDeStock(idNegocio)
            );
            return {
                id_categoria: args.id_categoria,
                categoria: categoria.nombre,
                productos: productos.slice(0, MAX_PRODUCTOS).map(producto),
                hay_mas: productos.length > MAX_PRODUCTOS,
            };
        },
    });

    registry.registrar({
        nombre: 'buscar_producto',
        descripcion:
            'Busca productos de la carta por nombre o por lo que dice su descripción. Úsala ' +
            'cuando el cliente pregunte por algo ' +
            'concreto ("¿tienen hamburguesa doble?", "¿cuánto vale la limonada?") en vez de ' +
            'pedir la carta entera. Si no encuentra nada, dilo y ofrece enseñar las categorías; ' +
            'no inventes productos ni precios: lo único que existe es lo que devuelve esto. ' +
            'Si el producto viene en `agotados_ahora`, SÍ está en la carta pero hoy se acabó: ' +
            'dilo así y ofrece otra cosa; nunca digas que no existe. ' +
            'Si viene `tamano_que_no_hay`, el producto SÍ existe pero no en ese tamaño: dile ' +
            'cuáles hay con sus precios; nunca digas que no está en la carta. ' +
            'Si salen varias presentaciones del mismo plato (personal/pequeña, mediana, grande, ' +
            'familiar, sencilla, doble) y el cliente NO dijo el tamaño, pregúntale cuál quiere ' +
            'con sus precios; nunca elijas tú el tamaño. Si con el término completo no aparece ' +
            'nada, vuelve a buscar con la palabra principal sola (p. ej. «house», «criolla»).',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            termino: { tipo: 'string', requerido: true, min_longitud: 2, max_longitud: 80 },
        },

        async ejecutar({ idNegocio, args }) {
            // ⚠️ `buscarProductos` NO filtra `visible`: es la búsqueda que usa también el
            // panel del negocio, donde ver lo oculto es justo lo que se quiere. Por el bot no
            // puede salir. Se filtra aquí y no en el servicio para no cambiarle el
            // comportamiento a la vertical desde el adaptador — es su contrato, no el nuestro.
            let productos = (await buscarEnLaCarta(idNegocio, args.termino)).filter(
                (p) => p.visible !== false
            );
            // El plato existe pero no en ESE tamaño. Zona Burger, 2026-10-05: «una salchilimon
            // grande» —hay personal y mediana— devolvía vacío, el modelo contestó dos veces «no
            // la encuentro en la carta» y la clienta se fue. Se busca sin el tamaño y se dice
            // cuál es el que no hay: así la respuesta es «grande no, hay estas», no «no existe».
            let terminoUsado = args.termino;
            let tamanoQueNoHay = null;
            if (productos.length === 0) {
                const { resto, tamano } = sinElTamano(args.termino);
                if (tamano) {
                    const sinTamano = (await buscarEnLaCarta(idNegocio, resto)).filter(
                        (p) => p.visible !== false
                    );
                    if (sinTamano.length > 0) {
                        productos = sinTamano;
                        terminoUsado = resto;
                        tamanoQueNoHay = tamano;
                    }
                }
            }
            // Lo que se nombró, y sin descripciones si es una lista: el modelo vuelve a buscar
            // el producto concreto si le preguntan qué trae (ver `afinarResultado`).
            const afinados = afinarResultado(productos, terminoUsado).slice(0, MAX_PRODUCTOS);
            const conDescripcion = afinados.length <= MAX_CON_DESCRIPCION;
            return {
                termino: args.termino,
                productos: afinados.map((p) => producto(p, { conDescripcion })),
                ...(tamanoQueNoHay
                    ? {
                          tamano_que_no_hay: tamanoQueNoHay,
                          nota:
                              `Este producto SÍ está en la carta, pero no en tamaño «${tamanoQueNoHay}». ` +
                              'Dile al cliente las presentaciones que hay, con sus precios, y que elija.',
                      }
                    : {}),
                // Solo cuando no hay nada que vender: así «no tenemos» y «se acabó» dejan de ser
                // la misma respuesta (Zona Burger, 2026-10-02: la Discordia, agotada por un
                // stock en −321, se le dijo a una clienta que «no está en la carta»).
                ...(await conAgotados(idNegocio, args.termino, productos, terminoUsado)),
            };
        },
    });

    registry.registrar({
        nombre: 'consultar_estado_pedido',
        descripcion:
            'Dice en qué va un pedido, por su número (sirve «ORD-7541» o solo «7541»). Úsala ' +
            'cuando el cliente pregunte si ya salió, si ya está listo o dónde está su pedido. ' +
            'Si en la conversación ya salió el número de su pedido, úsalo sin pedírselo otra ' +
            'vez; si no lo tiene, pídeselo. Contesta con `estado_para_el_cliente`, que ya está ' +
            'en palabras del cliente; no le añadas etapas que no dice. El pago casi siempre es al ' +
            'recibir o al recoger: NUNCA le digas que el pedido espera el pago para prepararse o ' +
            'salir. Si `pasado_del_tiempo_estimado` es true y el pedido sigue abierto, discúlpate ' +
            'por la demora y usa pasar_a_persona para que alguien del equipo le diga dónde va. ' +
            'Nunca le digas cuántos minutos lleva su pedido. Si en esta conversación ya le dijiste ' +
            'cómo va y vuelve a preguntar, no repitas: usa pasar_a_persona.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            numero_orden: { tipo: 'string', requerido: true, max_longitud: 40 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            const atributos = [
                'id_orden', 'numero_orden', 'estado', 'estado_cocina', 'estado_pago',
                'tipo_pedido', 'contacto_telefono', 'total', 'fecha_creacion', 'aviso_listo_en',
            ];
            const pedido = String(args.numero_orden).trim();
            let orden = await Models.PedidOrden.findOne({
                where: { id_negocio: idNegocio, numero_orden: pedido },
                attributes: atributos,
                transaction: contexto.transaction,
            });
            // El cliente escribe «7541», no «ORD-7541» (Zona Burger, 2026-10-01: «No encuentro
            // el pedido con el número 7541»). Con solo dígitos se prueba el número con su prefijo.
            const digitos = pedido.replace(/^#/, '').match(/^\d{1,9}$/)?.[0];
            if (!orden && digitos) {
                orden = await Models.PedidOrden.findOne({
                    where: {
                        id_negocio: idNegocio,
                        numero_orden: { [Models.Sequelize.Op.like]: `%-${digitos}` },
                    },
                    attributes: atributos,
                    order: [['fecha_creacion', 'DESC']],
                    transaction: contexto.transaction,
                });
            }

            if (!orden) {
                const e = new Error('No encuentro ese pedido.');
                e.code = 'PEDIDO_NO_ENCONTRADO';
                e.statusCode = 404;
                throw e;
            }

            // Misma regla que en `reserva`: un cliente final solo ve LO SUYO. El número de
            // orden es corto y secuencial —«ORD-12»—, así que aquí adivinar sí es una
            // estrategia: sin esta comprobación, cualquiera podría recorrer los números y leer
            // el teléfono y el total de los pedidos de los demás.
            //
            // Falla cerrada por lo mismo que allí: sin teléfono probado (WebChat) o sin
            // teléfono en el pedido (uno de mesa, que no tiene cliente asociado) se deniega.
            if (contexto.principal && contexto.principal.tipo === TIPO.CONTACTO) {
                const deQuienPide = normalizarE164Colombia(contexto.principal.telefono_verificado);
                const delPedido = normalizarE164Colombia(orden.contacto_telefono);

                if (!deQuienPide || !delPedido || deQuienPide !== delPedido) {
                    const e = new Error(
                        'No puedo comprobar que ese pedido sea tuyo. Llama al restaurante y te dicen enseguida.'
                    );
                    e.code = 'PEDIDO_NO_ES_DE_QUIEN_PIDE';
                    e.statusCode = 403;
                    throw e;
                }
            }

            // ⚠️ `estado_pago` ya NO sale crudo. Con «pendiente_pago» delante, el modelo le dijo
            // cinco veces a una clienta que su pedido no entraba a cocina «porque está pendiente
            // de pago», cuando iba a pagar en efectivo al recibirlo (Zona Burger, 2026-10-01).
            const abierta = orden.estado === 'ABIERTA';
            const ficha = abierta ? await leerFichaDelNegocio(idNegocio, contexto.transaction) : null;
            return {
                numero_orden: orden.numero_orden,
                estado_para_el_cliente: estadoParaElCliente(orden),
                tipo_pedido: orden.tipo_pedido,
                total: precio(orden.total),
                ya_pagado: orden.estado_pago === 'pagado' || orden.estado === 'CERRADA',
                ...(abierta
                    ? {
                          // Solo si ya pasó el tiempo, NO cuántos minutos lleva: con el número
                          // delante el modelo contestó «va en 57 minutos desde que se pidió» a
                          // quien reclamaba la demora (Zona Burger, 2026-10-04). Suena a reproche.
                          pasado_del_tiempo_estimado: tiempoDelPedido(orden, {
                              min: ficha?.tiempo_estimado_min,
                              max: ficha?.tiempo_estimado_max,
                          }).pasado_del_tiempo_estimado,
                          // Lo que el negocio declaró, dicho tal cual. Sin esto el modelo sabía cuánto
                          // llevaba el pedido pero no cuánto suele tardar, y contestaba «aún no tengo
                          // un tiempo estimado» (Zona Burger, 2026-10-03: «Cuánto te demoras?»).
                          ...(Number(ficha?.tiempo_estimado_min) > 0
                              ? {
                                    tiempo_estimado_del_negocio:
                                        Number(ficha.tiempo_estimado_max) > Number(ficha.tiempo_estimado_min)
                                            ? `${ficha.tiempo_estimado_min} a ${ficha.tiempo_estimado_max} minutos`
                                            : `unos ${ficha.tiempo_estimado_min} minutos`,
                                }
                              : {}),
                      }
                    : {}),
            };
        },
    });

    registry.registrar({
        nombre: 'consultar_info_negocio',
        descripcion:
            'Los datos prácticos del restaurante: si está abierto AHORA y su horario de hoy, ' +
            'con qué se puede pagar y CÓMO según el tipo de pedido (`como_pagar`: dilo tal cual, sin ' +
            'mezclar el de domicilio con el de llevar), el número de Nequi si el negocio lo dio, ' +
            'cuánto vale el domicilio (un rango de precios, o por barrio si lo tiene; con rango, ' +
            'di el rango tal cual y que el valor exacto lo confirma el restaurante — nunca elijas ' +
            'tú un valor dentro del rango ni decidas si un barrio queda fuera de la ciudad), cuánto suele tardar un pedido y ' +
            'notas que el negocio dejó para ti. Úsala SIEMPRE antes de decir «no tengo esa ' +
            'información» cuando pregunten por pagos, Nequi, efectivo, transferencia, valor del ' +
            'domicilio, horario, si siguen atendiendo o cuánto se demoran. Ojo: en Colombia ' +
            '«cancelar» también es PAGAR («¿cuánto le cancelo?», «cancelo por Nequi», «le ' +
            'cancelo al domiciliario»): eso es una pregunta de pago, no una anulación. Lo que ' +
            'no venga aquí, no lo inventes: di que lo confirma el restaurante.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {},

        async ejecutar({ idNegocio, contexto }) {
            const ahora = new Date();
            const [{ estado }, proxima, bloques, metodos, domicilio, negocio] = await Promise.all([
                horarioService.estadoDeAtencion({ idNegocio, ahora }),
                horarioService.proximaApertura({ idNegocio, ahora }),
                Models.RestHorario.findAll({
                    where: { id_negocio: idNegocio, id_usuario: null },
                    attributes: ['dia_semana', 'hora_inicio', 'hora_fin'],
                    order: [['hora_inicio', 'ASC']],
                    transaction: contexto.transaction,
                }),
                Models.RestMetodoPago.findAll({
                    where: { id_negocio: idNegocio, estado: 'A', es_cuenta: false },
                    attributes: ['nombre'],
                    order: [['nombre', 'ASC']],
                    transaction: contexto.transaction,
                }),
                barrioService.listarPublico(idNegocio).catch(() => ({ habilitado: false, barrios: [] })),
                leerFichaDelNegocio(idNegocio, contexto.transaction),
            ]);

            const ESTADOS = {
                abierto: 'abierto, tomando pedidos',
                fuera_de_horario: 'cerrado: fuera del horario de atención',
                aun_no_abre: 'todavía no ha abierto hoy (es su horario, pero aún no abren)',
                cerrado_sin_horario: 'cerrado ahora mismo',
            };
            // Bogotá, igual que `horarioService`: 0=Dom..6=Sáb.
            const hoy = new Date(ahora.getTime() - 5 * 3600 * 1000).getUTCDay();
            const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
            const franjasHoy = bloques
                .filter((b) => Number(b.dia_semana) === hoy)
                .map((b) => `${String(b.hora_inicio).slice(0, 5)} a ${String(b.hora_fin).slice(0, 5)}`);

            const barrios = domicilio.habilitado ? domicilio.barrios : [];
            return {
                atencion_ahora: ESTADOS[estado] || estado,
                horario_hoy: bloques.length === 0 ? null : franjasHoy.length ? franjasHoy : 'hoy no abre',
                proxima_apertura:
                    estado === 'abierto' || !proxima
                        ? null
                        : `${proxima.dias_adelante === 0 ? 'hoy' : DIAS[proxima.dia_semana]} a las ${proxima.hora}`,
                metodos_de_pago: metodos.map((m) => m.nombre),
                // Cómo se paga según el pedido, con las palabras del negocio (a domicilio se paga al
                // domiciliario; para llevar o en mesa, por transferencia al local). Dilo tal cual.
                como_pagar: await (async () => {
                    const t = await pago.textosDePago(idNegocio);
                    return t.domicilio || t.local
                        ? { a_domicilio: t.domicilio, para_llevar_o_en_mesa: t.local }
                        : null;
                })(),
                // El rango que declaró el negocio (2026-10-02): «entre $7.000 y $9.000» + su nota.
                // Si además hay barrios con precio, el del barrio es el exacto.
                domicilio_rango: negocio.domicilio_rango
                    ? {
                          valor: rangoEnPalabras(negocio.domicilio_rango),
                          nota: negocio.domicilio_rango.nota,
                          // 2026-10-04: el modelo decidió que San Vicente (un barrio de Pasto)
                          // era «fuera de Pasto», le dio a un cliente frecuente el valor de fuera
                          // y casi lo pierde. Qué queda dentro o fuera no lo sabe: no lo adivina.
                          como_usarlo:
                              'Con cualquier barrio, conjunto o dirección da `valor` tal cual y di que el ' +
                              'restaurante confirma el exacto. NUNCA decidas tú si un barrio o lugar queda ' +
                              'dentro o fuera de la ciudad: lo que diga `nota` sobre «fuera» solo aplica si ' +
                              'el cliente mismo dice que es otro municipio o una vereda.',
                      }
                    : null,
                domicilio_por_barrio: barrios.slice(0, 40).map((b) => ({
                    barrio: b.nombre,
                    valor: precio(b.valor),
                })),
                tiempo_estimado_min: negocio.tiempo_estimado_min,
                tiempo_estimado_max: negocio.tiempo_estimado_max,
                // El de arriba es el de un DOMICILIO. Para recoger o comer en el local, este.
                ...(negocio.tiempo_recoger
                    ? {
                          tiempo_para_recoger_min: negocio.tiempo_recoger.min,
                          tiempo_para_recoger_max: negocio.tiempo_recoger.max,
                          como_usar_los_tiempos:
                              '`tiempo_estimado` es para pedidos a domicilio; `tiempo_para_recoger` para ' +
                              'los que el cliente recoge o come en el local. Di el que corresponda a ' +
                              'cómo lo va a recibir; si aún no lo sabes, di los dos en una frase.',
                      }
                    : {}),
                notas_del_negocio: negocio.info_asistente,
            };
        },
    });

    registry.registrar({
        nombre: 'consultar_cuenta',
        descripcion:
            'Dice el saldo de la tiquetera o de la cuenta fiada del cliente que escribe: ' +
            'cuánto tiene a favor, cuánto debe, o cuántos tiquetes le quedan. Úsala cuando ' +
            'pregunte "¿cuánto me queda?", "¿cuánto debo?" o algo de su cuenta o tiquetera. ' +
            'No todos los restaurantes manejan esto: si el negocio no lo tiene activado, dilo ' +
            'sin más y no ofrezcas abrirle una.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {},

        async ejecutar({ idNegocio, contexto }) {
            // Opt-in por negocio (`permite_cuentas_cliente`), igual que en `cuentaController`.
            // Se comprueba aquí y no solo con la habilitación de la capacidad en el Registry
            // porque son dos apagadores distintos que un negocio puede accionar en momentos
            // distintos: uno es comercial/de dominio (¿puede este negocio usar la capacidad?),
            // el otro es que el propio negocio nunca prendió el módulo de tiqueteras.
            const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
                attributes: ['id_negocio', 'permite_cuentas_cliente'],
                transaction: contexto.transaction,
            });
            if (!negocio?.permite_cuentas_cliente) {
                const e = new Error('Este restaurante no maneja tiqueteras ni cuentas de cliente.');
                e.code = 'CUENTAS_NO_HABILITADAS';
                e.statusCode = 403;
                throw e;
            }

            // Sin teléfono probado por el canal no hay a quién buscarle cuenta — decir un
            // número no prueba que sea el suyo, la misma regla que en `consultar_estado_pedido`.
            const telefono =
                contexto.principal?.tipo === TIPO.CONTACTO
                    ? normalizarE164Colombia(contexto.principal.telefono_verificado)
                    : null;
            if (!telefono) {
                const e = new Error('No puedo comprobar tu número desde aquí. Llama al restaurante.');
                e.code = 'TELEFONO_NO_VERIFICADO';
                e.statusCode = 403;
                throw e;
            }

            const cuenta = await cuentaService.buscarCuentaPorTelefono({
                idNegocio,
                telefono,
                transaction: contexto.transaction,
            });
            if (!cuenta) {
                const e = new Error('No encuentro ninguna cuenta o tiquetera a tu nombre.');
                e.code = 'CUENTA_NO_ENCONTRADA';
                e.statusCode = 404;
                throw e;
            }

            return {
                modo: cuenta.modo,
                saldo: cuenta.modo === cuentaService.MODO.DINERO ? precio(cuenta.saldo) : null,
                disponible: cuenta.modo === cuentaService.MODO.DINERO ? precio(cuenta.disponible) : null,
                tiquetes:
                    cuenta.modo === cuentaService.MODO.TIQUETES
                        ? cuenta.tiquetes.map((t) => ({ producto: t.producto, disponibles: t.disponibles }))
                        : null,
            };
        },
    });

    registry.registrar({
        nombre: 'tomar_pedido',
        descripcion:
            'Crea un pedido con los productos que el cliente eligió, para llevárselo a domicilio ' +
            'o para que pase a recogerlo. Úsala solo cuando tengas los id_producto (de ' +
            'consultar_carta o buscar_producto), las cantidades, el nombre, y si es domicilio o ' +
            'para recoger — pregúntaselo, no lo supongas. La dirección hace falta SOLO si es ' +
            'domicilio. **El pedido entra a la cocina AHORA: no existe programarlo para más ' +
            'tarde ni para otro día.** Devuelve el número de pedido, que hace falta ' +
            'para consultar su estado después. Al pedirla, el negocio le enseña al cliente una ' +
            'pregunta de confirmación y no se ejecuta hasta que diga sí: no le digas que ya está hecho.',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        // NO es idempotente, y decirlo importa: dos llamadas crean dos pedidos. A diferencia de
        // `reservar_turno` —que consume un hold y por eso la segunda vez no encuentra nada— aquí
        // no hay nada que se gaste. Lo que evita el pedido doble es la clave de idempotencia que
        // pone el motor (el id del turno), no una propiedad del dominio. Declararlo idempotente
        // sería mentirle al Gate sobre una garantía que nadie da.
        idempotente: false,
        // Aquí nace una orden en la caja de un negocio real, con inventario que se consume. No
        // se ejecuta sin un sí explícito del cliente en el canal (ADR-010, paso 5).
        confirmacion: {
            // Se dice CUÁNTO se pide, no solo a nombre de quién. Quien confirma un domicilio
            // está aceptando que salga de la cocina: el mensaje tiene que dejarle comprobar de
            // un vistazo que es su pedido y no el de otra conversación.
            pregunta: async ({ args, idNegocio }) => {
                // `comoLista` porque esto corre sobre los argumentos CRUDOS: el modelo manda
                // `items` serializado de vez en cuando, y aquí todavía no ha pasado por el
                // validador. Ver `core/argumentos.js#comoLista`.
                const items = Array.isArray(comoLista(args.items)) ? comoLista(args.items) : [];
                const unidades = items.reduce((n, i) => n + Number(i?.cantidad || 0), 0);

                // Cómo lo recibe va en la pregunta, y no de adorno: es lo que deja que el
                // cliente cace aquí —antes de que salga nada de la cocina— que le entendimos
                // al revés. Es el único punto del flujo donde todavía sale gratis.
                const recoge = args.tipo_entrega === 'LLEVAR';
                const enMesa = args.tipo_entrega === 'MESA';

                // La mesa y el barrio que dijo el cliente son sugerencias: aquí se RELEEN para
                // enseñar lo que de verdad se va a apuntar y cobrar. Un fallo no tumba la
                // confirmación (ADR-010 no la negocia): sin el detalle, se pide igual.
                let nombreMesa = null;
                let sumaACuenta = false;
                if (enMesa && args.id_mesa) {
                    try {
                        const mesa = await mesaPublicaService.resolverMesa({
                            idNegocio,
                            idMesa: args.id_mesa,
                        });
                        nombreMesa = mesa.nombre;
                        // Si la mesa ya tiene cuenta abierta, esto se SUMA a ella: se dice antes
                        // del «sí», porque el cliente tiene que saber que no es una cuenta aparte.
                        sumaACuenta = Boolean(
                            await mesaPublicaService.cuentaAbierta({ idNegocio, idMesa: mesa.id_mesa })
                        );
                    } catch (_) {
                        nombreMesa = null;
                    }
                }
                let domicilio = null;
                if (args.tipo_entrega === 'DOMICILIO' && args.id_barrio) {
                    try {
                        const r = await barrioService.valorDomicilioDe({
                            idNegocio,
                            idBarrio: args.id_barrio,
                        });
                        if (r.valor > 0) domicilio = { barrio: r.barrio.nombre, valor: r.valor };
                    } catch (_) {
                        domicilio = null;
                    }
                }

                // Sin mesa = «para servir»: el cliente viene en camino y la mesa la pone el
                // sistema al crear el pedido (ver `ejecutar`).
                const paraServir = enMesa && !args.id_mesa;
                const donde = paraServir
                    ? 'para servirlo en el local (te guardamos una mesa)'
                    : enMesa
                    ? sumaACuenta
                        ? `para sumarlo a la cuenta de tu mesa${nombreMesa ? ` (${nombreMesa})` : ''}`
                        : `para tu mesa${nombreMesa ? ` (${nombreMesa})` : ''}`
                    : recoge
                      ? 'para recogerlo en el local'
                      : `para llevártelo a ${args.direccion}`;
                const cabecera = `¿Confirmo tu pedido a nombre de ${args.cliente_nombre}, ${donde}?`;

                /**
                 * El aviso de que el total no es la cuenta final.
                 *
                 * Pedido por el dueño el 2026-09-08, y no es un formalismo: el cliente que ve
                 * «$45.000» y paga $48.000 en la puerta siente que le cobraron de más, aunque
                 * el empaque siempre se hayan cobrado. Decirlo antes cuesta una línea;
                 * no decirlo cuesta la discusión con el domiciliario delante.
                 *
                 * El domicilio solo se nombra cuando lo hay: avisar de un recargo imposible a
                 * quien va a pasar por el local es ruido que resta credibilidad al resto.
                 */
                // Sin barrio con precio exacto, el rango que declaró el negocio (2026-10-02): no se
                // suma —no hay un valor que sumar—, pero el cliente sabe cuánto más le espera.
                let rango = null;
                if (!recoge && !enMesa && !domicilio) {
                    rango = rangoEnPalabras(await leerDomicilioRango(idNegocio));
                }
                const aviso =
                    recoge || enMesa || domicilio
                        ? '_El total es aproximado: puede variar por el empaque._'
                        : rango === 'gratis'
                          ? '_El total es aproximado: puede variar por el empaque. El domicilio es gratis._'
                          : rango
                            ? `_El total es aproximado: no incluye el domicilio (${rango}, te lo confirma el restaurante) y puede variar por el empaque._`
                            : '_El total es aproximado: no incluye el domicilio y puede variar por el empaque._';

                /**
                 * La lista de productos, con su precio y el total.
                 *
                 * ## Por qué se releen del catálogo
                 *
                 * Por lo mismo que los relee `ejecutar`: los precios que trae la conversación
                 * pueden ser de hace veinte turnos o inventados por el modelo. Si la frase en la
                 * que el cliente se compromete dijera un precio que no es el que se le va a
                 * cobrar, la confirmación estaría certificando una cifra falsa — peor que no
                 * enseñar ninguna.
                 *
                 * ## Y por qué esto no puede tumbar el turno
                 *
                 * Porque es la primera pieza que toca datos en los que no se puede confiar, y ya
                 * costó un turno mudo en producción el 2026-08-27. Cualquier fallo —una consulta
                 * caída, un `id_producto` que es una cadena— cae al `catch` y se contesta con la
                 * frase de siempre, la del recuento. Lo que se degrada es el detalle; **la
                 * confirmación se pide igual**, que es lo que ADR-010 no negocia.
                 */
                try {
                    const ids = items
                        .map((i) => Number(i?.id_producto))
                        .filter((n) => Number.isInteger(n) && n > 0);
                    if (ids.length === 0) throw new Error('sin ids utilizables');

                    const productos = await Models.CartaProducto.findAll({
                        where: { id_negocio: idNegocio, id_producto: ids },
                        attributes: ['id_producto', 'nombre', 'precio'],
                    });
                    const porId = new Map(productos.map((p) => [p.id_producto, p]));

                    // Lo que el cliente quitó de cada plato se RELEE aquí y se enseña solo lo válido:
                    // un ingrediente desactivado o que ya no es removible se descarta y se dice
                    // («no pudimos quitar: X»), antes del «sí». `ejecutar` vuelve a comprobarlo.
                    const quitadas = await exclusiones.resolver({
                        idNegocio,
                        lineas: items.map((i) => ({
                            id_producto: Number(i?.id_producto),
                            ids: exclusiones.leerSin(i?.sin),
                        })),
                    });
                    const descartadas = [];

                    let total = 0;
                    const lineas = items.map((i, k) => {
                        const p = porId.get(Number(i?.id_producto));
                        const cantidad = Number(i?.cantidad) || 1;
                        if (!p) throw new Error('un producto del pedido ya no está en la carta');
                        const subtotal = Number(p.precio) * cantidad;
                        total += subtotal;
                        descartadas.push(...quitadas[k].descartadas);
                        const sin = quitadas[k].validas.length
                            ? ` (${quitadas[k].validas.map((v) => `sin ${v.nombre}`).join(', ')})`
                            : '';
                        return `• ${cantidad} × ${p.nombre}${sin} — ${enPesos(subtotal)}`;
                    });

                    // Las que el flujo ya descartó al leer el código de la carta (`sin_descartadas`)
                    // más las que dejaron de valer desde entonces.
                    const previas = String(args.sin_descartadas || '').split(',').map((x) => x.trim()).filter(Boolean);
                    const noQuitadas = [
                        ...new Set([...previas, ...exclusiones.nombresLegibles(descartadas).split(', ').filter(Boolean)]),
                    ];
                    const avisoQuitar = noQuitadas.length
                        ? [`_(no pudimos quitar: ${noQuitadas.join(', ')})_`]
                        : [];

                    // El domicilio va como línea propia y suma al total ANTES del «sí»: lo que el
                    // cliente confirma tiene que ser lo que se le va a cobrar en la puerta.
                    const lineaDomicilio = domicilio
                        ? [`• Domicilio (${domicilio.barrio}) — ${enPesos(domicilio.valor)}`]
                        : [];
                    if (domicilio) total += domicilio.valor;

                    // La nota se enseña antes del «sí»: si el cliente añadió algo mientras se le
                    // preguntaba («Alameda 2, entrada al barrio»), tiene que ver que quedó.
                    const nota = String(args.nota || '').trim();

                    // El empaque va como línea propia, igual que el domicilio: es lo que se le va a
                    // cobrar. Si ya está sumado, el aviso de «puede variar por el empaque» sobra.
                    const empaques = await empaqueService.calcular({
                        idNegocio,
                        tipoPedido: args.tipo_entrega,
                        items,
                    });
                    const lineasEmpaque = empaques.map((e) => {
                        total += e.precio_unitario * e.cantidad;
                        return `• Empaque ${e.nombre} × ${e.cantidad} — ${enPesos(e.precio_unitario * e.cantidad)}`;
                    });
                    const avisoFinal = empaques.length
                        ? aviso.replace('puede variar por el empaque', 'puede variar si cambias algo')
                        : aviso;

                    // Cuánto falta, dicho ANTES del «sí»: es lo que el cliente pregunta justo
                    // después («¿cuánto se demora?», en una de cada tres conversaciones del
                    // 2026-10-07) y es parte de lo que está aceptando. No con una mesa ya
                    // asignada: quien está sentado no espera un «estará en…».
                    const cuanto = enMesa && args.id_mesa ? null : await lineaDeTiempo(idNegocio, args.tipo_entrega);

                    return [
                        cabecera,
                        '',
                        ...lineas,
                        ...lineasEmpaque,
                        ...lineaDomicilio,
                        ...avisoQuitar,
                        ...(nota ? [`📝 _Nota: ${nota}_`] : []),
                        '',
                        `*Total: ${enPesos(total)}*`,
                        ...(cuanto ? [cuanto] : []),
                        avisoFinal,
                    ].join('\n');
                } catch (error) {
                    console.warn(
                        `[tomar_pedido] no se pudo detallar el pedido en la confirmación: ${error.message}`
                    );
                    return (
                        `¿Confirmo tu pedido de ${unidades} ${unidades === 1 ? 'producto' : 'productos'} ` +
                        `a nombre de ${args.cliente_nombre}, ${donde}?`
                    );
                }
            },
            // Lo que el cliente escribe mientras se le pregunta («Alameda 2, entrada al barrio
            // común», «Hit de lulo si tiene») va a la nota del pedido, que es lo que lee la
            // cocina y el domiciliario. Antes se perdía (Zona Burger, 2026-10-01). Ver
            // `engine/confirmacion.js#lineasParaAnotar`. Tope de 500, el de `nota`.
            anotar: ({ args, texto }) => {
                const previa = String(args?.nota || '').trim();
                const nota = (previa ? `${previa}. ${texto}` : texto).slice(0, 500);
                return { ...args, nota };
            },
            // «Para recoger» no se supone. Si el modelo lo pone y en el chat nadie ha hablado de
            // recoger —ni el cliente lo dijo ni se le preguntó—, se le devuelve para que pregunte
            // (Zona Burger, 2026-10-05: un domicilio quedó tomado para recoger). Solo LLEVAR: es
            // lo que el modelo elige cuando no sabe; un domicilio ya exige dirección y teléfono.
            falta: async ({
                args,
                cliente = [],
                asistente = [],
                hilo = [],
                idConversacion = null,
                idNegocio = null,
                telefono = null,
            }) => {
                // Antes que nada: ¿este chat ya tomó un pedido hace poco —o se lo tomó el negocio
                // a mano— y el cliente solo quiere cambiarle algo? Ver `pedidoQueYaSeTomo`.
                const repetido = await pedidoQueYaSeTomo({
                    hilo,
                    idConversacion,
                    idNegocio,
                    telefonos: [telefono, args?.cliente_telefono],
                });
                if (repetido) return repetido;
                // Ni la dirección, ni el nombre, ni cómo lo recibe se rellenan: si el modelo no
                // los tiene, pregunta. Y si le falta más de una cosa, las pregunta JUNTAS: antes
                // cada falta volvía sola y eran dos turnos («¿a nombre de quién?», y luego «¿para
                // recoger, a domicilio…?») para lo que cabe en un mensaje. Zona Burger,
                // 2026-10-07: siete mensajes para una salchipapa para recoger.
                return loQueFalta({
                    entrega: entregaSinDecir({ args, cliente, asistente, hilo }),
                    direccion:
                        args?.tipo_entrega === 'DOMICILIO' &&
                        args?.direccion != null &&
                        DIRECCION_DE_RELLENO.test(normalizarTexto(args.direccion).trim()),
                    nombre: NOMBRE_DE_RELLENO.test(normalizarTexto(args?.cliente_nombre ?? '').trim()),
                });
            },
            hecho: ({ resultado }) =>
                resultado.suma_a_cuenta
                    ? `¡Listo! Lo sumé a la cuenta de tu mesa (${resultado.mesa}).`
                    : resultado.para_servir
                      ? `¡Listo! Tu pedido quedó para servir en el local: te guardamos la *${resultado.mesa}*. ` +
                        `El número es ${resultado.numero_orden} 🍽️`
                      : `¡Listo! Tu pedido quedó tomado. El número es ${resultado.numero_orden} — ` +
                        'guárdalo para consultar cómo va.',
        },
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            items: {
                tipo: 'lista',
                requerido: true,
                min_items: 1,
                max_items: 20,
                // La forma de cada elemento se declara, no se asume. Sin esto el modelo podría
                // mandar `[{producto: 'hamburguesa'}]` y el fallo aparecería dentro de
                // `crearOrden`, en un sitio que no sabe explicárselo a nadie.
                elemento: {
                    id_producto: { tipo: 'entero', requerido: true, min: 1 },
                    cantidad: { tipo: 'entero', requerido: true, min: 1, max: 50 },
                    // Ingredientes que se quitan de ESTA línea, como ids separados por punto
                    // («12.15»). Texto y no lista porque el motor de argumentos no anida listas
                    // de escalares; `ejecutar` los relee y solo guarda los removibles del producto.
                    sin: { tipo: 'string', requerido: false, max_longitud: 100 },
                },
            },
            // Nombres de lo que el flujo ya descartó al leer el código de la carta: solo para que
            // la confirmación lo diga («no pudimos quitar: X»). No se usa para nada más.
            sin_descartadas: { tipo: 'string', requerido: false, max_longitud: 300 },
            cliente_nombre: { tipo: 'string', requerido: true, min_longitud: 2, max_longitud: 150 },
            /**
             * Cómo recibe el cliente su pedido. **Obligatorio y sin valor por defecto**, que es
             * la decisión que importa de este parámetro.
             *
             * La tentación es que ausente signifique domicilio, porque hasta hoy todo lo era y
             * así ninguna llamada vieja se rompe. Pero un valor por defecto aquí es un
             * domiciliario saliendo a una dirección que nadie dio cada vez que el modelo se
             * olvide de preguntar — y los fallos por omisión son justo los que nadie ve venir.
             * Prefiero que el Gate lo rechace y el modelo pregunte: cuesta un turno.
             *
             * Los valores son los del dominio (`pedid_orden.tipo_pedido`), no una traducción.
             */
            tipo_entrega: {
                tipo: 'enum',
                requerido: true,
                valores: ['DOMICILIO', 'LLEVAR', 'MESA'],
                descripcion:
                    'DOMICILIO si se lo llevamos a su dirección, LLEVAR si el cliente pasa a ' +
                    'recogerlo por el local, MESA si va a comer EN el local. En Colombia «para ' +
                    'servir», «para comer aquí» o «para consumir en el local» es MESA. Si viene en ' +
                    'camino o no sabe su mesa, NO le preguntes la mesa: manda MESA sin id_mesa y el ' +
                    'sistema le guarda una libre. Pregúntaselo antes: no lo supongas.',
            },
            // Ambos son SUGERENCIAS del cliente: `ejecutar` los relee de la base, comprueba que
            // sean de este negocio y calcula el valor del domicilio él mismo. Un precio que
            // venga en el mensaje no se lee en ningún sitio.
            id_barrio: { tipo: 'entero', requerido: false, min: 1 },
            id_mesa: { tipo: 'entero', requerido: false, min: 1 },
            // Obligatoria **solo si es domicilio**, y eso no lo sabe expresar el validador: la
            // comprueba `ejecutar`, que es quien ve los dos argumentos a la vez. Declararla
            // obligatoria aquí impediría el pedido para recoger; declararla y no comprobarla
            // dejaría crear domicilios sin dirección, que es peor.
            direccion: { tipo: 'string', requerido: false, min_longitud: 5, max_longitud: 300 },
            // ⚠️ Un teléfono de CONTACTO, no una identidad.
            //
            // Solo se usa cuando el canal no probó ninguno — desde el cambio de identidad de
            // WhatsApp (BSUID) hay clientes que llegan sin número, y un domicilio sin un número
            // al que llamar es un domicilio que se pierde en la puerta. Lo que **nunca** hace es
            // autorizar: quien dice un número no prueba nada, y la pertenencia de un pedido se
            // sigue comprobando contra `principal.telefono_verificado`.
            cliente_telefono: { tipo: 'string', requerido: false, min_longitud: 7, max_longitud: 40 },
            nota: { tipo: 'string', requerido: false, max_longitud: 500 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            // ── 0. El horario de atención del negocio ─────────────────────────────────────
            //
            // Va ANTES que la caja porque son dos preguntas distintas y el cliente necesita
            // saber cuál de las dos es: «estamos cerrados por hoy» no es «ya es hora, pero
            // todavía no hemos abierto la caja» — la primera dice que vuelva otro día o más
            // tarde, la segunda que espere un momento. `estaAbierto` devuelve `configurado:
            // false` cuando el negocio nunca cargó un horario propio, y entonces no hay nada
            // que comprobar aquí — sin horario cargado, esto no restringe nada (ver
            // `migrate_restaurante_horario.js`).
            const horario = await horarioService.estaAbierto({
                idNegocio,
                transaction: contexto.transaction,
            });
            if (horario.configurado && !horario.abierto) {
                let cuandoAbre = null;
                try {
                    cuandoAbre = fraseDeApertura(
                        await horarioService.proximaApertura({ idNegocio })
                    );
                } catch (_) {
                    cuandoAbre = null;
                }
                const e = new Error(
                    'Ahora mismo estamos fuera de nuestro horario de atención. ' +
                        (cuandoAbre || 'Te atendemos apenas sea posible.') +
                        ' Si quieres, puedes ir mirando la carta mientras tanto.'
                );
                e.code = 'FUERA_DE_HORARIO_ATENCION';
                e.statusCode = 409;
                throw e;
            }

            // ── 1. La caja tiene que estar abierta ────────────────────────────────────────
            //
            // Es una regla del negocio, no un obstáculo que rodear: una orden no existe fuera
            // de un turno de caja. Se comprueba ANTES y con un mensaje que un cliente entienda,
            // porque si no `crearOrden` lanza su propio error y el bot acabaría diciéndole a
            // alguien a las 3 de la mañana algo que no significa nada para él.
            // Se usa `requireCajaAbierta` y no `getCajaAbierta` porque es la que acepta
            // transacción —y toma el lock—, que es lo que hace que la caja no pueda cerrarse
            // entre esta comprobación y la creación de la orden. Su error se traduce a uno que
            // un cliente entienda: el suyo habla de turnos de caja, que no significa nada para
            // quien solo quiere una hamburguesa.
            //
            // El mensaje cambia si YA sabemos que estamos en horario de atención: «cerrado»
            // a secas confundiría a alguien que está viendo el horario publicado y ve que
            // debería estar abierto — lo que pasa es que nadie ha abierto la caja todavía.
            try {
                await cajaService.requireCajaAbierta(idNegocio, { transaction: contexto.transaction });
            } catch (_) {
                const e = new Error(
                    horario.configurado
                        ? 'Ya estamos en nuestro horario de atención, pero el restaurante todavía ' +
                              'no ha abierto. Danos un momento y vuelve a escribir.'
                        : 'El restaurante está cerrado ahora mismo y no puedo tomar pedidos.'
                );
                e.code = horario.configurado ? 'NEGOCIO_AUN_NO_ABRE' : 'RESTAURANTE_CERRADO';
                e.statusCode = 409;
                throw e;
            }

            // ── 2. Los productos, releídos del dominio ────────────────────────────────────
            //
            // No se confía en los precios que traiga la conversación. El modelo pudo haber
            // leído la carta hace veinte turnos, o haberla recordado mal, y un pedido con un
            // precio inventado es una discusión en la puerta del cliente. Se releen aquí, y de
            // paso se comprueba que sigan estando disponibles y visibles.
            const idsPedidos = args.items.map((i) => Number(i.id_producto));
            const productos = await Models.CartaProducto.findAll({
                where: {
                    id_negocio: idNegocio,
                    id_producto: idsPedidos,
                    estado: 'A',
                    disponible: true,
                    visible: true,
                },
                attributes: ['id_producto', 'nombre', 'precio'],
                transaction: contexto.transaction,
            });

            const porId = new Map(productos.map((pr) => [pr.id_producto, pr]));
            const faltantes = idsPedidos.filter((id) => !porId.has(id));
            if (faltantes.length > 0) {
                const e = new Error(
                    'Alguno de esos productos ya no está disponible. Vuelve a consultar la carta ' +
                        'antes de prometer nada.'
                );
                e.code = 'PRODUCTO_NO_DISPONIBLE';
                e.statusCode = 409;
                throw e;
            }

            // ── 2-bis. Lo que el cliente quitó: se RELEE y se exige que siga valiendo ────────
            //
            // La confirmación ya mostró solo las exclusiones válidas (y dijo las que no). Aquí se
            // vuelve a comprobar: si algo de lo confirmado dejó de ser removible de ese producto
            // en este negocio —una ventana de segundos— se rechaza con `EXCLUSION_INVALIDA` en vez
            // de guardar a medias. Nunca se guarda un id que no sea removible de ese producto.
            const quitadasOrden = await exclusiones.resolver({
                idNegocio,
                lineas: args.items.map((i) => ({
                    id_producto: Number(i.id_producto),
                    ids: exclusiones.leerSin(i.sin),
                })),
                transaction: contexto.transaction,
            });
            const rechazadas = quitadasOrden.flatMap((r) => r.descartadas);
            if (rechazadas.length > 0) {
                const e = new Error(
                    `Ya no puedo quitar ${exclusiones.nombresLegibles(rechazadas)} de tu pedido. ` +
                        'Vuelve a armarlo o llama al restaurante.'
                );
                e.code = 'EXCLUSION_INVALIDA';
                e.statusCode = 400;
                throw e;
            }
            const itemsParaOrden = args.items.map((i, k) => ({
                id_producto: Number(i.id_producto),
                cantidad: Number(i.cantidad) || 1,
                // `precio_unitario` sale del producto que se acaba de releer, NUNCA de la
                // conversación: si viniera del modelo, un pedido podría cobrarse a lo que el bot
                // recordara de hace veinte turnos.
                precio_unitario: Number(porId.get(Number(i.id_producto)).precio),
                ...(quitadasOrden[k].validas.length
                    ? { exclusiones: quitadasOrden[k].validas.map((v) => v.id_ingrediente) }
                    : {}),
            }));

            // ── 2-ter. El empaque, calculado por el servidor ─────────────────────────────
            //
            // Solo para llevar y domicilio, y solo de los productos que tienen empaque ligado.
            // Hasta hoy el bot cotizaba sin él y el negocio lo cobraba después a mano: el cliente
            // pagaba más de lo que se le dijo, o el negocio cobraba menos de lo que debía.
            const empaquesOrden = await empaqueService.calcular({
                idNegocio,
                tipoPedido: args.tipo_entrega,
                items: itemsParaOrden,
                transaction: contexto.transaction,
            });
            itemsParaOrden.push(
                ...empaquesOrden.map((e) => ({
                    id_producto: e.id_producto,
                    cantidad: e.cantidad,
                    precio_unitario: e.precio_unitario,
                }))
            );

            // ── 3. El autor de la orden ───────────────────────────────────────────────────
            //
            // `pedid_orden.id_usuario` es NOT NULL y un pedido de WhatsApp no tiene empleado
            // detrás. Va a nombre del usuario «Asistente» de ESTE negocio para que el informe
            // de ventas por usuario diga la verdad — ver `usuarioAsistenteDao`.
            const idUsuario = await usuarioAsistenteDao.resolverOCrear(idNegocio, {
                transaction: contexto.transaction,
            });

            // ── El teléfono: dos cosas distintas con el mismo aspecto ────────────────────
            //
            // El que **prueba** quién es manda siempre, y lo impone la plataforma, no el modelo:
            // de él cuelga que después solo el dueño pueda consultar su pedido. Misma regla que
            // en `reservar_turno`.
            //
            // Pero desde el cambio de identidad de WhatsApp (BSUID, 2026) hay clientes que
            // llegan **sin número**: el canal no prueba ninguno. Ahí el pedido se guardaba con
            // `contacto_telefono` nulo y el restaurante recibía un domicilio sin nadie a quien
            // llamar cuando el domiciliario no encuentra la casa. Así que se acepta el que el
            // cliente **diga**, y solo entonces — nunca por encima del probado.
            //
            // Lo que se guarda aquí es dato de contacto para el domiciliario. **No autoriza
            // nada**: la comprobación de pertenencia sigue mirando `telefono_verificado`, que
            // para este cliente seguirá siendo nulo. Decir un número no prueba que sea el tuyo.
            const telefono =
                contexto.principal?.telefono_verificado ||
                (args.cliente_telefono ? String(args.cliente_telefono).trim() : null);

            // ── La dirección, obligatoria solo para el domicilio ─────────────────────────
            //
            // Se comprueba aquí y no en el validador porque es una regla entre DOS argumentos,
            // y `argumentos.js` mira uno cada vez. El error es tipado y habla el idioma del
            // cliente: quien lo va a leer es alguien pidiendo un almuerzo, no un programador.
            const esDomicilio = args.tipo_entrega === 'DOMICILIO';
            const direccion = args.direccion ? String(args.direccion).trim() : null;
            if (esDomicilio && !direccion) {
                const e = new Error('Para llevártelo necesito la dirección.');
                e.code = 'DIRECCION_REQUERIDA';
                e.statusCode = 400;
                throw e;
            }
            // Y un teléfono: sin él, el domiciliario no tiene a quién llamar en la puerta. El
            // canal casi siempre lo prueba; cuando no (BSUID), lo tiene que decir el cliente. Lo
            // impone la plataforma y no el modelo: con gpt-5.6-luna, 1 de cada ~12 domicilios se
            // pedía confirmar sin número (evaluación de 2026-10-04). El error vuelve al modelo,
            // que entonces lo pide.
            if (esDomicilio && !telefono) {
                const e = new Error('Para que el domiciliario te llame al llegar necesito un número de contacto.');
                e.code = 'TELEFONO_REQUERIDO';
                e.statusCode = 400;
                throw e;
            }
            // El teléfono que DICE el cliente no puede ser el del propio negocio. gpt-5.6-luna, a
            // falta de número, copió el del restaurante —que tiene delante en el prompt— como
            // `cliente_telefono` (evaluación de 2026-10-04): el domiciliario habría llamado al
            // local. Solo se mira el dicho; el probado por el canal no pasa por aquí.
            if (args.cliente_telefono && !contexto.principal?.telefono_verificado) {
                const soloDigitos = (v) => String(v || '').replace(/\D/g, '').replace(/^57/, '');
                const [delNegocio] = await Models.sequelize.query(
                    `SELECT telefono FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
                    { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT, transaction: contexto.transaction }
                );
                const dicho = soloDigitos(args.cliente_telefono);
                if (dicho && dicho === soloDigitos(delNegocio?.telefono)) {
                    const e = new Error(
                        'Ese es el teléfono del restaurante, no el del cliente. Pídele al cliente su número de contacto.'
                    );
                    e.code = 'TELEFONO_REQUERIDO';
                    e.statusCode = 400;
                    throw e;
                }
            }

            // ── La mesa, releída de la base ───────────────────────────────────────────────
            //
            // Un pedido «en el local» necesita mesa, y esa mesa tiene que ser de ESTE negocio y
            // estar activa: el id llega en un mensaje que el cliente pudo editar. Se comprueba
            // dentro de la misma transacción que crea la orden. Sin dirección ni teléfono
            // obligatorios: quien está sentado no los necesita.
            const esMesa = args.tipo_entrega === 'MESA';
            // «Para servir» (2026-10-02): MESA sin id_mesa. El cliente viene en camino; se le
            // guarda la primera mesa libre, como el negocio ya hacía a mano. Hasta hoy esto era
            // MESA_REQUERIDA y el bot se atascaba preguntando «¿en qué mesa están?».
            const paraServir = esMesa && !args.id_mesa;
            let mesa = null;
            if (paraServir) {
                mesa = await mesaPublicaService.mesaLibreParaServir({
                    idNegocio,
                    transaction: contexto.transaction,
                });
                if (!mesa) {
                    const e = new Error(
                        'Ahora mismo no tenemos mesas libres. Si quieres, te lo preparo para recoger.'
                    );
                    e.code = 'SIN_MESA_LIBRE';
                    e.statusCode = 409;
                    throw e;
                }
            } else if (esMesa) {
                mesa = await mesaPublicaService.resolverMesa({
                    idNegocio,
                    idMesa: args.id_mesa,
                    transaction: contexto.transaction,
                    bloquear: true,
                });
            }

            // ── El valor del domicilio: lo pone el SERVIDOR ───────────────────────────────
            //
            // Del barrio que dijo el cliente solo se toma el id. Si no es de este negocio o ya
            // no existe, `ZONA_INVALIDA`. Sin barrio («Otro barrio») el valor es 0 y el cajero
            // lo ajusta al confirmar con el cliente. Con `permite_pago_domicilio` apagado,
            // `valorDomicilioDe` devuelve 0 y `crearOrden` lo vuelve a aplicar.
            let valorDomicilio = 0;
            if (esDomicilio && args.id_barrio) {
                const r = await barrioService.valorDomicilioDe({
                    idNegocio,
                    idBarrio: args.id_barrio,
                    transaction: contexto.transaction,
                });
                valorDomicilio = r.valor;
            }

            // ── El domiciliario, al azar ──────────────────────────────────────────────────
            //
            // Un pedido a domicilio tomado por el bot no tiene a nadie del negocio decidiendo
            // quién lo lleva — a diferencia del POS, donde un humano lo asigna a mano o lo deja
            // para después. Sin esto, el pedido llegaba a Despacho sin domiciliario y alguien
            // tenía que asignarlo ahí, a mano, cada vez. El reparto es arbitrario a propósito
            // (ver `elegirDomiciliarioAlAzar`): repartir la carga de verdad es una decisión de
            // negocio que nadie ha tomado todavía.
            //
            // Si el negocio no tiene NINGÚN domiciliario registrado, se rechaza en vez de crear
            // un domicilio que nadie va a llevar — el mismo criterio que `SIN_PROFESIONAL` en
            // `reserva`.
            let idDomiciliario = null;
            if (esDomicilio) {
                idDomiciliario = await pedidoService.elegirDomiciliarioAlAzar(idNegocio, {
                    transaction: contexto.transaction,
                });
                if (!idDomiciliario) {
                    const e = new Error(
                        'No tengo domiciliarios disponibles ahora mismo. Llama al restaurante para tu domicilio.'
                    );
                    e.code = 'SIN_DOMICILIARIO_DISPONIBLE';
                    e.statusCode = 409;
                    throw e;
                }
            }

            // ── El método de pago ────────────────────────────────────────────────────────
            //
            // **No se valida aquí a propósito.** `pedidoService.validarMetodoPagoParaNegocio` ya
            // comprueba que sea de ESTE negocio y que esté activo, y lanza un error tipado. Una
            // segunda versión de esa comprobación es la que se queda vieja el día que la
            // vertical cambie la regla — el mismo argumento por el que el manejador de modelo
            // pasa por el Gate aunque espere que deniegue.
            //
            // Que tenga que ser de este negocio no es formalismo: un id de otro inquilino en esa
            // columna es la fuga que cerró F2.

            // ── Mesa con cuenta abierta: se SUMA a ella ────────────────────────────────────
            //
            // Mesas y cobro asumen una cuenta activa por mesa. Una orden nueva sobre una mesa
            // ocupada (el mesero atendiéndola, u otro comensal que pidió un minuto antes) quedaría
            // huérfana: ni se vería ni se cobraría desde Mesas. Se añade a la abierta por la misma
            // vía de servicio que usa el asistente para «agregar a mi pedido» —así también pasa por
            // el inventario, el recálculo del total y los avisos en vivo—. La mesa quedó bloqueada
            // arriba, así que dos pedidos simultáneos hacen fila.
            if (mesa && !paraServir) {
                const abierta = await mesaPublicaService.cuentaAbierta({
                    idNegocio,
                    idMesa: mesa.id_mesa,
                    transaction: contexto.transaction,
                });
                if (abierta) {
                    const actualizada = await pedidoService.agregarItemsPorCliente(abierta.id_orden, {
                        idNegocio,
                        items: itemsParaOrden.map((it) => ({
                            ...it,
                            // Lo que entra por el bot a una cuenta que no es suya queda marcado en
                            // CADA línea (la nota de la orden es del mesero y no se toca): en Mesas
                            // y en cocina se ve qué añadió WhatsApp y se puede quitar con las
                            // herramientas de siempre. La presencia del cliente no se verifica; el
                            // «sí» y esta visibilidad son la defensa.
                            //
                            // La nota especial del cliente («sin sal en todo») va en la MISMA marca:
                            // al crear una cuenta nueva se guarda en `pedid_orden.nota`, pero aquí esa
                            // nota es del mesero y no se toca, así que sin esto se perdía en silencio
                            // — el cliente la escribió, confirmó, y nadie en el negocio la veía.
                            nota: `WhatsApp: ${args.cliente_nombre}${args.nota ? ` — ${args.nota}` : ''}`.slice(0, 200),
                        })),
                        transaction: contexto.transaction,
                        permitirEnCocina: true,
                    });
                    return {
                        numero_orden: actualizada.numero_orden,
                        estado: actualizada.estado,
                        total: precio(actualizada.total),
                        items: args.items.length,
                        suma_a_cuenta: true,
                        mesa: mesa.nombre,
                    };
                }
            }

            const orden = await pedidoService.crearOrden(
                {
                    idNegocio,
                    idUsuario,
                    // Hace sonar la alerta del negocio: es un pedido que ninguna persona tomó.
                    deAsistente: true,
                    idMesa: mesa ? mesa.id_mesa : null,
                    tipoPedido: args.tipo_entrega,
                    valorDomicilio,
                    // En una mesa no hay «contacto»: se deja dicho quién pidió, para que la
                    // cocina no lea un pedido de mesa sin nombre.
                    // En «para servir» la nota lo dice también: así se ve en cualquier pantalla
                    // que pinte la nota, aunque todavía no pinte la marca de `para_servir`.
                    nota: esMesa
                        ? `${paraServir ? 'Para servir (viene en camino) — ' : ''}WhatsApp: ${args.cliente_nombre}${args.nota ? ` — ${args.nota}` : ''}`
                        : undefined,
                    paraServir,
                    contactoNombre: args.cliente_nombre,
                    contactoTelefono: telefono,
                    // Nula en un pedido para recoger: no hay a dónde llevarlo.
                    direccionDomicilio: esDomicilio ? direccion : null,
                    // Al azar, y solo para domicilio — ver el bloque de arriba.
                    idDomiciliario,
                    // La nota SÍ va en los dos casos, aunque la columna se llame «de
                    // domicilio»: es el campo que la pantalla de despacho pinta como «Nota»
                    // para cualquier tipo de pedido. Mandarla al `nota` de la orden sería más
                    // limpio de nombre y dejaría la nota del cliente sin que nadie la vea.
                    notaDomicilio: args.nota || null,
                    // Siempre nulo desde el 2026-08-27: el asistente dejó de preguntar cómo
                    // se paga (ver `docs/asistente-restaurante.md`). La caja lo pone al
                    // cobrar, que es donde el negocio sabe de verdad cómo pagó el cliente.
                    idMetodoPago: null,
                    // `precio_unitario` sale del producto que se acaba de releer, NUNCA de la
                    // conversación. Es la mitad que hace útil esa relectura: si el precio
                    // viniera del modelo, un pedido podría cobrarse a lo que el bot recordara
                    // de hace veinte turnos, y esa diferencia se descubre en la puerta del
                    // cliente con el domiciliario delante.
                    items: itemsParaOrden,
                },
                { transaction: contexto.transaction }
            );

            // El POS marca la mesa OCUPADA al tomar el pedido (desde la pantalla, con un PATCH).
            // Aquí no hay pantalla: se hace en la misma transacción, y solo si estaba DISPONIBLE
            // —una mesa en POR_COBRAR no se pisa—. Con `fecha_inicio_servicio` arranca el reloj.
            if (mesa) {
                await Models.RestMesa.update(
                    { estado_servicio: 'OCUPADA', fecha_inicio_servicio: new Date() },
                    {
                        where: { id_mesa: mesa.id_mesa, id_negocio: idNegocio, estado_servicio: 'DISPONIBLE' },
                        transaction: contexto.transaction,
                    }
                );
            }

            return {
                numero_orden: orden.numero_orden,
                estado: orden.estado,
                total: precio(orden.total),
                items: args.items.length,
                ...(paraServir ? { para_servir: true, mesa: mesa.nombre } : {}),
            };
        },
    });

    registry.registrar({
        nombre: 'cancelar_pedido',
        descripcion:
            'Cancela un pedido del cliente, por su número. Úsala cuando pida anularlo o diga ' +
            'que se equivocó. Solo funciona si la cocina todavía no lo ha empezado a preparar: ' +
            'si ya está en preparación o ya se cobró, se rechaza y hay que decirle que llame ' +
            'al restaurante. Al pedirla, el negocio le enseña al cliente una pregunta de ' +
            'confirmación y no se ejecuta hasta que diga sí: no le digas que ya está cancelado. ' +
            '⚠️ En Colombia «cancelar» casi siempre significa PAGAR: «cancelo por Nequi», ' +
            '«¿cuánto le cancelo?», «cancelo al domiciliario», «para cancelar en efectivo». Si ' +
            'menciona dinero, un valor o un medio de pago, NO es una anulación: contesta sobre el ' +
            'pago con consultar_info_negocio. Usa esta capacidad solo si pide ANULAR el pedido ' +
            '(«ya no lo quiero», «anúlalo», «me equivoqué»).',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        // Cancelar dos veces el mismo pedido no lo cancela dos veces: la segunda vez
        // `cancelarPorCliente` rechaza con ORDEN_YA_CANCELADA en vez de repetir el efecto.
        idempotente: true,
        confirmacion: {
            // Se nombran los PRODUCTOS y no solo el número de orden — pedido del dueño: un
            // número no le dice nada al cliente en el momento de decidir, lo que compra es lo
            // que pidió. Si por lo que sea no se puede leer el detalle (pedido raro, fallo de
            // consulta), se cae al número — degradar el detalle, nunca tumbar la confirmación
            // (ADR-010 no la negocia).
            pregunta: async ({ args, idNegocio }) => {
                const numero = String(args.numero_orden || '').trim();
                try {
                    const orden = await Models.PedidOrden.findOne({
                        where: { id_negocio: idNegocio, numero_orden: numero },
                        attributes: ['id_orden'],
                    });
                    if (!orden) throw new Error('pedido no encontrado');

                    const detalles = await Models.PedidDetalle.findAll({
                        where: { id_orden: orden.id_orden },
                        attributes: ['cantidad'],
                        include: [{ model: Models.CartaProducto, as: 'producto', attributes: ['nombre'] }],
                    });
                    const nombres = detalles
                        .filter((d) => d.producto?.nombre)
                        .map((d) => (Number(d.cantidad) > 1 ? `${d.cantidad} ${d.producto.nombre}` : d.producto.nombre));
                    if (nombres.length === 0) throw new Error('sin detalle que mostrar');

                    return `¿Estás seguro de cancelar tu pedido de: ${nombres.join(', ')}?`;
                } catch (error) {
                    console.warn(
                        `[cancelar_pedido] no se pudo detallar en la confirmación: ${error.message}`
                    );
                    return `¿Estás seguro de cancelar tu pedido ${numero}?`;
                }
            },
            hecho: () => 'Tu pedido fue cancelado.',
        },
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            numero_orden: { tipo: 'string', requerido: true, max_longitud: 40 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            // Misma búsqueda y misma comprobación de pertenencia que `consultar_estado_pedido`:
            // el número de orden es corto y adivinable, así que sin esto cualquiera podría
            // cancelar el pedido de otro. Se hace aquí, en el adaptador, porque es sobre
            // `telefono_verificado` del Principal — un concepto de canal que `pedidoService`
            // no tiene por qué conocer (ADR-009).
            const orden = await Models.PedidOrden.findOne({
                where: { id_negocio: idNegocio, numero_orden: String(args.numero_orden).trim() },
                attributes: ['id_orden', 'contacto_telefono'],
                transaction: contexto.transaction,
            });
            if (!orden) {
                const e = new Error('No encuentro ese pedido.');
                e.code = 'PEDIDO_NO_ENCONTRADO';
                e.statusCode = 404;
                throw e;
            }
            if (contexto.principal && contexto.principal.tipo === TIPO.CONTACTO) {
                const deQuienPide = normalizarE164Colombia(contexto.principal.telefono_verificado);
                const delPedido = normalizarE164Colombia(orden.contacto_telefono);
                if (!deQuienPide || !delPedido || deQuienPide !== delPedido) {
                    const e = new Error(
                        'No puedo comprobar que ese pedido sea tuyo. Llama al restaurante y te lo cancelan.'
                    );
                    e.code = 'PEDIDO_NO_ES_DE_QUIEN_PIDE';
                    e.statusCode = 403;
                    throw e;
                }
            }

            const cancelado = await pedidoService.cancelarPorCliente(orden.id_orden, {
                idNegocio,
                transaction: contexto.transaction,
            });

            return {
                numero_orden: cancelado.numero_orden,
                estado: cancelado.estado,
            };
        },
    });

    registry.registrar({
        nombre: 'agregar_items_pedido',
        descripcion:
            'Agrega productos a un pedido que el cliente YA PUSO, por su número. Úsala cuando ' +
            'diga "también quiero...", "se me olvidó..." o "añádele..." sobre un pedido que ya ' +
            'confirmó — nunca para el primer pedido, para eso está tomar_pedido. Solo funciona ' +
            'si la cocina todavía no lo ha empezado a preparar: si ya está en preparación o ya ' +
            'se cobró, se rechaza y hay que decirle que llame al restaurante. Al pedirla, el ' +
            'negocio le enseña al cliente una pregunta de confirmación y no se ejecuta hasta ' +
            'que diga sí: no le digas que ya está agregado.',
        vertical: VERTICAL,
        tipo: registry.TIPO.MUTACION,
        // Igual que `tomar_pedido`: no es idempotente. Dos llamadas agregan dos veces, porque
        // no hay nada que la segunda encuentre ya gastado.
        idempotente: false,
        confirmacion: {
            pregunta: async ({ args, idNegocio }) => {
                const items = Array.isArray(comoLista(args.items)) ? comoLista(args.items) : [];
                const cabecera = `¿Agrego esto a tu pedido ${args.numero_orden}?`;

                // Mismo criterio que en `tomar_pedido`: se relee del catálogo y cualquier fallo
                // degrada el detalle, nunca tumba la confirmación (ADR-010 no la negocia).
                try {
                    const ids = items
                        .map((i) => Number(i?.id_producto))
                        .filter((n) => Number.isInteger(n) && n > 0);
                    if (ids.length === 0) throw new Error('sin ids utilizables');

                    const productos = await Models.CartaProducto.findAll({
                        where: { id_negocio: idNegocio, id_producto: ids },
                        attributes: ['id_producto', 'nombre', 'precio'],
                    });
                    const porId = new Map(productos.map((p) => [p.id_producto, p]));

                    let total = 0;
                    const lineas = items.map((i) => {
                        const p = porId.get(Number(i?.id_producto));
                        const cantidad = Number(i?.cantidad) || 1;
                        if (!p) throw new Error('un producto ya no está en la carta');
                        const subtotal = Number(p.precio) * cantidad;
                        total += subtotal;
                        return `• ${cantidad} × ${p.nombre} — ${enPesos(subtotal)}`;
                    });

                    // El empaque depende de cómo se entrega ESE pedido, que está en la orden.
                    const ord = await Models.PedidOrden.findOne({
                        where: { id_negocio: idNegocio, numero_orden: String(args.numero_orden).trim() },
                        attributes: ['tipo_pedido'],
                    });
                    const empaques = await empaqueService.calcular({
                        idNegocio,
                        tipoPedido: ord?.tipo_pedido,
                        items,
                    });
                    const lineasEmpaque = empaques.map((e) => {
                        total += e.precio_unitario * e.cantidad;
                        return `• Empaque ${e.nombre} × ${e.cantidad} — ${enPesos(e.precio_unitario * e.cantidad)}`;
                    });

                    return [
                        cabecera,
                        '',
                        ...lineas,
                        ...lineasEmpaque,
                        '',
                        `*Se suma: ${enPesos(total)}*`,
                    ].join('\n');
                } catch (error) {
                    console.warn(
                        `[agregar_items_pedido] no se pudo detallar en la confirmación: ${error.message}`
                    );
                    return cabecera;
                }
            },
            hecho: ({ resultado }) =>
                `¡Listo! Se lo agregué a tu pedido ${resultado.numero_orden}. ` +
                `Nuevo total: ${enPesos(resultado.total)}.`,
        },
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            numero_orden: { tipo: 'string', requerido: true, max_longitud: 40 },
            items: {
                tipo: 'lista',
                requerido: true,
                min_items: 1,
                max_items: 20,
                elemento: {
                    id_producto: { tipo: 'entero', requerido: true, min: 1 },
                    cantidad: { tipo: 'entero', requerido: true, min: 1, max: 50 },
                },
            },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            // Misma búsqueda y misma comprobación de pertenencia que `cancelar_pedido` y
            // `consultar_estado_pedido`: el número de orden es corto y adivinable.
            const orden = await Models.PedidOrden.findOne({
                where: { id_negocio: idNegocio, numero_orden: String(args.numero_orden).trim() },
                attributes: ['id_orden', 'contacto_telefono', 'tipo_pedido'],
                transaction: contexto.transaction,
            });
            if (!orden) {
                const e = new Error('No encuentro ese pedido.');
                e.code = 'PEDIDO_NO_ENCONTRADO';
                e.statusCode = 404;
                throw e;
            }
            if (contexto.principal && contexto.principal.tipo === TIPO.CONTACTO) {
                const deQuienPide = normalizarE164Colombia(contexto.principal.telefono_verificado);
                const delPedido = normalizarE164Colombia(orden.contacto_telefono);
                if (!deQuienPide || !delPedido || deQuienPide !== delPedido) {
                    const e = new Error(
                        'No puedo comprobar que ese pedido sea tuyo. Llama al restaurante.'
                    );
                    e.code = 'PEDIDO_NO_ES_DE_QUIEN_PIDE';
                    e.statusCode = 403;
                    throw e;
                }
            }

            // Los productos, releídos del dominio — misma razón que en `tomar_pedido`: no se
            // confía en un precio que la conversación pueda recordar mal.
            const idsPedidos = args.items.map((i) => Number(i.id_producto));
            const productos = await Models.CartaProducto.findAll({
                where: {
                    id_negocio: idNegocio,
                    id_producto: idsPedidos,
                    estado: 'A',
                    disponible: true,
                    visible: true,
                },
                attributes: ['id_producto', 'nombre', 'precio'],
                transaction: contexto.transaction,
            });
            const porId = new Map(productos.map((pr) => [pr.id_producto, pr]));
            const faltantes = idsPedidos.filter((id) => !porId.has(id));
            if (faltantes.length > 0) {
                const e = new Error(
                    'Alguno de esos productos ya no está disponible. Vuelve a consultar la carta ' +
                        'antes de prometer nada.'
                );
                e.code = 'PRODUCTO_NO_DISPONIBLE';
                e.statusCode = 409;
                throw e;
            }

            const itemsNuevos = args.items.map((i) => ({
                id_producto: Number(i.id_producto),
                cantidad: Number(i.cantidad) || 1,
                precio_unitario: Number(porId.get(Number(i.id_producto)).precio),
            }));
            const empaquesNuevos = await empaqueService.calcular({
                idNegocio,
                tipoPedido: orden.tipo_pedido,
                items: itemsNuevos,
                transaction: contexto.transaction,
            });
            itemsNuevos.push(
                ...empaquesNuevos.map((e) => ({
                    id_producto: e.id_producto,
                    cantidad: e.cantidad,
                    precio_unitario: e.precio_unitario,
                }))
            );

            const actualizada = await pedidoService.agregarItemsPorCliente(orden.id_orden, {
                idNegocio,
                items: itemsNuevos,
                transaction: contexto.transaction,
            });

            return {
                numero_orden: actualizada.numero_orden,
                total: precio(actualizada.total),
                items_agregados: args.items.length,
            };
        },
    });
}

/**
 * El flujo determinista de esta vertical y los tipos de negocio que atiende.
 *
 * Vive en el adaptador porque un flujo conversacional sabe que existen categorías y productos,
 * y eso es conocimiento de dominio: el motor no debe tenerlo (ADR-009).
 */
const flujo = require('./flujo');

function registrarFlujo({ flujos }) {
    flujos.registrar({
        vertical: VERTICAL,
        tipos: flujo.TIPOS_NEGOCIO,
        manejar: flujo.manejarRestaurante,
        // «Este mensaje es mío»: el pedido armado en el menú digital. Sin esto la política de
        // enrutado lo mandaba al modelo por el comodín y el flujo no lo veía nunca — que es lo
        // que rompió el pedido del 2026-08-26. Ver `engine/flujos.js`.
        reclama: flujo.reclama,
        // Fuera de servicio el turno no sube al modelo: lo contesta el flujo (Zona Burger,
        // 2026-10-02: el modelo ofreció domicilio con el local cerrado).
        atiendeSinModelo: async ({ conversacion }) => Boolean(await flujo.fueraDeServicio(conversacion)),
    });
}

module.exports = { VERTICAL, registrarCapacidades, registrarFlujo, estadoParaElCliente, tiempoDelPedido, mismaPalabra, afinarResultado };
