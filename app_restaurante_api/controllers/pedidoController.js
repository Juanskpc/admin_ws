const { body, query } = require('express-validator');
const PedidoService = require('../services/pedidoService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { validationResult } = require('express-validator');

/**
 * pedidoController — Endpoints para el sistema de pedidos (POS).
 */

/** POST /restaurante/pedidos */
const crearOrdenValidators = [
    body('id_negocio').isInt({ min: 1 }).withMessage('id_negocio inválido'),
    body('id_mesa').optional({ nullable: true }).isInt({ min: 1 }).withMessage('id_mesa inválido'),
    body('nota').optional({ nullable: true }).isString(),
    body('permitir_stock_negativo').optional().isBoolean().withMessage('permitir_stock_negativo debe ser booleano'),
    body('items').isArray({ min: 1 }).withMessage('Debe haber al menos un item'),
    body('items.*.id_producto').isInt({ min: 1 }).withMessage('id_producto inválido'),
    body('items.*.cantidad').isInt({ min: 1 }).withMessage('Cantidad mínima: 1'),
    body('items.*.precio_unitario').isFloat({ min: 0 }).withMessage('Precio inválido'),
    body('items.*.exclusiones').optional().isArray(),
    body('porcentaje_impuesto').optional().isFloat({ min: 0, max: 1 }),
    body('tipo_pedido').optional().isIn(['MESA', 'LLEVAR', 'DOMICILIO']),
    body('contacto_nombre').optional({ nullable: true }).isString().isLength({ max: 160 }),
    body('contacto_telefono').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('direccion_domicilio').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('nota_domicilio').optional({ nullable: true }).isString(),
    body('id_domiciliario').optional({ nullable: true }).isInt({ min: 1 }),
];

const agregarItemsOrdenValidators = [
    body('id_negocio').isInt({ min: 1 }).withMessage('id_negocio inválido'),
    body('nota').optional({ nullable: true }).isString(),
    body('permitir_stock_negativo').optional().isBoolean().withMessage('permitir_stock_negativo debe ser booleano'),
    body('items').isArray({ min: 1 }).withMessage('Debe haber al menos un item'),
    body('items.*.id_producto').isInt({ min: 1 }).withMessage('id_producto inválido'),
    body('items.*.cantidad').isInt({ min: 1 }).withMessage('Cantidad mínima: 1'),
    body('items.*.precio_unitario').isFloat({ min: 0 }).withMessage('Precio inválido'),
    body('items.*.exclusiones').optional().isArray(),
    body('porcentaje_impuesto').optional().isFloat({ min: 0, max: 1 }),
];

const marcarPagadoValidators = [
    body('id_metodo_pago').isInt({ min: 1 }).withMessage('id_metodo_pago requerido'),
];

const cerrarOrdenValidators = [
    body('id_metodo_pago').optional({ nullable: true }).isInt({ min: 1 }).withMessage('id_metodo_pago inválido'),
];

async function crearOrden(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 422, errors.array());
    }

    try {
        const {
            id_negocio, id_mesa, nota, items, porcentaje_impuesto, permitir_stock_negativo,
            tipo_pedido, contacto_nombre, contacto_telefono, direccion_domicilio, nota_domicilio, id_domiciliario,
        } = req.body;
        const orden = await PedidoService.crearOrden({
            idNegocio:  id_negocio,
            idUsuario:  req.usuario.id_usuario,
            idMesa:     id_mesa || null,
            nota,
            items,
            porcentajeImpuesto: porcentaje_impuesto || 0,
            permitirStockNegativo: Boolean(permitir_stock_negativo),
            tipoPedido: tipo_pedido || 'MESA',
            contactoNombre:    contacto_nombre || null,
            contactoTelefono:  contacto_telefono || null,
            direccionDomicilio: direccion_domicilio || null,
            notaDomicilio:     nota_domicilio || null,
            idDomiciliario:    id_domiciliario ? Number(id_domiciliario) : null,
        });
        return Respuesta.success(res, 'Orden creada', orden, 201);
    } catch (err) {
        if (err.code === 'CAJA_CERRADA') {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        if (err.code === 'STOCK_INSUFICIENTE') {
            return Respuesta.error(res, err.message, err.statusCode || 409, {
                code: err.code,
                faltantes: err.faltantes || [],
            });
        }
        console.error('[Pedidos] Error crearOrden:', err.message);
        return Respuesta.error(res, 'Error al crear la orden.');
    }
}

/** PATCH /restaurante/pedidos/:id/agregar-items */
async function agregarItemsOrden(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos inválidos', 422, errors.array());
    }

    try {
        const idOrden = Number(req.params.id);
        const { id_negocio, nota, items, porcentaje_impuesto, permitir_stock_negativo } = req.body;

        const orden = await PedidoService.agregarItemsOrden({
            idOrden,
            idNegocio: id_negocio,
            nota,
            items,
            porcentajeImpuesto: porcentaje_impuesto || 0,
            permitirStockNegativo: Boolean(permitir_stock_negativo),
        });

        return Respuesta.success(res, 'Items agregados a la orden', orden);
    } catch (err) {
        if (err.code === 'CAJA_CERRADA') {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        if (err.message === 'ORDEN_NO_ENCONTRADA') {
            return Respuesta.error(res, 'Orden no encontrada o no está abierta', 404);
        }
        if (err.code === 'STOCK_INSUFICIENTE') {
            return Respuesta.error(res, err.message, err.statusCode || 409, {
                code: err.code,
                faltantes: err.faltantes || [],
            });
        }

        console.error('[Pedidos] Error agregarItemsOrden:', err.message);
        return Respuesta.error(res, 'Error al agregar items a la orden.');
    }
}

/** GET /restaurante/pedidos/abiertas?id_negocio=N */
async function getOrdenesAbiertas(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const ordenes = await PedidoService.getOrdenesAbiertas(idNegocio);
        return Respuesta.success(res, 'Órdenes abiertas', ordenes);
    } catch (err) {
        console.error('[Pedidos] Error getOrdenesAbiertas:', err.message);
        return Respuesta.error(res, 'Error al obtener las órdenes.');
    }
}

/** GET /restaurante/pedidos/:id */
async function getOrdenById(req, res) {
    try {
        const orden = await PedidoService.getOrdenById(Number(req.params.id));
        if (!orden) return Respuesta.error(res, 'Orden no encontrada', 404);
        return Respuesta.success(res, 'Orden obtenida', orden);
    } catch (err) {
        console.error('[Pedidos] Error getOrdenById:', err.message);
        return Respuesta.error(res, 'Error al obtener la orden.');
    }
}

/** PATCH /restaurante/pedidos/:id/enviar-cocina */
async function enviarACocina(req, res) {
    try {
        const orden = await PedidoService.enviarACocina(Number(req.params.id));
        if (!orden) return Respuesta.error(res, 'Orden no encontrada', 404);
        return Respuesta.success(res, 'Orden enviada a cocina', orden);
    } catch (err) {
        console.error('[Pedidos] Error enviarACocina:', err.message);
        return Respuesta.error(res, 'Error al enviar a cocina.');
    }
}

/** GET /cocina?id_negocio=N */
async function getOrdenesCocina(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const ordenes = await PedidoService.getOrdenesCocina(idNegocio);
        return Respuesta.success(res, 'Órdenes en cocina', ordenes);
    } catch (err) {
        console.error('[Cocina] Error getOrdenesCocina:', err.message);
        return Respuesta.error(res, 'Error al obtener las órdenes de cocina.');
    }
}

/** PATCH /restaurante/pedidos/detalle/:id/completar */
async function marcarDetalleCompleto(req, res) {
    try {
        const detalle = await PedidoService.marcarDetalleCompleto(Number(req.params.id));
        if (!detalle) return Respuesta.error(res, 'Detalle no encontrado', 404);
        return Respuesta.success(res, 'Detalle marcado como listo', detalle);
    } catch (err) {
        console.error('[Cocina] Error marcarDetalleCompleto:', err.message);
        return Respuesta.error(res, 'Error al actualizar el detalle.');
    }
}

/** PATCH /restaurante/pedidos/:id/estado-cocina */
async function cambiarEstadoCocina(req, res) {
    const ESTADOS_VALIDOS = ['PENDIENTE', 'EN_PREPARACION', 'LISTO', 'ENTREGADO'];
    try {
        const { estado } = req.body;
        if (!ESTADOS_VALIDOS.includes(estado)) {
            return Respuesta.error(res, 'Estado de cocina inválido', 422);
        }
        const orden = await PedidoService.cambiarEstadoCocina(Number(req.params.id), estado);
        if (!orden) return Respuesta.error(res, 'Orden no encontrada', 404);
        return Respuesta.success(res, `Estado cocina: ${estado}`, orden);
    } catch (err) {
        console.error('[Cocina] Error cambiarEstadoCocina:', err.message);
        return Respuesta.error(res, 'Error al cambiar estado en cocina.');
    }
}

/** PATCH /restaurante/pedidos/:id/marcar-pagado */
async function marcarPagado(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos inválidos', 422, errors.array());
        }

        const orden = await PedidoService.marcarPagado(Number(req.params.id), {
            idMetodoPago: Number(req.body.id_metodo_pago),
        });
        if (!orden) return Respuesta.error(res, 'Orden no encontrada', 404);
        return Respuesta.success(res, 'Pago registrado', orden);
    } catch (err) {
        if (err.code === 'METODO_PAGO_REQUERIDO' || err.code === 'METODO_PAGO_INVALIDO') {
            return Respuesta.error(res, err.message, err.statusCode || 422, { code: err.code });
        }
        console.error('[Despacho] Error marcarPagado:', err.message);
        return Respuesta.error(res, 'Error al registrar el pago.');
    }
}

/** PATCH /restaurante/pedidos/:id/cancelar */
async function cancelarOrden(req, res) {
    try {
        const orden = await PedidoService.cancelarOrden(Number(req.params.id), {
            idUsuario: req.usuario?.id_usuario,
        });
        if (!orden) return Respuesta.error(res, 'Orden no encontrada', 404);
        return Respuesta.success(res, 'Orden cancelada', orden);
    } catch (err) {
        if (err.code === 'ORDEN_PAGADA' || err.code === 'ORDEN_CERRADA' || err.code === 'SIN_PERMISO_CANCELAR_NO_PAGADO') {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        console.error('[Despacho] Error cancelarOrden:', err.message);
        return Respuesta.error(res, 'Error al cancelar la orden.');
    }
}

/** PATCH /restaurante/pedidos/:id/cerrar */
async function cerrarOrden(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos inválidos', 422, errors.array());
        }

        const orden = await PedidoService.cerrarOrden(Number(req.params.id), {
            idUsuario: req.usuario?.id_usuario,
            idMetodoPago: req.body?.id_metodo_pago ? Number(req.body.id_metodo_pago) : null,
        });
        if (!orden) return Respuesta.error(res, 'Orden no encontrada', 404);
        return Respuesta.success(res, 'Orden cerrada', orden);
    } catch (err) {
        if (err.code === 'CAJA_CERRADA' || err.code === 'METODO_PAGO_INVALIDO' || err.code === 'METODO_PAGO_REQUERIDO') {
            return Respuesta.error(res, err.message, err.statusCode || 409, { code: err.code });
        }
        console.error('[Pedidos] Error cerrarOrden:', err.message);
        return Respuesta.error(res, 'Error al cerrar la orden.');
    }
}

/** GET /restaurante/despacho?id_negocio=N */
async function getOrdenesDespacho(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        // El frontend pasa ver_todos=true cuando el rol tiene ese subnivel.
        const verTodos = req.query.ver_todos === 'true';
        const ordenes = await PedidoService.getOrdenesDespacho({
            idNegocio,
            idUsuario: req.usuario.id_usuario,
            verTodos,
        });
        return Respuesta.success(res, 'Pedidos para despacho', ordenes);
    } catch (err) {
        console.error('[Despacho] Error getOrdenesDespacho:', err.message);
        return Respuesta.error(res, 'Error al obtener pedidos de despacho.');
    }
}

/** GET /restaurante/domiciliarios?id_negocio=N */
async function getDomiciliarios(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const list = await PedidoService.listarDomiciliarios(idNegocio);
        return Respuesta.success(res, 'Domiciliarios obtenidos', list);
    } catch (err) {
        console.error('[Despacho] Error getDomiciliarios:', err.message);
        return Respuesta.error(res, 'Error al obtener domiciliarios.');
    }
}

module.exports = {
    crearOrden, crearOrdenValidators,
    agregarItemsOrden, agregarItemsOrdenValidators,
    marcarPagadoValidators,
    cerrarOrdenValidators,
    getOrdenesAbiertas,
    getOrdenById,
    getOrdenesCocina,
    getOrdenesDespacho,
    getDomiciliarios,
    enviarACocina,
    cambiarEstadoCocina,
    marcarDetalleCompleto,
    marcarPagado,
    cancelarOrden,
    cerrarOrden,
};