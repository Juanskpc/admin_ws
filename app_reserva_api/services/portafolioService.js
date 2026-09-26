'use strict';
/**
 * Portafolio por profesional (función `portafolio`): los trabajos de un tatuador o las
 * transformaciones de una estilista, en su ficha del portal. Hasta 24 por profesional.
 */
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

const MAXIMO = 24;

function error(mensaje, statusCode = 400) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

async function profesionalDelNegocio(idNegocio, idProfesional) {
    const p = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio }, attributes: ['id_profesional'],
    });
    if (!p) throw error('Profesional no encontrado.', 404);
}

async function listar(idNegocio, idProfesional) {
    await profesionalDelNegocio(idNegocio, idProfesional);
    return Models.ReservaProfesionalImagen.findAll({
        where: { id_negocio: idNegocio, id_profesional: idProfesional },
        order: [['orden', 'ASC'], ['id_imagen', 'ASC']],
    });
}

async function agregar(idNegocio, idProfesional, archivo, descripcion = null) {
    await profesionalDelNegocio(idNegocio, idProfesional);
    if (!archivo) throw error('Falta la imagen.', 422);
    const total = await Models.ReservaProfesionalImagen.count({ where: { id_profesional: idProfesional } });
    if (total >= MAXIMO) throw error(`El portafolio admite hasta ${MAXIMO} imágenes.`, 409);

    return Models.sequelize.transaction(async (t) => {
        // Primero la fila, para nombrar el archivo por su id (como el resto de imágenes).
        const fila = await Models.ReservaProfesionalImagen.create({
            id_negocio: idNegocio, id_profesional: idProfesional, url: '', orden: total,
            descripcion: String(descripcion || '').trim().slice(0, 200) || null,
        }, { transaction: t });
        const { url } = ImagenService.guardar({
            tipo: 'portafolio', idNegocio, idEntidad: fila.id_imagen, buffer: archivo.buffer, mimetype: archivo.mimetype,
        });
        return fila.update({ url }, { transaction: t });
    });
}

async function eliminar(idNegocio, idImagen) {
    const fila = await Models.ReservaProfesionalImagen.findOne({ where: { id_imagen: idImagen, id_negocio: idNegocio } });
    if (!fila) throw error('Imagen no encontrada.', 404);
    ImagenService.eliminar({ tipo: 'portafolio', idNegocio, idEntidad: idImagen });
    await fila.destroy();
    return true;
}

module.exports = { listar, agregar, eliminar, MAXIMO };
