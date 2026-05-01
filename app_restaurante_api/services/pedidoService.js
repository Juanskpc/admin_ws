const Models = require('../../app_core/models/conection');
const cajaService = require('./cajaService');
const { Op } = require('sequelize');

const SUBNIVEL_CANCELAR_NO_PAGADO = 'despacho_cancelar_no_pagado';
const SUBNIVEL_VER_TODOS = 'despacho_ver_todos';

/**
 * pedidoService — Lógica de negocio para órdenes / pedidos del restaurante.
 *
 * Reglas de caja (ver cajaService):
 *  - crearOrden, agregarItemsOrden y cerrarOrden requieren caja abierta.
 *  - cerrarOrden registra automáticamente un movimiento INGRESO en la caja
 *    activa y persiste id_caja en la orden.
 */

function buildStockInsuficienteError(faltantes) {
    const error = new Error('No hay stock suficiente para uno o más ingredientes.');
    error.code = 'STOCK_INSUFICIENTE';
    error.statusCode = 409;
    error.faltantes = faltantes;
    return error;
}

function normalizePermissionCode(rawCode = '') {
    return String(rawCode)
        .trim()
        .toLowerCase()
        .replace(/^\/+/, '')
        .replace(/\//g, '_');
}

function isAdminRoleName(nombreRol = '') {
    return String(nombreRol).toUpperCase().includes('ADMINISTRADOR');
}

async function usuarioPuedeCancelarPedidoNoPagado({ idUsuario, idNegocio }) {
    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
            [Op.or]: [{ id_negocio: idNegocio }, { id_negocio: null }],
        },
        attributes: ['id_rol'],
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            required: true,
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    if (!rolesUsuario.length) return false;

    const roles = rolesUsuario
        .map((r) => ({
            id_rol: Number(r.id_rol),
            descripcion: String(r.rol?.descripcion || ''),
        }))
        .filter((r) => Number.isInteger(r.id_rol));

    if (!roles.length) return false;
    if (roles.some((r) => isAdminRoleName(r.descripcion))) return true;

    const roleIds = [...new Set(roles.map((r) => r.id_rol))];
    const whereNivelCodigo = normalizePermissionCode(SUBNIVEL_CANCELAR_NO_PAGADO);

    const permisoNegocio = await Models.GenerNivelNegocio.findOne({
        where: {
            id_negocio: idNegocio,
            id_rol: roleIds,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_nivel_negocio'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                url: whereNivelCodigo,
            },
            attributes: ['id_nivel'],
        }],
    });
    if (permisoNegocio) return true;

    const permisoGlobal = await Models.GenerRolNivel.findOne({
        where: {
            id_rol: roleIds,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_rol_nivel'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                url: whereNivelCodigo,
            },
            attributes: ['id_nivel'],
        }],
    });

    return Boolean(permisoGlobal);
}

async function usuarioPuedeVerTodosDespacho({ idUsuario, idNegocio }) {
    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
            [Op.or]: [{ id_negocio: idNegocio }, { id_negocio: null }],
        },
        attributes: ['id_rol'],
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            required: true,
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    if (!rolesUsuario.length) return false;

    const roles = rolesUsuario
        .map((r) => ({
            id_rol: Number(r.id_rol),
            descripcion: String(r.rol?.descripcion || ''),
        }))
        .filter((r) => Number.isInteger(r.id_rol));

    if (!roles.length) return false;
    if (roles.some((r) => isAdminRoleName(r.descripcion))) return true;

    const roleIds = [...new Set(roles.map((r) => r.id_rol))];
    const whereNivelCodigo = normalizePermissionCode(SUBNIVEL_VER_TODOS);

    const permisoNegocio = await Models.GenerNivelNegocio.findOne({
        where: {
            id_negocio: idNegocio,
            id_rol: roleIds,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_nivel_negocio'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                url: whereNivelCodigo,
            },
            attributes: ['id_nivel'],
        }],
    });
    if (permisoNegocio) return true;

    const permisoGlobal = await Models.GenerRolNivel.findOne({
        where: {
            id_rol: roleIds,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_rol_nivel'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                url: whereNivelCodigo,
            },
            attributes: ['id_nivel'],
        }],
    });

    return Boolean(permisoGlobal);
}

/**
 * Genera el siguiente número de orden para un negocio.
 */
async function generarNumeroOrden(idNegocio) {
    const [result] = await Models.sequelize.query(`
        SELECT COALESCE(MAX(CAST(SUBSTRING(numero_orden FROM 5) AS INTEGER)), 0) + 1 AS siguiente
        FROM restaurante.pedid_orden
        WHERE id_negocio = :idNegocio
    `, {
        replacements: { idNegocio },
        type: Models.sequelize.QueryTypes.SELECT,
    });
    const num = String(result.siguiente).padStart(4, '0');
    return `ORD-${num}`;
}

async function consumirIngredientesPorItems({ idNegocio, items, permitirStockNegativo = false, transaction }) {
    const ingredientesNecesarios = new Map();

    for (const item of items) {
        const receta = await Models.CartaProductoIngred.findAll({
            where: {
                id_producto: item.id_producto,
                estado: 'A',
            },
            attributes: ['id_ingrediente', 'porcion'],
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                where: { id_negocio: idNegocio, estado: 'A' },
                required: true,
                attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
            }],
            transaction,
        });

        const excluidas = new Set(item.exclusiones || []);
        receta.forEach((recetaIng) => {
            if (excluidas.has(recetaIng.id_ingrediente)) return;

            const porcion = Number(recetaIng.porcion || 0);
            if (porcion <= 0) return;

            const consumo = porcion * Number(item.cantidad || 1);
            const entry = ingredientesNecesarios.get(recetaIng.id_ingrediente);

            if (entry) {
                entry.consumo += consumo;
            } else {
                ingredientesNecesarios.set(recetaIng.id_ingrediente, {
                    id_ingrediente: recetaIng.id_ingrediente,
                    nombre: recetaIng.ingrediente?.nombre || 'Ingrediente',
                    consumo,
                });
            }
        });
    }

    if (ingredientesNecesarios.size === 0) return;

    const idsIngredientes = Array.from(ingredientesNecesarios.keys());
    const ingredientesStock = await Models.CartaIngrediente.findAll({
        where: {
            id_negocio: idNegocio,
            id_ingrediente: idsIngredientes,
            estado: 'A',
        },
        attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
        transaction,
        lock: transaction.LOCK.UPDATE,
    });

    const stockMap = new Map(ingredientesStock.map((i) => [
        i.id_ingrediente,
        Number(i.stock_actual ?? 0),
    ]));

    const faltantes = [];
    for (const reqIng of ingredientesNecesarios.values()) {
        const stock = stockMap.get(reqIng.id_ingrediente);
        if (stock === undefined) {
            throw new Error(`Ingrediente no encontrado en inventario: ${reqIng.nombre}`);
        }
        if (stock < reqIng.consumo) {
            faltantes.push({
                id_ingrediente: reqIng.id_ingrediente,
                nombre: reqIng.nombre,
                stock_actual: stock,
                requerido: reqIng.consumo,
                faltante: reqIng.consumo - stock,
            });
        }
    }

    if (faltantes.length > 0 && !permitirStockNegativo) {
        throw buildStockInsuficienteError(faltantes);
    }

    for (const ing of ingredientesStock) {
        const consumo = ingredientesNecesarios.get(ing.id_ingrediente)?.consumo || 0;
        if (consumo <= 0) continue;

        const nuevoStock = Number(ing.stock_actual ?? 0) - consumo;
        await ing.update({ stock_actual: nuevoStock }, { transaction });
    }
}

async function crearDetallesOrden({ idOrden, items, transaction }) {
    for (const item of items) {
        const detalle = await Models.PedidDetalle.create({
            id_orden: idOrden,
            id_producto: item.id_producto,
            cantidad: item.cantidad,
            precio_unitario: item.precio_unitario,
            subtotal: item.precio_unitario * item.cantidad,
            nota: item.nota || null,
            estado: 'PENDIENTE',
        }, { transaction });

        if (item.exclusiones && item.exclusiones.length > 0) {
            const exclusiones = item.exclusiones.map(idIng => ({
                id_detalle: detalle.id_detalle,
                id_ingrediente: idIng,
            }));
            await Models.PedidDetalleExclu.bulkCreate(exclusiones, { transaction });
        }
    }
}

async function validarMetodoPagoParaNegocio({ idMetodoPago, idNegocio, transaction }) {
    if (!idMetodoPago) return null;

    const mp = await Models.RestMetodoPago.findOne({
        where: { id_metodo_pago: idMetodoPago, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!mp) {
        const e = new Error('Método de pago inválido para este negocio.');
        e.statusCode = 422;
        e.code = 'METODO_PAGO_INVALIDO';
        throw e;
    }
    return mp;
}

async function recalcularTotalesOrden({ idOrden, porcentajeImpuesto = 0, transaction }) {
    const subtotalRaw = await Models.PedidDetalle.sum('subtotal', {
        where: { id_orden: idOrden },
        transaction,
    });
    const subtotal = Number(subtotalRaw ?? 0);
    const impuesto = Math.round(subtotal * porcentajeImpuesto * 100) / 100;
    const total = subtotal + impuesto;

    await Models.PedidOrden.update(
        { subtotal, impuesto, total },
        { where: { id_orden: idOrden }, transaction }
    );
}

/**
 * Crea una orden completa con sus detalles y exclusiones.
 *
 * @param {Object} params
 * @param {number} params.idNegocio
 * @param {number} params.idUsuario
 * @param {number|null} params.idMesa
 * @param {string} [params.nota]
 * @param {Array}  params.items — [{ id_producto, cantidad, precio_unitario, nota, exclusiones: [id_ingrediente] }]
 * @param {number} params.porcentajeImpuesto — ej: 0.19
 */
async function crearOrden({
    idNegocio, idMetodoPago = null, idUsuario, idMesa, nota, items, porcentajeImpuesto = 0, permitirStockNegativo = false,
    tipoPedido = 'MESA', contactoNombre = null, contactoTelefono = null,
    direccionDomicilio = null, notaDomicilio = null, idDomiciliario = null,
}) {
    const t = await Models.sequelize.transaction();
    try {
        await cajaService.requireCajaAbierta(idNegocio, { transaction: t });

        const numeroOrden = await generarNumeroOrden(idNegocio);

        await consumirIngredientesPorItems({
            idNegocio,
            items,
            permitirStockNegativo,
            transaction: t,
        });

        await validarMetodoPagoParaNegocio({
            idMetodoPago,
            idNegocio,
            transaction: t,
        });

        // Calcular totales
        let subtotal = 0;
        items.forEach(item => {
            subtotal += item.precio_unitario * item.cantidad;
        });
        const impuesto = Math.round(subtotal * porcentajeImpuesto * 100) / 100;
        const total = subtotal + impuesto;

        // 1. Crear la orden
        const orden = await Models.PedidOrden.create({
            id_negocio: idNegocio,
            id_usuario: idUsuario,
            numero_orden: numeroOrden,
            id_mesa: tipoPedido === 'MESA' ? (idMesa || null) : null,
            nota,
            subtotal,
            impuesto,
            total,
            estado: 'ABIERTA',
            id_metodo_pago: idMetodoPago || null,
            tipo_pedido: tipoPedido,
            contacto_nombre:     tipoPedido === 'DOMICILIO' ? contactoNombre     : null,
            contacto_telefono:   tipoPedido === 'DOMICILIO' ? contactoTelefono   : null,
            direccion_domicilio: tipoPedido === 'DOMICILIO' ? direccionDomicilio : null,
            nota_domicilio:      tipoPedido === 'DOMICILIO' ? notaDomicilio      : null,
            id_domiciliario:     tipoPedido === 'DOMICILIO' ? (idDomiciliario || null) : null,
        }, { transaction: t });

        await crearDetallesOrden({
            idOrden: orden.id_orden,
            items,
            transaction: t,
        });

        await t.commit();

        // Retornar orden con detalles
        return getOrdenById(orden.id_orden);
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/**
 * Agrega items a una orden ABIERTA existente (flujo de ajuste POS por mesa).
 */
async function agregarItemsOrden({
    idOrden,
    idNegocio,
    idMetodoPago = null,
    nota,
    items,
    porcentajeImpuesto = 0,
    permitirStockNegativo = false,
}) {
    const t = await Models.sequelize.transaction();
    try {
        await cajaService.requireCajaAbierta(idNegocio, { transaction: t });

        const orden = await Models.PedidOrden.findOne({
            where: {
                id_orden: idOrden,
                id_negocio: idNegocio,
                estado: 'ABIERTA',
            },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!orden) {
            throw new Error('ORDEN_NO_ENCONTRADA');
        }

        await validarMetodoPagoParaNegocio({
            idMetodoPago,
            idNegocio,
            transaction: t,
        });

        await consumirIngredientesPorItems({
            idNegocio,
            items,
            permitirStockNegativo,
            transaction: t,
        });

        await crearDetallesOrden({
            idOrden,
            items,
            transaction: t,
        });

        const patchOrden = {};
        if (typeof nota === 'string') {
            patchOrden.nota = nota.trim() || null;
        }
        if (idMetodoPago) {
            patchOrden.id_metodo_pago = idMetodoPago;
        }
        if (Object.keys(patchOrden).length > 0) {
            await orden.update(patchOrden, { transaction: t });
        }

        await recalcularTotalesOrden({
            idOrden,
            porcentajeImpuesto,
            transaction: t,
        });

        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/**
 * Obtiene una orden por su ID, con detalles, exclusiones, producto e ingrediente.
 */
async function getOrdenById(idOrden) {
    return Models.PedidOrden.findByPk(idOrden, {
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono', 'precio'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }, {
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }, {
            model: Models.RestMesa,
            as: 'mesaRef',
            attributes: ['id_mesa', 'nombre', 'numero'],
            required: false,
        }, {
            model: Models.RestMetodoPago,
            as: 'metodoPago',
            attributes: ['id_metodo_pago', 'nombre'],
            required: false,
        }, {
            model: Models.GenerUsuario,
            as: 'domiciliario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
            required: false,
        }],
    });
}

/**
 * Lista pedidos LLEVAR/DOMICILIO para el módulo Despacho.
 * Si verTodos=false, filtra por id_domiciliario = idUsuario.
 */
async function getOrdenesDespacho({ idNegocio, idUsuario }) {
    const { Op } = Models.Sequelize;
    const verTodos = await usuarioPuedeVerTodosDespacho({ idUsuario, idNegocio });
    const where = {
        id_negocio: idNegocio,
        tipo_pedido: { [Op.in]: ['LLEVAR', 'DOMICILIO'] },
        estado: 'ABIERTA',
    };
    if (!verTodos) where.id_domiciliario = idUsuario;

    return Models.PedidOrden.findAll({
        where,
        include: [
            { model: Models.GenerUsuario, as: 'usuario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'] },
            { model: Models.GenerUsuario, as: 'domiciliario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'], required: false },
                        { model: Models.PedidDetalle, as: 'detalles',
                            attributes: ['id_detalle', 'cantidad', 'precio_unitario', 'nota'],
                            include: [{ model: Models.CartaProducto, as: 'producto', attributes: ['id_producto', 'nombre'] }] },
        ],
        order: [['fecha_creacion', 'DESC']],
    });
}

/**
 * Lista usuarios con rol DOMICILIARIO en el negocio. Útil para asignación.
 */
async function listarDomiciliarios(idNegocio) {
    const rolDom = await Models.GenerRol.findOne({ where: { descripcion: 'DOMICILIARIO', id_tipo_negocio: 1 } });
    if (!rolDom) return [];
    const links = await Models.GenerUsuarioRol.findAll({
        where: { id_negocio: idNegocio, id_rol: rolDom.id_rol, estado: 'A' },
        include: [{
            model: Models.GenerUsuario, as: 'usuario',
            where: { estado: 'A' },
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido', 'num_identificacion', 'telefono'],
        }],
    });
    return links.map(l => ({
        id_usuario: l.usuario.id_usuario,
        nombre: `${l.usuario.primer_nombre} ${l.usuario.primer_apellido}`.trim(),
        num_identificacion: l.usuario.num_identificacion,
        telefono: l.usuario.telefono,
    }));
}

/**
 * Lista órdenes abiertas de un negocio.
 */
async function getOrdenesAbiertas(idNegocio) {
    return Models.PedidOrden.findAll({
        where: { id_negocio: idNegocio, estado: 'ABIERTA' },
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [{
                model: Models.CartaProducto,
                as: 'producto',
                attributes: ['id_producto', 'nombre', 'icono'],
            }],
        }],
        order: [['fecha_creacion', 'DESC']],
    });
}

/**
 * Envía una orden a cocina (cambia estado_cocina → PENDIENTE y detalles → EN_COCINA).
 */
async function enviarACocina(idOrden) {
    await Models.PedidDetalle.update(
        { estado: 'EN_COCINA' },
        { where: { id_orden: idOrden, estado: 'PENDIENTE' } }
    );
    await Models.PedidOrden.update(
        { estado_cocina: 'PENDIENTE' },
        { where: { id_orden: idOrden } }
    );
    return getOrdenById(idOrden);
}

/**
 * Cambia el estado del KDS para una orden (flujo kanban).
 * PENDIENTE → EN_PREPARACION → LISTO → ENTREGADO.
 * Al pasar a LISTO, los detalles EN_COCINA se marcan LISTO.
 */
async function cambiarEstadoCocina(idOrden, nuevoEstado) {
    const updateOrden = { estado_cocina: nuevoEstado };
    await Models.PedidOrden.update(updateOrden, { where: { id_orden: idOrden } });
    if (nuevoEstado === 'LISTO') {
        await Models.PedidDetalle.update(
            { estado: 'LISTO' },
            { where: { id_orden: idOrden, estado: 'EN_COCINA' } }
        );
    } else if (nuevoEstado === 'EN_PREPARACION') {
        // Si se deshace desde LISTO → EN_PREPARACION, revertir detalles LISTO → EN_COCINA
        await Models.PedidDetalle.update(
            { estado: 'EN_COCINA' },
            { where: { id_orden: idOrden, estado: 'LISTO' } }
        );
    }
    return getOrdenById(idOrden);
}

/**
 * Lista órdenes activas en el KDS (estado_cocina IN [PENDIENTE, EN_PREPARACION, LISTO]).
 */
async function getOrdenesCocina(idNegocio) {
    const { Op } = Models.Sequelize;
    return Models.PedidOrden.findAll({
        where: {
            id_negocio: idNegocio,
            estado_cocina: { [Op.in]: ['PENDIENTE', 'EN_PREPARACION', 'LISTO'] },
        },
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }, {
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }, {
            model: Models.RestMesa,
            as: 'mesaRef',
            attributes: ['id_mesa', 'nombre', 'numero'],
            required: false,
        }],
        order: [['fecha_creacion', 'ASC']],
    });
}

/**
 * Marca un detalle como LISTO (lo elimina de la vista de cocina).
 */
async function marcarDetalleCompleto(idDetalle) {
    const detalle = await Models.PedidDetalle.findByPk(idDetalle);
    if (!detalle) return null;
    await detalle.update({ estado: 'LISTO' });
    return detalle;
}

/**
 * Registra el cobro de una orden sin cerrarla.
 * Usado en el flujo de despacho: el pedido queda ABIERTO pero marcado como pagado.
 * Registra inmediatamente el INGRESO en la caja activa del negocio.
 */
async function marcarPagado(idOrden, { idMetodoPago, origenCobro = 'CAJA' } = {}) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findByPk(idOrden, {
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            await t.rollback();
            return null;
        }

        if (!idMetodoPago) {
            const e = new Error('La forma de pago es obligatoria para registrar el cobro.');
            e.code = 'METODO_PAGO_REQUERIDO';
            e.statusCode = 422;
            throw e;
        }

        const mp = await Models.RestMetodoPago.findOne({
            where: { id_metodo_pago: idMetodoPago, id_negocio: orden.id_negocio, estado: 'A' },
            transaction: t,
        });
        if (!mp) {
            const e = new Error('Método de pago inválido para este negocio.');
            e.code = 'METODO_PAGO_INVALIDO';
            e.statusCode = 422;
            throw e;
        }

        const registraEnCaja = origenCobro !== 'DOMICILIARIO';
        const caja = registraEnCaja
            ? await cajaService.registrarIngresoOrden({
                idNegocio:   orden.id_negocio,
                idOrden:     orden.id_orden,
                idUsuario:   orden.id_usuario,
                monto:       orden.total,
                numeroOrden: orden.numero_orden,
                transaction: t,
            })
            : null;

        await orden.update({
            estado_pago:    'pagado',
            id_metodo_pago: idMetodoPago,
            id_caja:        caja ? caja.id_caja : null,
        }, { transaction: t });

        await t.commit();
        return orden;
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Cancela una orden (solo si NO ha sido pagada).
 * Se usa desde el módulo de Despacho para eliminar pedidos pendientes de pago.
 * No registra nada en caja. El stock consumido NO se restaura automáticamente
 * (la orden sigue existiendo para auditoría, simplemente marcada CANCELADA).
 */
async function cancelarOrden(idOrden, { idUsuario } = {}) {
    const orden = await Models.PedidOrden.findByPk(idOrden);
    if (!orden) return null;

    const puedeCancelar = await usuarioPuedeCancelarPedidoNoPagado({
        idUsuario,
        idNegocio: orden.id_negocio,
    });
    if (!puedeCancelar) {
        const e = new Error('No tienes permiso para eliminar pedidos pendientes de pago.');
        e.code = 'SIN_PERMISO_CANCELAR_NO_PAGADO';
        e.statusCode = 403;
        throw e;
    }

    if (orden.estado_pago === 'pagado') {
        const e = new Error('No se puede cancelar un pedido ya pagado.');
        e.code = 'ORDEN_PAGADA'; e.statusCode = 409;
        throw e;
    }
    if (orden.estado === 'CERRADA') {
        const e = new Error('No se puede cancelar una orden cerrada.');
        e.code = 'ORDEN_CERRADA'; e.statusCode = 409;
        throw e;
    }
    await orden.update({ estado: 'CANCELADA', fecha_cierre: new Date() });
    return orden;
}

/**
 * Cierra (cobra) una orden.
 *
 * Atómico dentro de una transacción:
 *  1. Verifica caja abierta del negocio.
 *  2. Registra movimiento INGRESO por el total de la orden.
 *  3. Marca la orden CERRADA y persiste id_caja para auditoría.
 *
 * @param {number} idOrden
 * @param {{ idUsuario: number }} ctx — usuario que ejecuta el cobro
 */
async function cerrarOrden(idOrden, { idUsuario, idMetodoPago } = {}) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            await t.rollback();
            return null;
        }
        if (orden.estado === 'CERRADA') {
            await t.commit();
            return getOrdenById(idOrden);
        }

        const metodoPagoFinal = idMetodoPago || orden.id_metodo_pago || null;
        if (!metodoPagoFinal) {
            const e = new Error('La forma de pago es obligatoria para cerrar la orden.');
            e.statusCode = 422; e.code = 'METODO_PAGO_REQUERIDO';
            throw e;
        }

        // Validar que el método de pago final pertenezca al negocio.
        if (metodoPagoFinal) {
            const mp = await Models.RestMetodoPago.findOne({
                where: { id_metodo_pago: metodoPagoFinal, id_negocio: orden.id_negocio, estado: 'A' },
                transaction: t,
            });
            if (!mp) {
                const e = new Error('Método de pago inválido para este negocio.');
                e.statusCode = 422; e.code = 'METODO_PAGO_INVALIDO';
                throw e;
            }
        }

        // Si marcarPagado ya registró el ingreso en caja, reusar ese id_caja
        let idCaja = orden.id_caja || null;
        if (!idCaja) {
            const caja = await cajaService.registrarIngresoOrden({
                idNegocio:   orden.id_negocio,
                idOrden:     orden.id_orden,
                idUsuario:   idUsuario || orden.id_usuario,
                monto:       orden.total,
                numeroOrden: orden.numero_orden,
                transaction: t,
            });
            idCaja = caja.id_caja;
        }

        await orden.update(
            {
                estado: 'CERRADA',
                fecha_cierre: new Date(),
                id_caja: idCaja,
                id_metodo_pago: metodoPagoFinal,
            },
            { transaction: t },
        );

        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        if (!t.finished) {
            await t.rollback();
        }
        throw err;
    }
}

module.exports = {
    crearOrden,
    agregarItemsOrden,
    getOrdenById,
    getOrdenesAbiertas,
    getOrdenesCocina,
    getOrdenesDespacho,
    listarDomiciliarios,
    enviarACocina,
    cambiarEstadoCocina,
    marcarDetalleCompleto,
    marcarPagado,
    cancelarOrden,
    cerrarOrden,
    usuarioPuedeVerTodosDespacho,
};
