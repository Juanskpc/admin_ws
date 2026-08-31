'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

async function listar({ idNegocio, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.ReservaServicio.findAll({ where, order: [['nombre', 'ASC']] });
}

async function getById(idServicio, idNegocio) {
    return Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.ReservaServicio.create(data);
}

async function actualizar(idServicio, idNegocio, data) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    delete data.id_servicio; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return s.update(data);
}

/**
 * Inactiva el servicio y **borra su imagen del disco**.
 *
 * El registro se conserva (las citas ya cobradas lo referencian y su histórico debe seguir
 * leyéndose), pero el archivo no: un servicio retirado no se muestra en ninguna parte, así que
 * su foto solo ocuparía espacio hasta que alguien la encontrara por casualidad. Si se reactiva,
 * se vuelve a subir — es un clic frente a una carpeta que crece sola.
 */
async function inactivar(idServicio, idNegocio) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    if (s.imagen_url) {
        ImagenService.eliminar({ tipo: 'servicio', idNegocio, idEntidad: idServicio });
    }
    return s.update({ estado: 'I', imagen_url: null, fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, crear, actualizar, inactivar };
