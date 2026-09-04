'use strict';
const Models = require('../../app_core/models/conection');

/**
 * Categorías del catálogo: las secciones en las que el portal público agrupa los servicios.
 *
 * ## Borrar una categoría no borra sus servicios
 *
 * Se inactiva (`estado = 'I'`) y los servicios que colgaban de ella quedan con `id_categoria`
 * a NULL, es decir, en «Otros servicios». Borrarlos en cascada sería la peor sorpresa posible:
 * el dueño quita una sección para reorganizar su carta y pierde media carta con ella.
 *
 * ## El orden lo fija el negocio
 *
 * `orden` decide qué sección va primero en el portal, no el alfabeto: «Corte» antes que
 * «Tratamientos» es una decisión comercial. Al crear una categoría se coloca al final.
 */

function error(mensaje, statusCode = 400) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

async function listar(idNegocio, { incluirInactivas = false } = {}) {
    const where = { id_negocio: idNegocio };
    if (!incluirInactivas) where.estado = 'A';
    return Models.ReservaCategoria.findAll({
        where,
        order: [['orden', 'ASC'], ['nombre', 'ASC']],
    });
}

/** Cuántos servicios activos cuelgan de cada categoría. Se usa al avisar antes de inactivar. */
async function conteoServicios(idNegocio) {
    const filas = await Models.ReservaServicio.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_categoria', [Models.sequelize.fn('COUNT', '*'), 'total']],
        group: ['id_categoria'],
        raw: true,
    });
    const mapa = new Map();
    for (const f of filas) mapa.set(f.id_categoria, Number(f.total));
    return mapa;
}

async function getById(idCategoria, idNegocio) {
    return Models.ReservaCategoria.findOne({
        where: { id_categoria: idCategoria, id_negocio: idNegocio },
    });
}

async function crear({ idNegocio, nombre, descripcion }) {
    const limpio = String(nombre || '').trim();
    if (!limpio) throw error('El nombre de la categoría es obligatorio.', 422);

    const duplicada = await Models.ReservaCategoria.findOne({
        where: {
            id_negocio: idNegocio, estado: 'A',
            nombre: Models.Sequelize.where(
                Models.sequelize.fn('lower', Models.sequelize.col('nombre')),
                limpio.toLowerCase(),
            ),
        },
    });
    if (duplicada) throw error(`Ya existe una categoría llamada «${duplicada.nombre}».`, 409);

    const [[fila]] = await Models.sequelize.query(
        'SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM reserva.reserva_categoria WHERE id_negocio = :n',
        { replacements: { n: idNegocio } },
    );

    return Models.ReservaCategoria.create({
        id_negocio: idNegocio,
        nombre: limpio,
        descripcion: String(descripcion || '').trim() || null,
        orden: Number(fila.siguiente) || 0,
    });
}

async function actualizar(idCategoria, idNegocio, { nombre, descripcion }) {
    const cat = await getById(idCategoria, idNegocio);
    if (!cat) throw error('Categoría no encontrada.', 404);

    const cambios = { fecha_actualizacion: new Date() };
    if (nombre !== undefined) {
        const limpio = String(nombre).trim();
        if (!limpio) throw error('El nombre de la categoría es obligatorio.', 422);
        cambios.nombre = limpio;
    }
    if (descripcion !== undefined) cambios.descripcion = String(descripcion || '').trim() || null;

    return cat.update(cambios);
}

/**
 * Inactiva la categoría y suelta sus servicios.
 *
 * Las dos cosas van en una transacción: una categoría inactiva con servicios todavía apuntando
 * a ella los dejaría invisibles en el portal (no salen en su sección porque está oculta, ni en
 * «Otros» porque tienen categoría).
 */
async function inactivar(idCategoria, idNegocio) {
    const cat = await getById(idCategoria, idNegocio);
    if (!cat) throw error('Categoría no encontrada.', 404);

    const t = await Models.sequelize.transaction();
    try {
        await Models.ReservaServicio.update(
            { id_categoria: null, fecha_actualizacion: new Date() },
            { where: { id_categoria: idCategoria, id_negocio: idNegocio }, transaction: t },
        );
        await cat.update({ estado: 'I', fecha_actualizacion: new Date() }, { transaction: t });
        await t.commit();
        return cat;
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/**
 * Reordena las categorías según la lista de ids recibida.
 *
 * Se validan **todos** los ids contra el negocio antes de escribir nada: sin eso, una lista con
 * el id de otro inquilino reordenaría su catálogo.
 */
async function reordenar(idNegocio, idsEnOrden) {
    if (!Array.isArray(idsEnOrden) || !idsEnOrden.length) return listar(idNegocio);

    const ids = idsEnOrden.map(Number).filter(Number.isInteger);
    const propias = await Models.ReservaCategoria.findAll({
        where: { id_negocio: idNegocio, id_categoria: ids },
        attributes: ['id_categoria'],
        raw: true,
    });
    if (propias.length !== ids.length) throw error('Alguna categoría no pertenece al negocio.', 400);

    const t = await Models.sequelize.transaction();
    try {
        for (let i = 0; i < ids.length; i++) {
            await Models.ReservaCategoria.update(
                { orden: i, fecha_actualizacion: new Date() },
                { where: { id_categoria: ids[i], id_negocio: idNegocio }, transaction: t },
            );
        }
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }
    return listar(idNegocio);
}

module.exports = { listar, getById, crear, actualizar, inactivar, reordenar, conteoServicios };
