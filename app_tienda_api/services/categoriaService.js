'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, q, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    if (q && q.trim()) {
        where[Op.or] = [
            { nombre:       { [Op.iLike]: `%${q.trim()}%` } },
            { descripcion:  { [Op.iLike]: `%${q.trim()}%` } },
        ];
    }
    return Models.TiendaCategoria.findAll({ where, order: [['orden', 'ASC'], ['nombre', 'ASC']] });
}

async function getById(idCategoria, idNegocio) {
    return Models.TiendaCategoria.findOne({ where: { id_categoria: idCategoria, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.TiendaCategoria.create(data);
}

async function actualizar(idCategoria, idNegocio, data) {
    const c = await Models.TiendaCategoria.findOne({ where: { id_categoria: idCategoria, id_negocio: idNegocio } });
    if (!c) return null;
    delete data.id_categoria; delete data.id_negocio; delete data.fecha_creacion;
    return c.update(data);
}

async function inactivar(idCategoria, idNegocio) {
    const c = await Models.TiendaCategoria.findOne({ where: { id_categoria: idCategoria, id_negocio: idNegocio } });
    if (!c) return null;
    return c.update({ estado: 'I' });
}

module.exports = { listar, getById, crear, actualizar, inactivar };
