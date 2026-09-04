'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

async function listar({ idNegocio, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.ReservaServicio.findAll({
        where,
        // La categoría viaja incluida para que la lista del admin pueda agruparse sin una
        // segunda petición y sin que el cliente tenga que cruzar ids a mano.
        include: [{ model: Models.ReservaCategoria, as: 'categoria',
                    attributes: ['id_categoria', 'nombre', 'orden'], required: false }],
        order: [['nombre', 'ASC']],
    });
}

async function getById(idServicio, idNegocio) {
    return Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
}

/**
 * La categoría tiene que ser del mismo negocio.
 *
 * `id_categoria` llega en el cuerpo, así que sin esta comprobación un inquilino podría colgar
 * su servicio de la categoría de otro: no rompe nada visible de inmediato, pero mete una fila
 * de un negocio dentro de la sección de otro y filtra el nombre de esa categoría al portal.
 */
async function validarCategoria(idCategoria, idNegocio) {
    if (idCategoria === undefined) return;
    if (idCategoria === null || idCategoria === '') return null;

    const cat = await Models.ReservaCategoria.findOne({
        where: { id_categoria: Number(idCategoria), id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_categoria'],
    });
    if (!cat) {
        const e = new Error('La categoría no existe o no pertenece al negocio.');
        e.statusCode = 400;
        throw e;
    }
}

async function crear(data) {
    await validarCategoria(data.id_categoria, Number(data.id_negocio));
    if (data.id_categoria === '' ) data.id_categoria = null;
    return Models.ReservaServicio.create(data);
}

async function actualizar(idServicio, idNegocio, data) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    await validarCategoria(data.id_categoria, idNegocio);
    if (data.id_categoria === '') data.id_categoria = null;
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
