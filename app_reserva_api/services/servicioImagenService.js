'use strict';
/**
 * Galería de un servicio: varias fotos de ejemplo («Tatuaje de línea fina», «Balayage»), aparte
 * de la portada (`reserva_servicio.imagen_url`) que sigue siendo la única que sale en la tarjeta
 * del catálogo. Mismo patrón que `portafolioService.js`, aplicado al servicio en vez de a la
 * persona — hasta 12 por servicio: es una vitrina de un solo producto, no el trabajo acumulado
 * de un profesional.
 */
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

const MAXIMO = 12;

function error(mensaje, statusCode = 400) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

async function servicioDelNegocio(idNegocio, idServicio) {
    const s = await Models.ReservaServicio.findOne({
        where: { id_servicio: idServicio, id_negocio: idNegocio }, attributes: ['id_servicio'],
    });
    if (!s) throw error('Servicio no encontrado.', 404);
}

async function listar(idNegocio, idServicio) {
    await servicioDelNegocio(idNegocio, idServicio);
    return Models.ReservaServicioImagen.findAll({
        where: { id_negocio: idNegocio, id_servicio: idServicio },
        order: [['orden', 'ASC'], ['id_imagen', 'ASC']],
    });
}

async function agregar(idNegocio, idServicio, archivo, descripcion = null) {
    await servicioDelNegocio(idNegocio, idServicio);
    if (!archivo) throw error('Falta la imagen.', 422);
    const total = await Models.ReservaServicioImagen.count({ where: { id_servicio: idServicio } });
    if (total >= MAXIMO) throw error(`La galería admite hasta ${MAXIMO} imágenes.`, 409);

    return Models.sequelize.transaction(async (t) => {
        // Primero la fila, para nombrar el archivo por su id (como el resto de imágenes).
        const fila = await Models.ReservaServicioImagen.create({
            id_negocio: idNegocio, id_servicio: idServicio, url: '', orden: total,
            descripcion: String(descripcion || '').trim().slice(0, 200) || null,
        }, { transaction: t });
        const { url } = ImagenService.guardar({
            tipo: 'servicio_galeria', idNegocio, idEntidad: fila.id_imagen, buffer: archivo.buffer, mimetype: archivo.mimetype,
        });
        return fila.update({ url }, { transaction: t });
    });
}

async function eliminar(idNegocio, idImagen) {
    const fila = await Models.ReservaServicioImagen.findOne({ where: { id_imagen: idImagen, id_negocio: idNegocio } });
    if (!fila) throw error('Imagen no encontrada.', 404);
    ImagenService.eliminar({ tipo: 'servicio_galeria', idNegocio, idEntidad: idImagen });
    await fila.destroy();
    return true;
}

module.exports = { listar, agregar, eliminar, MAXIMO };
