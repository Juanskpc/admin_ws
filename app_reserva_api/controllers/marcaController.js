'use strict';
const { validationResult } = require('express-validator');
const MarcaService = require('../services/marcaService');
const ImagenService = require('../services/imagenService');
const Models = require('../../app_core/models/conection');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Reserva/Marca] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /reserva/marca?id_negocio=N */
async function getMarca(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await MarcaService.getMarca(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Identidad del negocio', data);
    } catch (err) {
        return fallo(res, err, 'getMarca', 'Error al consultar la identidad.');
    }
}

/** PUT /reserva/marca/colores */
async function guardarColores(req, res) {
    if (!check(req, res)) return;
    try {
        const colores = await MarcaService.guardarColores({
            idNegocio: Number(req.body.id_negocio),
            primario: req.body.primario,
            acento: req.body.acento,
        });
        return Respuesta.success(res, 'Colores guardados', { colores });
    } catch (err) {
        return fallo(res, err, 'guardarColores', 'Error al guardar los colores.');
    }
}

/** PUT /reserva/marca/paleta */
async function aplicarPaleta(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await MarcaService.aplicarPaleta({
            idNegocio: Number(req.body.id_negocio),
            idPaleta: Number(req.body.id_paleta),
        });
        return Respuesta.success(res, `Paleta «${data.nombre}» aplicada`, data);
    } catch (err) {
        return fallo(res, err, 'aplicarPaleta', 'Error al aplicar la paleta.');
    }
}

/** DELETE /reserva/marca/colores?id_negocio=N */
async function restablecerColores(req, res) {
    if (!check(req, res)) return;
    try {
        await MarcaService.restablecerColores(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Colores restablecidos', { colores: null });
    } catch (err) {
        return fallo(res, err, 'restablecerColores', 'Error al restablecer los colores.');
    }
}

/** POST /reserva/marca/logo (multipart) */
async function subirLogo(req, res) {
    if (!check(req, res)) return;
    try {
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen.', 400);
        const data = await MarcaService.guardarLogo({
            idNegocio: Number(req.body.id_negocio),
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
        });
        return Respuesta.success(res, 'Logo actualizado', data, 201);
    } catch (err) {
        return fallo(res, err, 'subirLogo', 'Error al subir el logo.');
    }
}

/** DELETE /reserva/marca/logo?id_negocio=N */
async function eliminarLogo(req, res) {
    if (!check(req, res)) return;
    try {
        await MarcaService.eliminarLogo(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Logo eliminado', { logo_url: null });
    } catch (err) {
        return fallo(res, err, 'eliminarLogo', 'Error al eliminar el logo.');
    }
}

/**
 * POST /reserva/servicios/:id/imagen (multipart)
 *
 * El archivo se nombra con el id del servicio, así que subir una foto nueva reemplaza la
 * anterior en el disco: no hay que borrar nada aparte ni quedan huérfanos.
 */
async function subirImagenServicio(req, res) {
    if (!check(req, res)) return;
    try {
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen.', 400);
        const idNegocio = Number(req.body.id_negocio);
        const idServicio = Number(req.params.id);

        const servicio = await Models.ReservaServicio.findOne({
            where: { id_servicio: idServicio, id_negocio: idNegocio },
        });
        if (!servicio) return Respuesta.error(res, 'Servicio no encontrado', 404);

        const { url, bytes } = ImagenService.guardar({
            tipo: 'servicio', idNegocio, idEntidad: idServicio,
            buffer: req.file.buffer, mimetype: req.file.mimetype,
        });
        await servicio.update({ imagen_url: url, fecha_actualizacion: new Date() });

        return Respuesta.success(res, 'Imagen actualizada', { imagen_url: url, bytes }, 201);
    } catch (err) {
        return fallo(res, err, 'subirImagenServicio', 'Error al subir la imagen.');
    }
}

/** DELETE /reserva/servicios/:id/imagen?id_negocio=N */
async function eliminarImagenServicio(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        const idServicio = Number(req.params.id);

        const servicio = await Models.ReservaServicio.findOne({
            where: { id_servicio: idServicio, id_negocio: idNegocio },
        });
        if (!servicio) return Respuesta.error(res, 'Servicio no encontrado', 404);

        ImagenService.eliminar({ tipo: 'servicio', idNegocio, idEntidad: idServicio });
        await servicio.update({ imagen_url: null, fecha_actualizacion: new Date() });

        return Respuesta.success(res, 'Imagen eliminada', { imagen_url: null });
    } catch (err) {
        return fallo(res, err, 'eliminarImagenServicio', 'Error al eliminar la imagen.');
    }
}

/** POST /reserva/marca/banner (multipart) */
async function subirBanner(req, res) {
    if (!check(req, res)) return;
    try {
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen.', 400);
        const data = await MarcaService.guardarBanner({
            idNegocio: Number(req.body.id_negocio),
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
        });
        return Respuesta.success(res, 'Banner actualizado', data, 201);
    } catch (err) {
        return fallo(res, err, 'subirBanner', 'Error al subir el banner.');
    }
}

/** DELETE /reserva/marca/banner?id_negocio=N */
async function eliminarBanner(req, res) {
    if (!check(req, res)) return;
    try {
        await MarcaService.eliminarBanner(Number(req.query.id_negocio));
        return Respuesta.success(res, 'Banner eliminado', { banner_url: null });
    } catch (err) {
        return fallo(res, err, 'eliminarBanner', 'Error al eliminar el banner.');
    }
}

/**
 * POST /reserva/profesionales/:id/foto (multipart)
 *
 * Misma mecánica que la imagen de servicio: el archivo se llama `profesional_00012.webp` por el
 * id, así que reemplazar la foto pisa la anterior y no quedan huérfanos en el disco.
 */
async function subirFotoProfesional(req, res) {
    if (!check(req, res)) return;
    try {
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen.', 400);
        const idNegocio = Number(req.body.id_negocio);
        const idProfesional = Number(req.params.id);

        const profesional = await Models.ReservaProfesional.findOne({
            where: { id_profesional: idProfesional, id_negocio: idNegocio },
        });
        if (!profesional) return Respuesta.error(res, 'Profesional no encontrado', 404);

        const { url, bytes } = ImagenService.guardar({
            tipo: 'profesional', idNegocio, idEntidad: idProfesional,
            buffer: req.file.buffer, mimetype: req.file.mimetype,
        });
        await profesional.update({ foto_url: url, fecha_actualizacion: new Date() });

        return Respuesta.success(res, 'Foto actualizada', { foto_url: url, bytes }, 201);
    } catch (err) {
        return fallo(res, err, 'subirFotoProfesional', 'Error al subir la foto.');
    }
}

/** DELETE /reserva/profesionales/:id/foto?id_negocio=N */
async function eliminarFotoProfesional(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        const idProfesional = Number(req.params.id);

        const profesional = await Models.ReservaProfesional.findOne({
            where: { id_profesional: idProfesional, id_negocio: idNegocio },
        });
        if (!profesional) return Respuesta.error(res, 'Profesional no encontrado', 404);

        ImagenService.eliminar({ tipo: 'profesional', idNegocio, idEntidad: idProfesional });
        await profesional.update({ foto_url: null, fecha_actualizacion: new Date() });

        return Respuesta.success(res, 'Foto eliminada', { foto_url: null });
    } catch (err) {
        return fallo(res, err, 'eliminarFotoProfesional', 'Error al eliminar la foto.');
    }
}

module.exports = {
    getMarca, guardarColores, aplicarPaleta, restablecerColores,
    subirLogo, eliminarLogo,
    subirBanner, eliminarBanner,
    subirImagenServicio, eliminarImagenServicio,
    subirFotoProfesional, eliminarFotoProfesional,
};
