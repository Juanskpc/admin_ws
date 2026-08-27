'use strict';
const Models = require('../../app_core/models/conection');

async function listar(idNegocio, soloActivos = true) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.RestMetodoPago.findAll({
        where, order: [['nombre', 'ASC']],
    });
}

/**
 * Normaliza los datos de pago. Cadena vacía y `null` significan lo mismo — «no hay» — y
 * guardar `''` haría que el asistente imprimiera un guión suelto detrás del nombre.
 */
function limpiarDatosPago(valor) {
    if (valor === undefined) return undefined;
    const t = String(valor ?? '').trim();
    return t === '' ? null : t.slice(0, 200);
}

async function crear({ idNegocio, nombre, datosPago }) {
    const trimmed = String(nombre || '').trim();
    if (!trimmed) {
        const e = new Error('Nombre requerido'); e.statusCode = 422; throw e;
    }
    return Models.RestMetodoPago.create({
        id_negocio: idNegocio,
        nombre: trimmed,
        datos_pago: limpiarDatosPago(datosPago) ?? null,
        estado: 'A',
    });
}

async function actualizar({ idMetodo, idNegocio, nombre, datosPago }) {
    const m = await Models.RestMetodoPago.findOne({ where: { id_metodo_pago: idMetodo, id_negocio: idNegocio } });
    if (!m) return null;
    const trimmed = String(nombre || '').trim();
    if (!trimmed) {
        const e = new Error('Nombre requerido'); e.statusCode = 422; throw e;
    }
    const datos = limpiarDatosPago(datosPago);
    // `undefined` = no vino en la petición = no se toca. Distinto de venir vacío, que SÍ es
    // «bórralo»: sin la diferencia, un cliente que no mande el campo perdería la cuenta.
    return m.update({ nombre: trimmed, ...(datos === undefined ? {} : { datos_pago: datos }) });
}

async function inactivar({ idMetodo, idNegocio }) {
    const m = await Models.RestMetodoPago.findOne({ where: { id_metodo_pago: idMetodo, id_negocio: idNegocio } });
    if (!m) return null;
    return m.update({ estado: 'I' });
}

module.exports = { listar, crear, actualizar, inactivar };
