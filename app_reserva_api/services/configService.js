'use strict';
const Models = require('../../app_core/models/conection');

async function get(idNegocio) {
    let cfg = await Models.ReservaConfig.findByPk(idNegocio);
    if (!cfg) cfg = await Models.ReservaConfig.create({ id_negocio: idNegocio });
    return cfg;
}

async function actualizar(idNegocio, data) {
    const cfg = await get(idNegocio);
    delete data.id_negocio; delete data.fecha_creacion;
    data.fecha_actualizacion = new Date();
    return cfg.update(data);
}

module.exports = { get, actualizar };
