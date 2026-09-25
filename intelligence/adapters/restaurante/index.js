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
const cajaService = require('../../../app_restaurante_api/services/cajaService');
const cuentaService = require('../../../app_restaurante_api/services/cuentaService');
const horarioService = require('../../../app_restaurante_api/services/horarioService');
const barrioService = require('../../../app_restaurante_api/services/barrioService');
const exclusiones = require('./exclusiones');
const mesaPublicaService = require('../../../app_restaurante_api/services/mesaPublicaService');
const usuarioAsistenteDao = require('../../../app_core/dao/usuarioAsistenteDao');
const Models = require('../../../app_core/models/conection');
const { enPesos, enlaceDelMenu } = require('./flujo');

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
    const directa = await cartaService.buscarProductos(idNegocio, termino);
    if (directa.length > 0) return directa;

    const palabras = normalizarTexto(termino)
        .split(/\s+/)
        .filter((w) => w.length >= 3);
    // Con una sola palabra la segunda pasada sería idéntica a la primera.
    if (palabras.length < 2) return directa;

    const ancla = palabras.slice().sort((a, b) => b.length - a.length)[0];
    const candidatos = await cartaService.buscarProductos(idNegocio, ancla);

    return candidatos.filter((c) => {
        const donde = normalizarTexto(`${c.nombre} ${c.descripcion || ''}`);
        return palabras.every((w) => donde.includes(w));
    });
}

function producto(p) {
    return {
        id_producto: p.id_producto,
        nombre: p.nombre,
        descripcion: p.descripcion || null,
        precio: precio(p.precio),
        es_popular: Boolean(p.es_popular),
    };
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
                const carta = await cartaService.getCartaPublica(idNegocio);

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
                args.id_categoria
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
            'no inventes productos ni precios: lo único que existe es lo que devuelve esto.',
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
            const productos = (await buscarEnLaCarta(idNegocio, args.termino)).filter(
                (p) => p.visible !== false
            );
            return {
                termino: args.termino,
                productos: productos.slice(0, MAX_PRODUCTOS).map(producto),
            };
        },
    });

    registry.registrar({
        nombre: 'consultar_estado_pedido',
        descripcion:
            'Dice en qué va un pedido a domicilio, por su número. Úsala cuando el cliente ' +
            'pregunte si ya salió, cuánto falta o dónde está su pedido. Necesitas el número ' +
            'de orden; si no lo tiene, pídeselo.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            numero_orden: { tipo: 'string', requerido: true, max_longitud: 40 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            const orden = await Models.PedidOrden.findOne({
                where: { id_negocio: idNegocio, numero_orden: String(args.numero_orden).trim() },
                attributes: [
                    'id_orden', 'numero_orden', 'estado', 'estado_cocina', 'estado_pago',
                    'tipo_pedido', 'contacto_telefono', 'total', 'fecha_creacion',
                ],
                transaction: contexto.transaction,
            });

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

            return {
                numero_orden: orden.numero_orden,
                estado: orden.estado,
                estado_cocina: orden.estado_cocina || null,
                estado_pago: orden.estado_pago || null,
                tipo_pedido: orden.tipo_pedido,
                total: precio(orden.total),
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

                const donde = enMesa
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
                const aviso =
                    recoge || enMesa || domicilio
                        ? '_El total es aproximado: puede variar por el empaque._'
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

                    return [
                        cabecera,
                        '',
                        ...lineas,
                        ...lineaDomicilio,
                        ...avisoQuitar,
                        '',
                        `*Total: ${enPesos(total)}*`,
                        aviso,
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
            hecho: ({ resultado }) =>
                resultado.suma_a_cuenta
                    ? `¡Listo! Lo sumé a la cuenta de tu mesa (${resultado.mesa}).`
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
                    'recogerlo por el local, MESA si está sentado en el local (exige id_mesa). ' +
                    'Pregúntaselo antes: no lo supongas.',
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
                const e = new Error(
                    'Ahora mismo estamos fuera de nuestro horario de atención. Te atendemos ' +
                        'apenas sea posible. Si quieres, puedes ir mirando la carta mientras tanto.'
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

            // ── La mesa, releída de la base ───────────────────────────────────────────────
            //
            // Un pedido «en el local» necesita mesa, y esa mesa tiene que ser de ESTE negocio y
            // estar activa: el id llega en un mensaje que el cliente pudo editar. Se comprueba
            // dentro de la misma transacción que crea la orden. Sin dirección ni teléfono
            // obligatorios: quien está sentado no los necesita.
            const esMesa = args.tipo_entrega === 'MESA';
            let mesa = null;
            if (esMesa) {
                if (!args.id_mesa) {
                    const e = new Error('Necesito saber en qué mesa estás.');
                    e.code = 'MESA_REQUERIDA';
                    e.statusCode = 400;
                    throw e;
                }
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
            if (mesa) {
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
                            nota: `WhatsApp: ${args.cliente_nombre}`.slice(0, 200),
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
                    idMesa: mesa ? mesa.id_mesa : null,
                    tipoPedido: args.tipo_entrega,
                    valorDomicilio,
                    // En una mesa no hay «contacto»: se deja dicho quién pidió, para que la
                    // cocina no lea un pedido de mesa sin nombre.
                    nota: esMesa
                        ? `WhatsApp: ${args.cliente_nombre}${args.nota ? ` — ${args.nota}` : ''}`
                        : undefined,
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
            'confirmación y no se ejecuta hasta que diga sí: no le digas que ya está cancelado.',
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

                    return [cabecera, '', ...lineas, '', `*Se suma: ${enPesos(total)}*`].join('\n');
                } catch (error) {
                    console.warn(
                        `[agregar_items_pedido] no se pudo detallar en la confirmación: ${error.message}`
                    );
                    return cabecera;
                }
            },
            hecho: ({ resultado }) =>
                `¡Listo! Se lo agregué a tu pedido ${resultado.numero_orden}. ` +
                `Nuevo total: ${enPesos(resultado.total)} (el precio puede variar por empaques y domicilio).`,
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

            const actualizada = await pedidoService.agregarItemsPorCliente(orden.id_orden, {
                idNegocio,
                items: args.items.map((i) => ({
                    id_producto: Number(i.id_producto),
                    cantidad: Number(i.cantidad) || 1,
                    precio_unitario: Number(porId.get(Number(i.id_producto)).precio),
                })),
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
    });
}

module.exports = { VERTICAL, registrarCapacidades, registrarFlujo };
