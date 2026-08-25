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
            'mensaje y abruma.',
        vertical: VERTICAL,
        tipo: registry.TIPO.CONSULTA,
        feature: FEATURE.ASISTENTE_IA,
        parametros: {
            id_categoria: { tipo: 'entero', requerido: false, min: 1 },
        },

        async ejecutar({ idNegocio, args }) {
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
}

module.exports = { VERTICAL, registrarCapacidades };
