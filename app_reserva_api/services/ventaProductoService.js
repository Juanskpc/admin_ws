'use strict';
const Models = require('../../app_core/models/conection');
const CajaService = require('./cajaService');
const MetodoPagoService = require('./metodoPagoService');
const { normalizarPagos } = require('./cobroService');

/**
 * Venta de productos: de mostrador (con o sin cita) o del portal público (siempre sin cita, para
 * recoger). Ver `docs/productos-en-reserva.md`.
 *
 * ## Por qué es su propia entidad y no una línea más de la cita
 *
 * Una cita es un servicio con hora; un producto no la necesita — «véndeme el shampoo» no agenda
 * nada. Colgar el producto de `reserva_cita_servicio` habría obligado a esa tabla a modelar algo
 * que no tiene ni horario ni profesional obligatorio, y a que cada consulta de la agenda supiera
 * ignorar líneas que no son citas. `id_cita` es nullable en `reserva_venta_producto`: se puede
 * **relacionar** con una cita (para verla en su detalle) sin que la venta dependa de que exista.
 *
 * ## Dos pasos, una sola llamada cuando conviene
 *
 * `crear` deja la venta en PENDIENTE (nada de dinero se ha movido); `cobrar` es la que asienta
 * caja y descuenta stock. Un pedido del portal usa los dos por separado — el cliente crea, el
 * negocio cobra cuando pasa a recoger —. El mostrador los encadena en una transacción con
 * `venderYCobrar`, para que «vender» sea un solo clic y una sola llamada de red.
 *
 * ## El precio lo relee el servidor, siempre
 *
 * Los `items` que llegan solo traen `id_producto` y `cantidad`. El precio se lee del catálogo en
 * el momento de crear la venta y se congela en `precio_snapshot`: un precio que viniera en la
 * petición sería confiar en el cliente para decidir cuánto cobrarle.
 *
 * ## Stock: se descuenta, no bloquea
 *
 * Con `controla_stock` activo, cobrar resta la cantidad vendida. No se rechaza la venta si el
 * stock no alcanza —bloquear una venta real por un conteo que nadie ha actualizado es peor que
 * dejarlo en negativo—; la pantalla de Productos avisa cuando un producto queda en números
 * rojos, igual que Inventario en restaurante.
 */

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

/**
 * Valida `items` contra el catálogo del negocio y devuelve las líneas con precio congelado y el
 * total. Nunca confía en un precio que venga en la petición.
 */
async function construirLineas(idNegocio, items, { transaction } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
        throw error('La venta necesita al menos un producto.', 422);
    }
    const cantidades = new Map();
    for (const it of items) {
        const idProducto = Number(it.id_producto);
        const cantidad = Number(it.cantidad ?? 1);
        if (!Number.isInteger(idProducto) || idProducto <= 0) throw error('Producto inválido.', 422);
        if (!Number.isFinite(cantidad) || cantidad <= 0) throw error('La cantidad debe ser mayor que cero.', 422);
        cantidades.set(idProducto, (cantidades.get(idProducto) || 0) + cantidad);
    }

    const ids = [...cantidades.keys()];
    const productos = await Models.ReservaProducto.findAll({
        where: { id_producto: ids, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (productos.length !== ids.length) {
        throw error('Alguno de los productos no existe o no está disponible.', 400, 'PRODUCTO_INVALIDO');
    }

    let total = 0;
    const lineas = productos.map((p) => {
        const cantidad = cantidades.get(p.id_producto);
        const precio = Number(p.precio);
        const subtotal = Math.round(precio * cantidad * 100) / 100;
        total += subtotal;
        return {
            id_producto: p.id_producto,
            nombre_snapshot: p.nombre,
            precio_snapshot: precio,
            cantidad,
            subtotal,
            controla_stock: p.controla_stock,
        };
    });
    return { lineas, total: Math.round(total * 100) / 100 };
}

/**
 * Crea la venta en PENDIENTE. No mueve caja ni stock: eso lo hace `cobrar`.
 */
async function crear({
    idNegocio, items, idCita = null, idPersonaNegocio = null, idProfesional = null,
    idUsuario = null, canal = 'MOSTRADOR', entrega = 'MOSTRADOR',
    clienteNombre = null, clienteTelefono = null, notas = null,
}) {
    if (!['MOSTRADOR', 'PORTAL'].includes(canal)) throw error('Canal inválido.', 422);
    if (!['MOSTRADOR', 'RECOGER'].includes(entrega)) throw error('Forma de entrega inválida.', 422);

    return Models.sequelize.transaction(async (t) => {
        if (idCita != null) {
            const cita = await Models.ReservaCita.findOne({
                where: { id_cita: idCita, id_negocio: idNegocio }, transaction: t,
            });
            if (!cita) throw error('La cita no pertenece a este negocio.', 400);
        }

        const { lineas, total } = await construirLineas(idNegocio, items, { transaction: t });

        const venta = await Models.ReservaVentaProducto.create({
            id_negocio: idNegocio,
            id_cita: idCita,
            id_persona_negocio: idPersonaNegocio,
            id_profesional: idProfesional,
            id_usuario: idUsuario,
            canal,
            entrega,
            estado: 'PENDIENTE',
            total,
            cliente_nombre: clienteNombre ? String(clienteNombre).trim().slice(0, 150) : null,
            cliente_telefono: clienteTelefono ? String(clienteTelefono).trim().slice(0, 30) : null,
            notas: notas ? String(notas).trim().slice(0, 1000) : null,
        }, { transaction: t });

        await Models.ReservaVentaProductoDetalle.bulkCreate(
            lineas.map((l) => ({ id_venta: venta.id_venta, ...l })),
            { transaction: t },
        );

        return venta;
    });
}

/** La venta con su detalle, comprobando que sea del negocio. */
async function getById(idVenta, idNegocio) {
    return Models.ReservaVentaProducto.findOne({
        where: { id_venta: idVenta, id_negocio: idNegocio },
        include: [{ model: Models.ReservaVentaProductoDetalle, as: 'detalle' }],
    });
}

async function listar(idNegocio, { estado, canal } = {}) {
    const where = { id_negocio: idNegocio };
    if (estado) where.estado = estado;
    if (canal) where.canal = canal;
    return Models.ReservaVentaProducto.findAll({
        where,
        include: [{ model: Models.ReservaVentaProductoDetalle, as: 'detalle' }],
        order: [['fecha_creacion', 'DESC']],
    });
}

/**
 * Cobra una venta PENDIENTE: valida las formas de pago, asienta caja (un movimiento por forma de
 * pago, igual que una cita) y descuenta stock. Sin caja abierta no se cobra, igual que una cita.
 */
async function cobrar({ idVenta, idNegocio, idUsuario, idMetodoPago, pagos, permiteMultipago = false }) {
    return Models.sequelize.transaction(async (t) => {
        // `FOR UPDATE` no se puede combinar con el join a `detalle` (Postgres lo rechaza sobre
        // el lado nulable de un outer join): se bloquea la cabecera sola y el detalle —que no se
        // muta aquí— se lee aparte, sin bloqueo.
        const venta = await Models.ReservaVentaProducto.findOne({
            where: { id_venta: idVenta, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!venta) return null;
        venta.detalle = await Models.ReservaVentaProductoDetalle.findAll({
            where: { id_venta: venta.id_venta }, transaction: t,
        });
        if (venta.estado !== 'PENDIENTE') {
            throw error(`Esta venta ya está ${venta.estado.toLowerCase()}.`, 409, 'VENTA_NO_PENDIENTE');
        }

        const total = Number(venta.total);
        const { modo, lista } = normalizarPagos({ idMetodoPago, pagos, total });
        if (modo === 'multi' && !permiteMultipago) {
            throw error('Este negocio no tiene habilitado el pago con varias formas.', 422);
        }
        if (lista.length === 0) throw error('Indica con qué forma de pago se cobró.', 422, 'PAGO_REQUERIDO');
        await MetodoPagoService.validarDelNegocio(idNegocio, lista.map((p) => p.id_metodo_pago), { transaction: t });

        const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
        for (const p of lista) {
            await CajaService.registrarMovimiento({
                idCaja: caja.id_caja,
                tipo: 'INGRESO',
                monto: p.valor,
                concepto: `Venta de productos #${venta.id_venta}`,
                idUsuario,
                idProfesional: venta.id_profesional,
                idMetodoPago: p.id_metodo_pago,
                idVentaProducto: venta.id_venta,
                transaction: t,
            });
        }

        // Stock: se descuenta lo vendido en las líneas que lo controlan. No bloquea (ver
        // docstring del módulo): un conteo desactualizado no debe impedir una venta real.
        for (const linea of venta.detalle) {
            const producto = await Models.ReservaProducto.findOne({
                where: { id_producto: linea.id_producto, id_negocio: idNegocio },
                transaction: t, lock: t.LOCK.UPDATE,
            });
            if (producto?.controla_stock) {
                await producto.update({
                    stock_actual: Number(producto.stock_actual) - Number(linea.cantidad),
                    fecha_actualizacion: new Date(),
                }, { transaction: t });
            }
        }

        return venta.update({
            estado: 'COMPLETADA',
            id_caja: caja.id_caja,
            fecha_completada: new Date(),
        }, { transaction: t });
    });
}

/** Crea y cobra en la misma transacción: el «Vender» de un clic desde el mostrador. */
async function venderYCobrar({
    idNegocio, items, idProfesional = null, idUsuario = null, idMetodoPago, pagos,
    permiteMultipago = false, notas = null, idCita = null, idPersonaNegocio = null,
}) {
    return Models.sequelize.transaction(async (t) => {
        const { lineas, total } = await construirLineas(idNegocio, items, { transaction: t });

        const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
        const { modo, lista } = normalizarPagos({ idMetodoPago, pagos, total });
        if (modo === 'multi' && !permiteMultipago) {
            throw error('Este negocio no tiene habilitado el pago con varias formas.', 422);
        }
        if (lista.length === 0) throw error('Indica con qué forma de pago se cobró.', 422, 'PAGO_REQUERIDO');
        await MetodoPagoService.validarDelNegocio(idNegocio, lista.map((p) => p.id_metodo_pago), { transaction: t });

        const venta = await Models.ReservaVentaProducto.create({
            id_negocio: idNegocio,
            id_cita: idCita,
            id_persona_negocio: idPersonaNegocio,
            id_profesional: idProfesional,
            id_usuario: idUsuario,
            canal: 'MOSTRADOR',
            entrega: 'MOSTRADOR',
            estado: 'COMPLETADA',
            total,
            notas: notas ? String(notas).trim().slice(0, 1000) : null,
            id_caja: caja.id_caja,
            fecha_completada: new Date(),
        }, { transaction: t });

        await Models.ReservaVentaProductoDetalle.bulkCreate(
            lineas.map((l) => ({ id_venta: venta.id_venta, ...l })),
            { transaction: t },
        );

        for (const p of lista) {
            await CajaService.registrarMovimiento({
                idCaja: caja.id_caja,
                tipo: 'INGRESO',
                monto: p.valor,
                concepto: `Venta de productos #${venta.id_venta}`,
                idUsuario,
                idProfesional,
                idMetodoPago: p.id_metodo_pago,
                idVentaProducto: venta.id_venta,
                transaction: t,
            });
        }

        for (const linea of lineas) {
            if (!linea.controla_stock) continue;
            const producto = await Models.ReservaProducto.findOne({
                where: { id_producto: linea.id_producto, id_negocio: idNegocio },
                transaction: t, lock: t.LOCK.UPDATE,
            });
            await producto.update({
                stock_actual: Number(producto.stock_actual) - Number(linea.cantidad),
                fecha_actualizacion: new Date(),
            }, { transaction: t });
        }

        return venta;
    });
}

/** Cancela un pedido PENDIENTE (típicamente del portal: nunca vinieron a recogerlo). */
async function cancelar(idVenta, idNegocio) {
    const venta = await Models.ReservaVentaProducto.findOne({ where: { id_venta: idVenta, id_negocio: idNegocio } });
    if (!venta) return null;
    if (venta.estado !== 'PENDIENTE') {
        throw error(`Esta venta ya está ${venta.estado.toLowerCase()}.`, 409, 'VENTA_NO_PENDIENTE');
    }
    return venta.update({ estado: 'CANCELADA' });
}

module.exports = { crear, getById, listar, cobrar, venderYCobrar, cancelar };
