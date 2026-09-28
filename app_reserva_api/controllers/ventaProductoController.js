'use strict';
const { validationResult } = require('express-validator');
const Models = require('../../app_core/models/conection');
const VentaProductoService = require('../services/ventaProductoService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
    console.error(`[Reserva/VentaProducto] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

async function permiteMultipagoDe(idNegocio) {
    const cfg = await Models.ReservaConfig.findByPk(idNegocio, { attributes: ['permite_multipago'] });
    return !!cfg?.permite_multipago;
}

/** GET /reserva/ventas-productos?id_negocio=&estado=&canal= */
async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const ventas = await VentaProductoService.listar(Number(req.query.id_negocio), {
            estado: req.query.estado, canal: req.query.canal,
        });
        return Respuesta.success(res, 'Ventas de productos', ventas);
    } catch (err) { return fallo(res, err, 'listar', 'Error al listar las ventas.'); }
}

/** GET /reserva/ventas-productos/:id?id_negocio= */
async function getById(req, res) {
    if (!check(req, res)) return;
    try {
        const venta = await VentaProductoService.getById(Number(req.params.id), Number(req.query.id_negocio));
        if (!venta) return Respuesta.error(res, 'Venta no encontrada.', 404);
        return Respuesta.success(res, 'Venta', venta);
    } catch (err) { return fallo(res, err, 'getById', 'Error al consultar la venta.'); }
}

/**
 * POST /reserva/ventas-productos
 *
 * Un pedido de mostrador que se cobra después (o que un cajero prefiere dejar anotado). Para
 * vender y cobrar de un tirón está `vender` (abajo).
 */
async function crear(req, res) {
    if (!check(req, res)) return;
    try {
        const venta = await VentaProductoService.crear({
            idNegocio: Number(req.body.id_negocio),
            items: req.body.items,
            idCita: req.body.id_cita ? Number(req.body.id_cita) : null,
            idPersonaNegocio: req.body.id_persona_negocio || null,
            idProfesional: req.body.id_profesional ? Number(req.body.id_profesional) : null,
            idUsuario: req.usuario?.id_usuario ?? null,
            notas: req.body.notas,
        });
        return Respuesta.success(res, 'Venta registrada', venta, 201);
    } catch (err) { return fallo(res, err, 'crear', 'Error al registrar la venta.'); }
}

/** POST /reserva/ventas-productos/vender — crea y cobra en un solo paso (el mostrador). */
async function vender(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        const venta = await VentaProductoService.venderYCobrar({
            idNegocio,
            items: req.body.items,
            idProfesional: req.body.id_profesional ? Number(req.body.id_profesional) : null,
            idUsuario: req.usuario?.id_usuario ?? null,
            idMetodoPago: req.body.id_metodo_pago,
            pagos: req.body.pagos,
            permiteMultipago: await permiteMultipagoDe(idNegocio),
            notas: req.body.notas,
            idCita: req.body.id_cita ? Number(req.body.id_cita) : null,
            idPersonaNegocio: req.body.id_persona_negocio || null,
        });
        return Respuesta.success(res, 'Venta cobrada', venta, 201);
    } catch (err) { return fallo(res, err, 'vender', 'Error al vender el producto.'); }
}

/** POST /reserva/ventas-productos/:id/cobrar — cobra un pedido PENDIENTE (típicamente del portal). */
async function cobrar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        const venta = await VentaProductoService.cobrar({
            idVenta: Number(req.params.id),
            idNegocio,
            idUsuario: req.usuario?.id_usuario ?? null,
            idMetodoPago: req.body.id_metodo_pago,
            pagos: req.body.pagos,
            permiteMultipago: await permiteMultipagoDe(idNegocio),
        });
        if (!venta) return Respuesta.error(res, 'Venta no encontrada.', 404);
        return Respuesta.success(res, 'Venta cobrada', venta);
    } catch (err) { return fallo(res, err, 'cobrar', 'Error al cobrar la venta.'); }
}

/** POST /reserva/ventas-productos/:id/cancelar?id_negocio= */
async function cancelar(req, res) {
    if (!check(req, res)) return;
    try {
        const venta = await VentaProductoService.cancelar(Number(req.params.id), Number(req.body.id_negocio));
        if (!venta) return Respuesta.error(res, 'Venta no encontrada.', 404);
        return Respuesta.success(res, 'Venta cancelada', venta);
    } catch (err) { return fallo(res, err, 'cancelar', 'Error al cancelar la venta.'); }
}

module.exports = { listar, getById, crear, vender, cobrar, cancelar };
