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

    // «Cuenta / Tiquetera» no es una forma de pago más: es la que le dice al cobro que ese
    // dinero no entra al cajón hoy. Apagarla dejaría el módulo de clientes sin manera de
    // cobrar, y el fallo aparecería lejos de aquí —al intentar cobrar— sin decir por qué.
    // Renombrarla sí se permite: el código la reconoce por la marca, no por el nombre.
    if (m.es_cuenta) {
        const e = new Error('La forma de pago de las cuentas de cliente no se puede desactivar.');
        e.code = 'METODO_PAGO_PROTEGIDO';
        e.statusCode = 409;
        throw e;
    }

    return m.update({ estado: 'I' });
}

module.exports = { listar, crear, actualizar, inactivar };
