'use strict';
const Models = require('../../app_core/models/conection');
const { codigoPais, monedaDePais, paisesParaSeleccion } = require('../../app_core/helpers/paises');

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
    if (!cfg) cfg = await Models.ReservaConfig.create({ id_negocio: idNegocio });
    return cfg;
}

/** Todo lo que la pantalla de configuración pinta: los ajustes, el país y su moneda. */
async function getPantalla(idNegocio) {
    const cfg = await get(idNegocio);
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, { attributes: ['pais'] });
    const pais = codigoPais(negocio?.pais) || 'CO';

    return {
        ...cfg.toJSON(),
        pais,
        moneda: monedaDePais(pais),
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
    const { pais, ...ajustes } = data;
    delete ajustes.id_negocio; delete ajustes.fecha_creacion;
    ajustes.fecha_actualizacion = new Date();

    const cfg = await get(idNegocio);

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
