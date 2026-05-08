const Models = require('../../app_core/models/conection');

/**
 * publicoService — datos publicos del negocio para la carta.
 */
async function getNegocioPublico(idNegocio) {
    return Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: [
            'id_negocio',
            'nombre',
            'direccion',
            'telefono',
            'url_whatsapp',
            'url_facebook',
            'url_instagram',
        ],
    });
}

module.exports = { getNegocioPublico };
