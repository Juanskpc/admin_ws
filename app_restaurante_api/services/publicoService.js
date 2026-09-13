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
            'logo_url',
            // Para resolver el color de marca por defecto de la carta. El controlador no los
            // devuelve crudos: van ya resueltos dentro de `carta`.
            'colores',
            'id_paleta',
        ],
        include: [{
            model: Models.GenerPaletaColor,
            as: 'paletaColor',
            required: false,
            attributes: ['colores'],
        }],
    });
}

async function getPaletaNegocioPublico(idNegocio) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_negocio', 'id_paleta'],
        include: [{
            model: Models.GenerPaletaColor,
            as: 'paletaColor',
            required: false,
            where: { estado: 'A' },
            attributes: ['id_paleta', 'nombre', 'descripcion', 'colores', 'es_default'],
        }],
    });

    if (!negocio) return null;

    if (negocio.paletaColor) return negocio.paletaColor;

    return Models.GenerPaletaColor.findOne({
        where: { estado: 'A', es_default: true },
        attributes: ['id_paleta', 'nombre', 'descripcion', 'colores', 'es_default'],
    });
}

module.exports = { getNegocioPublico, getPaletaNegocioPublico };
