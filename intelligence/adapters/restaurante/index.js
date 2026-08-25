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
const { TIPO } = require('../../../app_core/authz/principal');
const { normalizarE164Colombia } = require('../../../app_core/helpers/telefono');

const cartaService = require('../../../app_restaurante_api/services/cartaService');
const pedidoService = require('../../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../../app_restaurante_api/services/cajaService');
const usuarioAsistenteDao = require('../../../app_core/dao/usuarioAsistenteDao');
const Models = require('../../../app_core/models/conection');

const VERTICAL = 'restaurante';

/** Cuántos productos se devuelven como mucho. Una lista de WhatsApp son 10 filas. */
const MAX_PRODUCTOS = 10;

function precio(valor) {
    return valor != null ? Number(valor) : null;
}

function registrarCapacidades() {
    registry.registrar({
        nombre: 'consultar_carta',
        descripcion:
            'Lista las categorías de la carta del restaurante y, si le pasas una categoría, ' +
            'los productos de esa categoría con su precio. Úsala cuando el cliente pregunte ' +
            'qué venden, qué hay de comer, o pida ver el menú. Sin categoría devuelve solo las ' +
            'categorías, que es lo que hay que enseñar primero: la carta entera no cabe en un ' +
            'mensaje y abruma. El id_categoria es el que devuelve esta misma capacidad sin ' +
            'argumentos: NO son 1, 2, 3 — usa el número exacto o te dirá que no existe.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            id_categoria: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args, contexto }) {
            // Se usan las variantes PÚBLICAS (`...Publicas`, `...PublicosByCategoria`) y no las
            // de administración: filtran por `visible` además de por `disponible`, que es
            // justo la diferencia entre lo que el negocio gestiona y lo que le enseña a un
            // cliente. Un producto oculto a propósito no debe salir por el bot.
            if (!args.id_categoria) {
                const categorias = await cartaService.getCategoriasPublicas(idNegocio);
                return {
                    categorias: categorias.map((c) => ({
                        id_categoria: c.id_categoria,
                        nombre: c.nombre,
                        descripcion: c.descripcion || null,
                        cuantos_productos: (c.productos || []).length,
                    })),
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
                productos: productos.slice(0, MAX_PRODUCTOS).map((p) => ({
                    id_producto: p.id_producto,
                    nombre: p.nombre,
                    descripcion: p.descripcion || null,
                    precio: precio(p.precio),
                    es_popular: Boolean(p.es_popular),
                })),
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
            const productos = await cartaService.buscarProductos(idNegocio, args.termino);
            return {
                termino: args.termino,
                productos: productos.slice(0, MAX_PRODUCTOS).map((p) => ({
                    id_producto: p.id_producto,
                    nombre: p.nombre,
                    descripcion: p.descripcion || null,
                    precio: precio(p.precio),
                })),
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
        nombre: 'tomar_pedido',
        descripcion:
            'Crea un pedido a domicilio con los productos que el cliente eligió. Úsala solo ' +
            'cuando tengas los id_producto (de consultar_carta o buscar_producto), las ' +
            'cantidades, el nombre y la dirección. Devuelve el número de pedido, que hace falta ' +
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
            pregunta: ({ args }) =>
                `¿Confirmo tu pedido a nombre de ${args.cliente_nombre} para ${args.direccion}?`,
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

            // El teléfono lo impone la plataforma, no el modelo: es el que probó el canal. Misma
            // regla que en `reservar_turno`, y por el mismo motivo — de él cuelga que después
            // solo el dueño pueda consultar su pedido.
            const telefono = contexto.principal?.telefono_verificado || null;

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
    });
}

module.exports = { VERTICAL, registrarCapacidades, registrarFlujo };
