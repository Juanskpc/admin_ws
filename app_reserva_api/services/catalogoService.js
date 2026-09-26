'use strict';
/**
 * Catálogo de arranque: carga los servicios típicos del oficio (o las habitaciones de ejemplo de
 * un alojamiento) cuando el dueño lo pide desde el estado vacío.
 *
 * Solo se siembra sobre vacío: si el negocio ya tiene un servicio activo (o una unidad, en
 * estancias), no se toca nada. Sembrar encima de lo que el dueño ya armó sería mezclarle
 * servicios de ejemplo con los suyos. Ver `perfiles/catalogos.js`.
 */
const Models = require('../../app_core/models/conection');
const Perfiles = require('../perfiles');
const { catalogoDe, unidadesDe } = require('../perfiles/catalogos');

function error(mensaje, statusCode = 409, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

/** Qué ofrece el catálogo de este negocio, sin crear nada. Para el botón del estado vacío. */
async function vistaPrevia(idNegocio) {
    const { perfil } = await Perfiles.perfilBase(idNegocio);
    const catalogo = catalogoDe(perfil);
    const unidades = unidadesDe(perfil);
    return {
        perfil: perfil.clave,
        categorias: catalogo.map((c) => ({ categoria: c.categoria, servicios: c.servicios.map((s) => s.nombre) })),
        total_servicios: catalogo.reduce((a, c) => a + c.servicios.length, 0),
        unidades: unidades.map((u) => ({ nombre: u.nombre, unidades: u.unidades.length })),
    };
}

async function sembrarServicios(idNegocio) {
    const { perfil } = await Perfiles.perfilBase(idNegocio);
    const catalogo = catalogoDe(perfil);
    if (catalogo.length === 0) throw error('Este tipo de negocio no tiene servicios de ejemplo.', 404, 'SIN_CATALOGO');

    const activos = await Models.ReservaServicio.count({ where: { id_negocio: idNegocio, estado: 'A' } });
    if (activos > 0) {
        throw error('El negocio ya tiene servicios: los de ejemplo solo se cargan sobre un catálogo vacío.', 409, 'CATALOGO_NO_VACIO');
    }

    return Models.sequelize.transaction(async (t) => {
        let servicios = 0;
        let categorias = 0;
        const maxOrden = (await Models.ReservaCategoria.max('orden', { where: { id_negocio: idNegocio }, transaction: t })) || 0;

        for (const [i, c] of catalogo.entries()) {
            let cat = await Models.ReservaCategoria.findOne({
                where: { id_negocio: idNegocio, nombre: c.categoria, estado: 'A' }, transaction: t,
            });
            if (!cat) {
                cat = await Models.ReservaCategoria.create({
                    id_negocio: idNegocio, nombre: c.categoria, orden: maxOrden + i + 1, estado: 'A',
                }, { transaction: t });
                categorias += 1;
            }
            for (const s of c.servicios) {
                const creado = await Models.ReservaServicio.create({
                    id_negocio: idNegocio,
                    id_categoria: cat.id_categoria,
                    nombre: s.nombre,
                    descripcion: s.descripcion || null,
                    duracion_min: s.duracion_min,
                    precio: s.precio,
                    proceso_desde_min: s.proceso ? s.proceso[0] : 0,
                    proceso_min: s.proceso ? s.proceso[1] : 0,
                    a_cotizar: !!s.a_cotizar,
                    requiere_consentimiento: !!s.requiere_consentimiento,
                    estado: 'A',
                }, { transaction: t });
                for (const [orden, v] of (s.variantes || []).entries()) {
                    await Models.ReservaServicioVariante.create({
                        id_servicio: creado.id_servicio, id_negocio: idNegocio,
                        nombre: v.nombre, clave: v.clave || null,
                        duracion_min: v.duracion_min, precio: v.precio, orden,
                    }, { transaction: t });
                }
                servicios += 1;
            }
        }
        return { categorias, servicios };
    });
}

async function sembrarUnidades(idNegocio) {
    const { perfil } = await Perfiles.perfilBase(idNegocio);
    const tipos = unidadesDe(perfil);
    if (tipos.length === 0) throw error('Este tipo de negocio no reserva por noches.', 404, 'SIN_CATALOGO');

    const existentes = await Models.ReservaUnidadTipo.count({ where: { id_negocio: idNegocio, estado: 'A' } });
    if (existentes > 0) {
        throw error('El negocio ya tiene tipos de unidad: los de ejemplo solo se cargan sobre vacío.', 409, 'CATALOGO_NO_VACIO');
    }

    return Models.sequelize.transaction(async (t) => {
        let unidades = 0;
        for (const [orden, tipo] of tipos.entries()) {
            const creado = await Models.ReservaUnidadTipo.create({
                id_negocio: idNegocio,
                nombre: tipo.nombre,
                ocupacion_base: tipo.ocupacion_base,
                capacidad_max: tipo.capacidad_max,
                tarifa_base: tipo.tarifa_base,
                tarifa_fin_semana: tipo.tarifa_fin_semana,
                tarifa_persona_extra: tipo.tarifa_persona_extra,
                orden,
            }, { transaction: t });
            for (const [i, nombre] of tipo.unidades.entries()) {
                await Models.ReservaUnidad.create({
                    id_negocio: idNegocio, id_unidad_tipo: creado.id_unidad_tipo, nombre, orden: i,
                }, { transaction: t });
                unidades += 1;
            }
        }
        return { tipos: tipos.length, unidades };
    });
}

module.exports = { vistaPrevia, sembrarServicios, sembrarUnidades };
