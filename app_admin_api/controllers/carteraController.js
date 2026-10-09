/**
 * Controlador de la Cartera — el libro de caja de EscalApp. Todo es super admin (protegido en el
 * router). Aquí solo se valida la entrada y se reenvían los errores tipados del servicio sin
 * re-envolverlos. Ver `docs/cartera.md`.
 */
'use strict';
const { validationResult } = require('express-validator');
const Cartera = require('../services/carteraService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, e.array());
        return false;
    }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Cartera] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

function filtrosDe(query) {
    return {
        desde: query.desde || null,
        hasta: query.hasta || null,
        tipo: query.tipo || null,
        idCategoria: query.id_categoria ? Number(query.id_categoria) : null,
        idCuenta: query.id_cuenta ? Number(query.id_cuenta) : null,
        origen: query.origen || null,
        busqueda: query.q?.trim() || null,
        incluirAnulados: query.anulados === 'true',
    };
}

async function getCatalogos(req, res) {
    try {
        return Respuesta.success(res, 'Catálogos de la cartera', await Cartera.catalogos());
    } catch (err) {
        return fallo(res, err, 'getCatalogos', 'Error al cargar la cartera.');
    }
}

async function getResumen(req, res) {
    if (!check(req, res)) return;
    try {
        const { desde, hasta } = filtrosDe(req.query);
        return Respuesta.success(res, 'Resumen de la cartera', await Cartera.resumen({ desde, hasta }));
    } catch (err) {
        return fallo(res, err, 'getResumen', 'Error al calcular el resumen.');
    }
}

async function getMovimientos(req, res) {
    if (!check(req, res)) return;
    try {
        return Respuesta.success(res, 'Movimientos', await Cartera.listarMovimientos(filtrosDe(req.query)));
    } catch (err) {
        return fallo(res, err, 'getMovimientos', 'Error al listar los movimientos.');
    }
}

async function exportar(req, res) {
    if (!check(req, res)) return;
    try {
        const filtros = filtrosDe(req.query);
        const csv = await Cartera.exportarCsv(filtros);
        const nombre = `cartera_${filtros.desde || 'mes'}_${filtros.hasta || 'hoy'}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        return res.send(csv);
    } catch (err) {
        return fallo(res, err, 'exportar', 'Error al exportar la cartera.');
    }
}

async function crearMovimiento(req, res) {
    if (!check(req, res)) return;
    try {
        const mov = await Cartera.crearMovimiento(req.body, { idUsuario: req.usuario?.id_usuario });
        return Respuesta.success(res, 'Movimiento registrado', mov, 201);
    } catch (err) {
        return fallo(res, err, 'crearMovimiento', 'Error al registrar el movimiento.');
    }
}

async function actualizarMovimiento(req, res) {
    if (!check(req, res)) return;
    try {
        const mov = await Cartera.actualizarMovimiento(Number(req.params.id), req.body);
        return Respuesta.success(res, 'Movimiento actualizado', mov);
    } catch (err) {
        return fallo(res, err, 'actualizarMovimiento', 'Error al actualizar el movimiento.');
    }
}

async function anularMovimiento(req, res) {
    if (!check(req, res)) return;
    try {
        const r = await Cartera.anularMovimiento(Number(req.params.id), { motivo: req.body.motivo });
        return Respuesta.success(res, 'Movimiento anulado', r);
    } catch (err) {
        return fallo(res, err, 'anularMovimiento', 'Error al anular el movimiento.');
    }
}

async function crearCuenta(req, res) {
    if (!check(req, res)) return;
    try {
        return Respuesta.success(res, 'Cuenta creada', await Cartera.crearCuenta(req.body), 201);
    } catch (err) {
        return fallo(res, err, 'crearCuenta', 'Error al crear la cuenta.');
    }
}

async function actualizarCuenta(req, res) {
    if (!check(req, res)) return;
    try {
        const r = await Cartera.actualizarCuenta(Number(req.params.id), req.body);
        return Respuesta.success(res, 'Cuenta actualizada', r);
    } catch (err) {
        return fallo(res, err, 'actualizarCuenta', 'Error al actualizar la cuenta.');
    }
}

async function crearCategoria(req, res) {
    if (!check(req, res)) return;
    try {
        return Respuesta.success(res, 'Categoría creada', await Cartera.crearCategoria(req.body), 201);
    } catch (err) {
        return fallo(res, err, 'crearCategoria', 'Error al crear la categoría.');
    }
}

async function actualizarCategoria(req, res) {
    if (!check(req, res)) return;
    try {
        const r = await Cartera.actualizarCategoria(Number(req.params.id), req.body);
        return Respuesta.success(res, 'Categoría actualizada', r);
    } catch (err) {
        return fallo(res, err, 'actualizarCategoria', 'Error al actualizar la categoría.');
    }
}

async function actualizarTarifa(req, res) {
    if (!check(req, res)) return;
    try {
        const r = await Cartera.actualizarTarifa(req.params.pasarela, req.body);
        return Respuesta.success(res, 'Tarifa actualizada', r);
    } catch (err) {
        return fallo(res, err, 'actualizarTarifa', 'Error al actualizar la tarifa.');
    }
}

module.exports = {
    getCatalogos,
    getResumen,
    getMovimientos,
    exportar,
    crearMovimiento,
    actualizarMovimiento,
    anularMovimiento,
    crearCuenta,
    actualizarCuenta,
    crearCategoria,
    actualizarCategoria,
    actualizarTarifa,
};
