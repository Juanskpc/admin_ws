'use strict';
const Models = require('../../app_core/models/conection');
const { codigoPais, monedaDePais, paisesParaSeleccion } = require('../../app_core/helpers/paises');
const Perfiles = require('../perfiles');

/**
 * Ajustes del vertical de reserva.
 *
 * ## El país no vive en esta tabla, y es a propósito
 *
 * La moneda con la que se pintan los precios sale del país del negocio, y ése está en
 * `general.gener_negocio.pais` porque decide algo más antiguo e igual de importante: cómo se
 * normaliza el teléfono de un cliente (ver `app_core/helpers/telefono.js`). Duplicarlo en
 * `reserva_config` daría dos verdades sobre la misma pregunta, y la que se quedara vieja no
 * daría error: daría teléfonos descartados en silencio o precios en la moneda equivocada.
 *
 * Por eso esta pantalla **lee y escribe el país del negocio** aunque su formulario sea el del
 * vertical. Lo que se guarda es uno y lo usan los dos.
 */

/**
 * La fila de configuración, creándola si es el primer acceso.
 *
 * Devuelve la **instancia de Sequelize** porque hay quien la actualiza con lo que recibe
 * (`vitrinaService.guardarVitrina`). Lo que la pantalla necesita —país, moneda y catálogo— se
 * pide con `getPantalla`, que no cambia este contrato.
 */
async function get(idNegocio) {
    let cfg = await Models.ReservaConfig.findByPk(idNegocio);
    if (cfg) return cfg;

    // Primer acceso: la fila nace con los valores de arranque del perfil del rubro (un spa con
    // abono del 30 % y paso de 30 min, un tatuador con 24 h de anticipación…). Es el ÚNICO sitio
    // donde se crea, así que un negocio que ya tiene fila no cambia nunca por esto. El perfil
    // BASE no trae valores: la barbería nace con los defaults de la tabla, como siempre.
    const { perfil } = await Perfiles.perfilBase(idNegocio);
    try {
        cfg = await Models.ReservaConfig.create({ id_negocio: idNegocio, ...perfil.config_inicial });
    } catch (err) {
        // Dos primeras peticiones a la vez: la otra la creó. Se lee la suya.
        if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
        cfg = await Models.ReservaConfig.findByPk(idNegocio);
    }
    return cfg;
}

/** Todo lo que la pantalla de configuración pinta: los ajustes, el país y su moneda. */
async function getPantalla(idNegocio) {
    const cfg = await get(idNegocio);
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, { attributes: ['pais'] });
    const pais = codigoPais(negocio?.pais) || 'CO';

    const { perfil, rubro } = await Perfiles.perfilBase(idNegocio);
    const elegidas = cfg.funciones || {};

    return {
        ...cfg.toJSON(),
        pais,
        moneda: monedaDePais(pais),
        // El perfil ya resuelto, para que la pantalla refresque la sesión al cambiar una función
        // sin volver a pedir el token.
        perfil: Perfiles.describirPerfil(perfil, elegidas, rubro),
        // Las funciones que el dueño puede encender o apagar, con su texto.
        funciones_config: Perfiles.funcionesConfigurables(perfil, elegidas),
        // El catálogo viaja con la respuesta para que el selector no tenga su propia copia de
        // los países: la lista buena es la del backend, que además es la que valida.
        paises: paisesParaSeleccion(),
    };
}

/**
 * Guarda los ajustes y, si viene, el país del negocio.
 *
 * `pais` se saca del cuerpo antes de tocar `reserva_config`: es columna de `gener_negocio` y
 * `cfg.update()` lo ignoraría sin decir nada, dejando una pantalla que dice haber guardado un
 * cambio que no ocurrió.
 */
async function actualizar(idNegocio, data) {
    const { pais, funciones, ...ajustes } = data;
    delete ajustes.id_negocio; delete ajustes.fecha_creacion;
    ajustes.fecha_actualizacion = new Date();

    const cfg = await get(idNegocio);

    // Las funciones se fusionan con lo que ya había decidido el dueño y se validan contra el
    // perfil: una función fija no se apaga y una de otro rubro no se enciende.
    if (funciones && typeof funciones === 'object') {
        const { perfil } = await Perfiles.perfilBase(idNegocio);
        ajustes.funciones = Perfiles.normalizarEleccion(perfil, funciones, cfg.funciones || {});
    }

    await Models.sequelize.transaction(async (t) => {
        await cfg.update(ajustes, { transaction: t });

        if (pais !== undefined && pais !== null && String(pais).trim() !== '') {
            const codigo = codigoPais(pais);
            if (!codigo) {
                const e = new Error('País no soportado.');
                e.statusCode = 422;
                e.code = 'PAIS_NO_SOPORTADO';
                throw e;
            }
            await Models.GenerNegocio.update(
                { pais: codigo },
                { where: { id_negocio: idNegocio }, transaction: t },
            );
        }
    });

    return getPantalla(idNegocio);
}

module.exports = { get, getPantalla, actualizar };
