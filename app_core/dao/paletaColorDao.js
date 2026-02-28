const Models = require('../models/conection');

/**
 * paletaColorDao — Operaciones de base de datos para paletas de colores.
 *
 * Tabla: general.gener_paleta_color
 */

/**
 * Obtiene todas las paletas activas.
 */
function findAll() {
    return Models.GenerPaletaColor.findAll({
        where: { estado: 'A' },
        order: [['es_default', 'DESC'], ['nombre', 'ASC']],
    });
}

/**
 * Obtiene una paleta por ID.
 * @param {number} idPaleta
 */
function findById(idPaleta) {
    return Models.GenerPaletaColor.findOne({
        where: { id_paleta: idPaleta, estado: 'A' },
    });
}

/**
 * Obtiene la paleta default del sistema.
 */
function findDefault() {
    return Models.GenerPaletaColor.findOne({
        where: { es_default: true, estado: 'A' },
    });
}

/**
 * Obtiene la paleta asociada a un negocio (via gener_negocio.id_paleta).
 * @param {number} idNegocio
 */
async function findByNegocio(idNegocio) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio },
        include: [{
            model: Models.GenerPaletaColor,
            as: 'paletaColor',
        }],
        attributes: ['id_negocio', 'id_paleta'],
    });

    if (negocio && negocio.paletaColor) {
        return negocio.paletaColor;
    }

    // Si no tiene paleta asignada, retornar la default
    return findDefault();
}

/**
 * Asigna una paleta a un negocio.
 * @param {number} idNegocio
 * @param {number} idPaleta
 */
function assignToNegocio(idNegocio, idPaleta) {
    return Models.GenerNegocio.update(
        { id_paleta: idPaleta },
        { where: { id_negocio: idNegocio } },
    );
}

module.exports = {
    findAll,
    findById,
    findDefault,
    findByNegocio,
    assignToNegocio,
};
