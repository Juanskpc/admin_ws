const MesaSeccionService = require('../services/mesaSeccionService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { validationResult } = require('express-validator');

/**
 * Controlador de las secciones del salon. Solo valida la forma de lo que llega y traduce: las
 * reglas (nombre unico, pertenencia al negocio) viven en `mesaSeccionService`, que lanza errores
 * tipados (`.code` + `.statusCode`) y aqui se reenvian tal cual, sin volver a envolverlos.
 */

function invalidos(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return false;
    Respuesta.error(res, 'Datos inválidos', 422, errors.array());
    return true;
}

function responderError(res, err, contexto) {
    if (err.code && err.statusCode) {
        return Respuesta.error(res, err.message, err.statusCode, { code: err.code });
    }
    console.error(`[MesaSecciones] Error ${contexto}:`, err.message);
    return Respuesta.error(res, `No se pudo ${contexto}.`);
}

/** GET /mesas/secciones?id_negocio=N */
async function listar(req, res) {
    if (invalidos(req, res)) return;
    try {
        const secciones = await MesaSeccionService.listar(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Secciones obtenidas', secciones);
    } catch (err) {
        return responderError(res, err, 'obtener las secciones');
    }
}

/** POST /mesas/secciones */
async function crear(req, res) {
    if (invalidos(req, res)) return;
    try {
        const seccion = await MesaSeccionService.crear({
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
        });
        return Respuesta.success(res, 'Sección creada', seccion, 201);
    } catch (err) {
        return responderError(res, err, 'crear la sección');
    }
}

/** PUT /mesas/secciones/:id */
async function renombrar(req, res) {
    if (invalidos(req, res)) return;
    try {
        const seccion = await MesaSeccionService.renombrar({
            idSeccion: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
            nombre: req.body.nombre,
        });
        return Respuesta.success(res, 'Sección actualizada', seccion);
    } catch (err) {
        return responderError(res, err, 'actualizar la sección');
    }
}

/** DELETE /mesas/secciones/:id?id_negocio=N — sus mesas quedan sin seccion, no se borran. */
async function eliminar(req, res) {
    if (invalidos(req, res)) return;
    try {
        const resultado = await MesaSeccionService.eliminar({
            idSeccion: Number(req.params.id),
            idNegocio: Number(req.query.id_negocio),
        });
        return Respuesta.success(res, 'Sección eliminada', resultado);
    } catch (err) {
        return responderError(res, err, 'eliminar la sección');
    }
}

/** PUT /mesas/secciones/orden — { id_negocio, ids: [...] } con TODAS las secciones en el orden nuevo. */
async function reordenar(req, res) {
    if (invalidos(req, res)) return;
    try {
        const resultado = await MesaSeccionService.reordenar({
            idNegocio: Number(req.body.id_negocio),
            ids: req.body.ids,
        });
        return Respuesta.success(res, 'Orden actualizado', resultado);
    } catch (err) {
        return responderError(res, err, 'reordenar las secciones');
    }
}

/** PUT /mesas/secciones/:id/mesas — { id_negocio, ids_mesas: [...] }: fija que mesas tiene la seccion. */
async function asignarMesas(req, res) {
    if (invalidos(req, res)) return;
    try {
        const resultado = await MesaSeccionService.asignarMesas({
            idSeccion: Number(req.params.id),
            idNegocio: Number(req.body.id_negocio),
            idsMesas: req.body.ids_mesas,
        });
        return Respuesta.success(res, 'Mesas asignadas', resultado);
    } catch (err) {
        return responderError(res, err, 'asignar las mesas');
    }
}

module.exports = { listar, crear, renombrar, eliminar, reordenar, asignarMesas };
