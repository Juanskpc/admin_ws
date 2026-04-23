'use strict';
const Models = require('../../app_core/models/conection');

async function listarPaletas() {
    return Models.GenerPaletaColor.findAll({
        where: { estado: 'A' },
        order: [['es_default', 'DESC'], ['nombre', 'ASC']],
    });
}

async function getPaletaNegocio(idNegocio) {
    const neg = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio },
        include: [{ model: Models.GenerPaletaColor, as: 'paletaColor' }],
    });
    return neg?.paletaColor || null;
}

async function asignarPaletaNegocio(idNegocio, idPaleta) {
    const neg = await Models.GenerNegocio.findOne({ where: { id_negocio: idNegocio } });
    if (!neg) return null;
    if (idPaleta) {
        const exists = await Models.GenerPaletaColor.findOne({ where: { id_paleta: idPaleta, estado: 'A' } });
        if (!exists) {
            const e = new Error('Paleta no encontrada o inactiva'); e.statusCode = 404; throw e;
        }
    }
    await neg.update({ id_paleta: idPaleta || null });
    return getPaletaNegocio(idNegocio);
}

async function getConfiguracion(idNegocio) {
    const neg = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio },
        include: [{ model: Models.GenerPaletaColor, as: 'paletaColor' }],
    });
    if (!neg) return null;
    return {
        id_negocio: neg.id_negocio,
        nombre: neg.nombre,
        nit: neg.nit,
        paleta: neg.paletaColor || null,
    };
}

async function actualizarConfiguracion(idNegocio, data) {
    const neg = await Models.GenerNegocio.findOne({ where: { id_negocio: idNegocio } });
    if (!neg) return null;
    const allowed = ['nombre', 'nit', 'id_paleta'];
    const update = {};
    for (const k of allowed) if (k in data) update[k] = data[k];
    await neg.update(update);
    return getConfiguracion(idNegocio);
}

module.exports = { listarPaletas, getPaletaNegocio, asignarPaletaNegocio, getConfiguracion, actualizarConfiguracion };
