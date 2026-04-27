'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

async function listar({ idNegocio, q, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        where[Op.or] = [
            { nombre:   { [Op.iLike]: term } },
            { nit_rut:  { [Op.iLike]: term } },
            { email:    { [Op.iLike]: term } },
            { contacto: { [Op.iLike]: term } },
        ];
    }
    return Models.TiendaProveedor.findAll({ where, order: [['nombre', 'ASC']] });
}

async function getById(idProveedor, idNegocio) {
    return Models.TiendaProveedor.findOne({ where: { id_proveedor: idProveedor, id_negocio: idNegocio } });
}

async function crear(data) {
    return Models.TiendaProveedor.create(data);
}

async function actualizar(idProveedor, idNegocio, data) {
    const p = await Models.TiendaProveedor.findOne({ where: { id_proveedor: idProveedor, id_negocio: idNegocio } });
    if (!p) return null;
    delete data.id_proveedor; delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return p.update(data);
}

async function inactivar(idProveedor, idNegocio) {
    const p = await Models.TiendaProveedor.findOne({ where: { id_proveedor: idProveedor, id_negocio: idNegocio } });
    if (!p) return null;
    return p.update({ estado: 'I', fecha_actualizacion: new Date() });
}

module.exports = { listar, getById, crear, actualizar, inactivar };
