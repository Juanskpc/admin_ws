'use strict';
const Models = require('../../app_core/models/conection');

async function listar(idNegocio, soloActivos = true) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.RestMetodoPago.findAll({
        where, order: [['nombre', 'ASC']],
    });
}

async function crear({ idNegocio, nombre }) {
    const trimmed = String(nombre || '').trim();
    if (!trimmed) {
        const e = new Error('Nombre requerido'); e.statusCode = 422; throw e;
    }
    return Models.RestMetodoPago.create({ id_negocio: idNegocio, nombre: trimmed, estado: 'A' });
}

async function actualizar({ idMetodo, idNegocio, nombre }) {
    const m = await Models.RestMetodoPago.findOne({ where: { id_metodo_pago: idMetodo, id_negocio: idNegocio } });
    if (!m) return null;
    const trimmed = String(nombre || '').trim();
    if (!trimmed) {
        const e = new Error('Nombre requerido'); e.statusCode = 422; throw e;
    }
    return m.update({ nombre: trimmed });
}

async function inactivar({ idMetodo, idNegocio }) {
    const m = await Models.RestMetodoPago.findOne({ where: { id_metodo_pago: idMetodo, id_negocio: idNegocio } });
    if (!m) return null;
    return m.update({ estado: 'I' });
}

module.exports = { listar, crear, actualizar, inactivar };
