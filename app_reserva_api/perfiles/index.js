'use strict';
/**
 * Resolución del perfil de un negocio contra la base: qué rubro es, qué perfil le toca y qué
 * funciones tiene encendidas. Las definiciones puras viven en `definiciones.js`.
 *
 * El rubro se lee de `gener_negocio.id_rubro` y, si falta, del tipo guardado en el negocio (los
 * negocios anteriores a los rubros tienen ahí su oficio o el módulo). Un tipo sin
 * `perfil_reserva` —BARBERIA, CONSULTORIO, el propio RESERVA— es perfil BASE: la barbería de
 * siempre.
 */
const Models = require('../../app_core/models/conection');
const Def = require('./definiciones');

const ATRIBUTOS_TIPO = ['id_tipo_negocio', 'nombre', 'descripcion', 'icono', 'perfil_reserva'];

function rubroVisible(tipo) {
    if (!tipo) return null;
    // `RESERVA` es el módulo, no un oficio: su descripción es una frase de catálogo
    // («Salones de belleza, barberías y…») que no sirve para nombrar a un negocio.
    if (String(tipo.nombre).toUpperCase() === 'RESERVA') return null;
    return {
        nombre: tipo.nombre,
        etiqueta: tipo.descripcion || tipo.nombre,
        icono: tipo.icono || null,
    };
}

async function leerNegocios(ids, { transaction } = {}) {
    return Models.GenerNegocio.findAll({
        where: { id_negocio: ids },
        attributes: ['id_negocio', 'id_tipo_negocio', 'id_rubro'],
        include: [
            { model: Models.GenerTipoNegocio, as: 'rubro', attributes: ATRIBUTOS_TIPO, required: false },
            { model: Models.GenerTipoNegocio, as: 'tipoNegocio', attributes: ATRIBUTOS_TIPO, required: false },
        ],
        transaction,
    });
}

function perfilDeFila(negocio) {
    const tipo = negocio?.rubro || negocio?.tipoNegocio || null;
    return {
        perfil: Def.perfilPorClave(tipo?.perfil_reserva, tipo?.nombre),
        rubro: rubroVisible(tipo),
    };
}

/** El perfil «crudo» (definición + ajuste del rubro) de un negocio. */
async function perfilBase(idNegocio, { transaction } = {}) {
    const [negocio] = await leerNegocios([Number(idNegocio)], { transaction });
    return perfilDeFila(negocio);
}

/**
 * Lo que la app necesita del perfil de un negocio (ver `Def.describirPerfil`).
 *
 * Solo lee: si el negocio aún no tiene fila de configuración, se usan las funciones de fábrica
 * sin crearla. Resolver la sesión no debe escribir en la base.
 */
async function perfilDeNegocio(idNegocio, { transaction, funciones } = {}) {
    const { perfil, rubro } = await perfilBase(idNegocio, { transaction });
    let elegidas = funciones;
    if (elegidas === undefined) {
        const cfg = await Models.ReservaConfig.findByPk(Number(idNegocio), {
            attributes: ['id_negocio', 'funciones'], transaction,
        });
        elegidas = cfg?.funciones || {};
    }
    return Def.describirPerfil(perfil, elegidas, rubro);
}

/** Lo mismo para varios negocios a la vez (la sesión de un usuario multi-negocio). */
async function perfilesDeNegocios(ids, { transaction } = {}) {
    const unicos = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (unicos.length === 0) return new Map();

    const [negocios, configs] = await Promise.all([
        leerNegocios(unicos, { transaction }),
        Models.ReservaConfig.findAll({
            where: { id_negocio: unicos }, attributes: ['id_negocio', 'funciones'], transaction,
        }),
    ]);
    const funcionesPorNegocio = new Map(configs.map((c) => [c.id_negocio, c.funciones || {}]));

    const salida = new Map();
    for (const n of negocios) {
        const { perfil, rubro } = perfilDeFila(n);
        salida.set(n.id_negocio, Def.describirPerfil(perfil, funcionesPorNegocio.get(n.id_negocio) || {}, rubro));
    }
    return salida;
}

/** ¿Tiene el negocio encendida esta función? */
async function tieneFuncion(idNegocio, funcion, opciones = {}) {
    const p = await perfilDeNegocio(idNegocio, opciones);
    return p.funciones.includes(funcion);
}

/**
 * Falla con 403 si la función no está encendida. Se usa en las rutas enteras de una función
 * (estancias, recursos, mascotas): los campos sueltos no lo necesitan porque un valor puesto
 * por API en un negocio sin la función hace lo que dice y no rompe nada.
 */
async function exigirFuncion(idNegocio, funcion, opciones = {}) {
    if (await tieneFuncion(idNegocio, funcion, opciones)) return;
    const etiqueta = Def.FUNCIONES[funcion]?.etiqueta || funcion;
    const e = new Error(`«${etiqueta}» no está activa en este negocio. Actívala en Configuración → Funciones.`);
    e.statusCode = 403;
    e.code = 'FUNCION_INACTIVA';
    throw e;
}

module.exports = {
    ...Def,
    perfilBase,
    perfilDeNegocio,
    perfilesDeNegocios,
    tieneFuncion,
    exigirFuncion,
};
