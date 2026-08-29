'use strict';
const Models = require('../../app_core/models/conection');

/**
 * Formas de pago propias de cada negocio.
 *
 * Se inactivan, nunca se borran: una forma de pago borrada dejaría huérfanos los cobros ya
 * hechos con ella y el desglose de una caja cerrada dejaría de cuadrar. `estado = 'I'` la
 * retira de los formularios y conserva el histórico.
 */

function errorValidacion(mensaje) {
    const e = new Error(mensaje);
    e.statusCode = 422;
    return e;
}

async function listar(idNegocio, { incluirInactivos = false } = {}) {
    const where = { id_negocio: idNegocio };
    if (!incluirInactivos) where.estado = 'A';
    return Models.ReservaMetodoPago.findAll({
        where,
        order: [['orden', 'ASC'], ['nombre', 'ASC']],
    });
}

async function crear({ idNegocio, nombre, orden }) {
    const limpio = String(nombre || '').trim();
    if (!limpio) throw errorValidacion('El nombre es obligatorio.');
    if (limpio.length > 80) throw errorValidacion('El nombre no puede superar 80 caracteres.');

    // El índice único de la BD ya lo impide, pero atraparlo aquí permite dar un mensaje que
    // explique qué pasó en vez de un 500 con un error de constraint.
    const yaExiste = await Models.ReservaMetodoPago.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_metodo_pago', 'nombre'],
    }).then(async () => {
        const todos = await listar(idNegocio);
        return todos.find(m => m.nombre.trim().toLowerCase() === limpio.toLowerCase());
    });
    if (yaExiste) throw errorValidacion(`Ya existe una forma de pago llamada «${yaExiste.nombre}».`);

    return Models.ReservaMetodoPago.create({
        id_negocio: idNegocio,
        nombre: limpio,
        orden: Number.isInteger(orden) ? orden : 0,
        estado: 'A',
    });
}

async function actualizar({ idMetodo, idNegocio, nombre, orden }) {
    const m = await Models.ReservaMetodoPago.findOne({
        where: { id_metodo_pago: idMetodo, id_negocio: idNegocio },
    });
    if (!m) return null;

    const datos = {};
    if (nombre !== undefined) {
        const limpio = String(nombre || '').trim();
        if (!limpio) throw errorValidacion('El nombre es obligatorio.');
        const otros = await listar(idNegocio);
        const choque = otros.find(x =>
            x.id_metodo_pago !== idMetodo && x.nombre.trim().toLowerCase() === limpio.toLowerCase());
        if (choque) throw errorValidacion(`Ya existe una forma de pago llamada «${choque.nombre}».`);
        datos.nombre = limpio;
    }
    if (orden !== undefined && Number.isInteger(orden)) datos.orden = orden;

    return m.update(datos);
}

/** Reactivar es útil: el dueño apaga «Transferencia» en temporada baja y la vuelve a encender. */
async function cambiarEstado({ idMetodo, idNegocio, estado }) {
    if (!['A', 'I'].includes(estado)) throw errorValidacion('Estado inválido.');
    const m = await Models.ReservaMetodoPago.findOne({
        where: { id_metodo_pago: idMetodo, id_negocio: idNegocio },
    });
    if (!m) return null;

    if (estado === 'A') {
        const otros = await listar(idNegocio);
        const choque = otros.find(x =>
            x.id_metodo_pago !== idMetodo &&
            x.nombre.trim().toLowerCase() === m.nombre.trim().toLowerCase());
        if (choque) throw errorValidacion('Ya hay otra forma de pago activa con ese nombre.');
    }
    return m.update({ estado });
}

/** Valida que un conjunto de ids pertenezca al negocio y esté activo. Devuelve los modelos. */
async function validarDelNegocio(idNegocio, idsMetodo, { transaction } = {}) {
    const ids = [...new Set(idsMetodo.filter(Number.isInteger))];
    if (ids.length === 0) return [];
    const encontrados = await Models.ReservaMetodoPago.findAll({
        where: { id_metodo_pago: ids, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (encontrados.length !== ids.length) {
        const e = new Error('Alguna forma de pago no es válida para este negocio.');
        e.code = 'METODO_PAGO_INVALIDO';
        e.statusCode = 400;
        throw e;
    }
    return encontrados;
}

module.exports = { listar, crear, actualizar, cambiarEstado, validarDelNegocio };
