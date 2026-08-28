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
const metodoPagoService = require('../../../app_restaurante_api/services/metodoPagoService');
const usuarioAsistenteDao = require('../../../app_core/dao/usuarioAsistenteDao');
const Models = require('../../../app_core/models/conection');

const VERTICAL = 'restaurante';

/** Cuántos productos se devuelven como mucho. Una lista de WhatsApp son 10 filas. */
const MAX_PRODUCTOS = 10;

/**
 * Cuántos productos caben en la carta entera, sumando todas las categorías.
 *
 * No es un límite de WhatsApp —el bot no vuelca esto tal cual, lo lee y contesta— sino del
 * prompt: la carta viaja **después** del corte de caché, así que cada producto se paga entero en
 * cada vuelta del turno. Treinta es el orden de magnitud de una carta de barrio completa; una
 * carta más grande se recorta y el modelo lo sabe (`hay_mas`), con `buscar_producto` para lo que
 * falte.
 */
const MAX_CARTA = 30;

function precio(valor) {
    return valor != null ? Number(valor) : null;
}

/** La forma en que un producto llega al modelo. Un solo sitio para que las tres salidas coincidan. */
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
            'Devuelve los productos de la carta con su precio, agrupados por categoría. Úsala ' +
            'cuando el cliente pregunte qué venden, qué hay de comer, o pida ver el menú. ' +
            'Sin argumentos devuelve la carta entera: eso es lo normal, porque lo que el ' +
            'cliente quiere saber es QUÉ HAY y CUÁNTO VALE. **Nunca le preguntes de qué ' +
            'categoría quiere ver**: las categorías son la forma en que el restaurante ordena ' +
            'su carta, no una pregunta que se le hace a nadie. Pásale id_categoria solo si el ' +
            'propio cliente nombró una parte de la carta ("¿qué bebidas tienen?"), y usa ' +
            'entonces el id exacto que devolvió esta misma capacidad: NO son 1, 2, 3.',
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

            // ⚠️ Sin categoría se devuelve la CARTA, no el índice.
            //
            // Antes esto devolvía solo la lista de categorías, y el bot hacía lo que la forma
            // del dato le pedía: contestar «tenemos Entradas, Platos y Bebidas, ¿cuál quieres
            // ver?». Un cliente no escribe a un restaurante para navegar un índice; escribe
            // para saber qué hay y cuánto vale. Cada pregunta intermedia es un turno más, y en
            // un chat cada turno es una oportunidad de que se vaya.
            //
            // De paso desaparece la ronda que causó el fallo del 2026-08-24: si el modelo nunca
            // tiene que elegir una categoría, tampoco puede inventarse su id.
            if (!args.id_categoria) {
                const carta = await cartaService.getCartaPublica(idNegocio);

                let quedan = MAX_CARTA;
                const grupos = [];
                for (const c of carta) {
                    const productos = (c.productos || []).slice(0, Math.max(quedan, 0));
                    if (productos.length === 0) continue;
                    quedan -= productos.length;
                    grupos.push({
                        id_categoria: c.id_categoria,
                        categoria: c.nombre,
                        productos: productos.map(producto),
                    });
                }

                const total = carta.reduce((n, c) => n + (c.productos || []).length, 0);
                return {
                    carta: grupos,
                    // `hay_mas` no es cosmética: sin él, una carta recortada le enseña al modelo
                    // a decir «esto es todo lo que tenemos», que es mentira.
                    hay_mas: total > MAX_CARTA,
                    cuantos_productos: total,
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
            'Busca productos de la carta por nombre. Úsala cuando el cliente pregunte por algo ' +
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
            const productos = (await cartaService.buscarProductos(idNegocio, args.termino)).filter(
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

    /**
     * Cómo se paga en este negocio — la que faltaba, y se notó en producción.
     *
     * El 2026-08-27 el modelo tomó un pedido entero sin preguntar cómo se pagaba. No fue un
     * despiste suyo: **no tenía cómo saberlo**. `id_metodo_pago` es opcional, no había ninguna
     * herramienta que listara los métodos, y nada le decía que preguntara. El flujo determinista
     * sí lo preguntaba —lee `rest_metodo_pago` directamente— así que el pedido salía bien por el
     * carrito del menú y mal por el chat. Dos caminos, dos comportamientos, un solo cliente.
     *
     * Devuelve también `datos_pago`: el Nequi o la cuenta a la que hay que transferir. Es lo que
     * permite que el modelo lo diga junto a la opción, igual que hace la FSM.
     */
    registry.registrar({
        nombre: 'consultar_metodos_pago',
        vertical: VERTICAL,
        descripcion:
            'Devuelve las formas de pago que acepta este restaurante, con los datos de cada una ' +
            '(a qué cuenta se transfiere, por ejemplo). Úsala ANTES de tomar un pedido a ' +
            'domicilio para preguntarle al cliente cómo va a pagar, y pásale a `tomar_pedido` el ' +
            '`id_metodo_pago` que elija. Si devuelve la lista vacía, el negocio no tiene formas ' +
            'de pago configuradas: no preguntes nada y toma el pedido sin ese dato.',
        tipo: registry.TIPO.CONSULTA,
        idempotente: true,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {},
        async ejecutar({ idNegocio }) {
            const metodos = await metodoPagoService.listar(idNegocio);
            return {
                metodos: metodos.map((m) => ({
                    id_metodo_pago: m.id_metodo_pago,
                    nombre: m.nombre,
                    datos_pago: m.datos_pago || null,
                })),
            };
        },
    });

    registry.registrar({
        nombre: 'tomar_pedido',
        descripcion:
            'Crea un pedido a domicilio con los productos que el cliente eligió. Úsala solo ' +
            'cuando tengas los id_producto (de consultar_carta o buscar_producto), las ' +
            'cantidades, el nombre, la dirección y cómo va a pagar. **Antes de usar esta, llama a ' +
            'consultar_metodos_pago y pregúntale al cliente cómo paga**, salvo que devuelva la ' +
            'lista vacía. Devuelve el número de pedido, que hace falta ' +
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
            pregunta: ({ args }) => {
                // `comoLista` porque esto corre sobre los argumentos CRUDOS: el modelo manda
                // `items` serializado de vez en cuando, y aquí todavía no ha pasado por el
                // validador. Ver `core/argumentos.js#comoLista`.
                const items = comoLista(args.items);
                const unidades = (Array.isArray(items) ? items : []).reduce(
                    (n, i) => n + Number(i?.cantidad || 0),
                    0
                );
                return (
                    `¿Confirmo tu pedido de ${unidades} ${unidades === 1 ? 'producto' : 'productos'} ` +
                    `a nombre de ${args.cliente_nombre}, para ${args.direccion}?`
                );
            },
            hecho: ({ resultado }) =>
                `¡Listo! Tu pedido quedó tomado. El número es ${resultado.numero_orden} — ` +
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
                },
            },
            cliente_nombre: { tipo: 'string', requerido: true, min_longitud: 2, max_longitud: 150 },
            direccion: { tipo: 'string', requerido: true, min_longitud: 5, max_longitud: 300 },
            // ⚠️ Un teléfono de CONTACTO, no una identidad.
            //
            // Solo se usa cuando el canal no probó ninguno — desde el cambio de identidad de
            // WhatsApp (BSUID) hay clientes que llegan sin número, y un domicilio sin un número
            // al que llamar es un domicilio que se pierde en la puerta. Lo que **nunca** hace es
            // autorizar: quien dice un número no prueba nada, y la pertenencia de un pedido se
            // sigue comprobando contra `principal.telefono_verificado`.
            cliente_telefono: { tipo: 'string', requerido: false, min_longitud: 7, max_longitud: 40 },
            // El del negocio, de `restaurante.rest_metodo_pago`. Opcional porque un negocio
            // puede no tener ninguno configurado, y quedarse sin poder pedir por eso sería
            // peor que tomar el pedido sin saber cómo paga.
            id_metodo_pago: { tipo: 'entero', requerido: false, min: 1 },
            nota: { tipo: 'string', requerido: false, max_longitud: 500 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
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
            try {
                await cajaService.requireCajaAbierta(idNegocio, { transaction: contexto.transaction });
            } catch (_) {
                const e = new Error('El restaurante está cerrado ahora mismo y no puedo tomar pedidos.');
                e.code = 'RESTAURANTE_CERRADO';
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

            const orden = await pedidoService.crearOrden(
                {
                    idNegocio,
                    idUsuario,
                    idMesa: null,
                    tipoPedido: 'DOMICILIO',
                    contactoNombre: args.cliente_nombre,
                    contactoTelefono: telefono,
                    direccionDomicilio: args.direccion,
                    notaDomicilio: args.nota || null,
                    idMetodoPago: args.id_metodo_pago || null,
                    // `precio_unitario` sale del producto que se acaba de releer, NUNCA de la
                    // conversación. Es la mitad que hace útil esa relectura: si el precio
                    // viniera del modelo, un pedido podría cobrarse a lo que el bot recordara
                    // de hace veinte turnos, y esa diferencia se descubre en la puerta del
                    // cliente con el domiciliario delante.
                    items: args.items.map((i) => ({
                        id_producto: Number(i.id_producto),
                        cantidad: Number(i.cantidad) || 1,
                        precio_unitario: Number(porId.get(Number(i.id_producto)).precio),
                    })),
                },
                { transaction: contexto.transaction }
            );

            return {
                numero_orden: orden.numero_orden,
                estado: orden.estado,
                total: precio(orden.total),
                items: args.items.length,
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
