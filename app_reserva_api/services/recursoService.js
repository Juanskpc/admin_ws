'use strict';
/**
 * Cabinas, salas y equipos (función `recursos`). Un tipo («Cabina») agrupa unidades concretas
 * («Cabina 1», «Cabina 2»); el servicio pide un tipo y la agenda asigna una unidad libre.
 */
const Models = require('../../app_core/models/conection');

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

async function listar(idNegocio) {
    const tipos = await Models.ReservaTipoRecurso.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [{
            model: Models.ReservaRecurso, as: 'recursos', required: false, where: { estado: 'A' },
            attributes: ['id_recurso', 'nombre'],
        }],
        order: [['nombre', 'ASC'], [{ model: Models.ReservaRecurso, as: 'recursos' }, 'id_recurso', 'ASC']],
    });
    const usos = await Models.ReservaServicio.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_servicio', 'nombre', 'id_tipo_recurso'],
    });
    return tipos.map((t) => ({
        ...t.toJSON(),
        servicios: usos.filter((s) => s.id_tipo_recurso === t.id_tipo_recurso).map((s) => ({ id_servicio: s.id_servicio, nombre: s.nombre })),
    }));
}

async function tipoDelNegocio(idNegocio, idTipo, transaction) {
    const t = await Models.ReservaTipoRecurso.findOne({
        where: { id_tipo_recurso: idTipo, id_negocio: idNegocio, estado: 'A' }, transaction,
    });
    if (!t) throw error('Tipo de recurso no encontrado.', 404);
    return t;
}

/**
 * Crea un tipo con sus unidades de una vez: «Cabina» × 3 crea «Cabina 1», «Cabina 2» y
 * «Cabina 3», que es como lo piensa el dueño.
 */
async function crearTipo(idNegocio, { nombre, descripcion, cantidad = 1 }) {
    const limpio = String(nombre || '').trim().slice(0, 80);
    if (!limpio) throw error('El nombre es obligatorio.', 422);
    const n = Math.min(Math.max(Number(cantidad) || 1, 1), 50);
    return Models.sequelize.transaction(async (t) => {
        const tipo = await Models.ReservaTipoRecurso.create({
            id_negocio: idNegocio, nombre: limpio, descripcion: descripcion?.trim() || null,
        }, { transaction: t });
        for (let i = 1; i <= n; i++) {
            await Models.ReservaRecurso.create({
                id_negocio: idNegocio, id_tipo_recurso: tipo.id_tipo_recurso,
                nombre: n === 1 ? limpio : `${limpio} ${i}`,
            }, { transaction: t });
        }
        return tipo;
    });
}

async function actualizarTipo(idNegocio, idTipo, { nombre, descripcion }) {
    const tipo = await tipoDelNegocio(idNegocio, idTipo);
    const cambios = { fecha_actualizacion: new Date() };
    if (nombre !== undefined) {
        const limpio = String(nombre || '').trim().slice(0, 80);
        if (!limpio) throw error('El nombre es obligatorio.', 422);
        cambios.nombre = limpio;
    }
    if (descripcion !== undefined) cambios.descripcion = descripcion?.trim() || null;
    return tipo.update(cambios);
}

/**
 * Inactiva un tipo. Los servicios que lo usaban dejan de pedir cabina (su `id_tipo_recurso`
 * vuelve a NULL): sin eso, la agenda no ofrecería ninguna hora para ellos y nadie sabría por qué.
 */
async function inactivarTipo(idNegocio, idTipo) {
    return Models.sequelize.transaction(async (t) => {
        const tipo = await tipoDelNegocio(idNegocio, idTipo, t);
        await Models.ReservaServicio.update(
            { id_tipo_recurso: null, fecha_actualizacion: new Date() },
            { where: { id_negocio: idNegocio, id_tipo_recurso: idTipo }, transaction: t },
        );
        await Models.ReservaRecurso.update(
            { estado: 'I', fecha_actualizacion: new Date() },
            { where: { id_negocio: idNegocio, id_tipo_recurso: idTipo }, transaction: t },
        );
        return tipo.update({ estado: 'I', fecha_actualizacion: new Date() }, { transaction: t });
    });
}

async function crearRecurso(idNegocio, idTipo, { nombre }) {
    await tipoDelNegocio(idNegocio, idTipo);
    const limpio = String(nombre || '').trim().slice(0, 80);
    if (!limpio) throw error('El nombre es obligatorio.', 422);
    return Models.ReservaRecurso.create({ id_negocio: idNegocio, id_tipo_recurso: idTipo, nombre: limpio });
}

async function actualizarRecurso(idNegocio, idRecurso, { nombre }) {
    const r = await Models.ReservaRecurso.findOne({ where: { id_recurso: idRecurso, id_negocio: idNegocio, estado: 'A' } });
    if (!r) throw error('Recurso no encontrado.', 404);
    const limpio = String(nombre || '').trim().slice(0, 80);
    if (!limpio) throw error('El nombre es obligatorio.', 422);
    return r.update({ nombre: limpio, fecha_actualizacion: new Date() });
}

/** Inactiva una unidad. Las citas ya asignadas a ella se conservan: ya tienen su cabina. */
async function inactivarRecurso(idNegocio, idRecurso) {
    const r = await Models.ReservaRecurso.findOne({ where: { id_recurso: idRecurso, id_negocio: idNegocio, estado: 'A' } });
    if (!r) throw error('Recurso no encontrado.', 404);
    return r.update({ estado: 'I', fecha_actualizacion: new Date() });
}

module.exports = {
    listar, crearTipo, actualizarTipo, inactivarTipo, crearRecurso, actualizarRecurso, inactivarRecurso,
};
