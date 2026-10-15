const Models = require('../../app_core/models/conection');
const { getIdsConPlanActivo } = require('../../app_core/helpers/planHelper');

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
            // La carta ofrece las adiciones de cada producto y las nombra como el negocio.
            'permite_adiciones',
            'termino_adiciones',
        ],
        include: [{
            model: Models.GenerPaletaColor,
            as: 'paletaColor',
            required: false,
            attributes: ['colores'],
        }],
    });
}

/**
 * Las sedes entre las que puede elegir quien abre esta carta.
 *
 * **La matriz va incluida.** Puertas adentro matriz y sede son cosas distintas (`id_negocio_padre`,
 * ver `app_core/dao/sedeDao.js`), pero para quien va a pedir son dos sitios donde comer, así que la
 * lista las trae a las dos. Se llaman «sedes» y no «locales» porque en esta carta «el local» ya es
 * otra cosa: comer ahí sentado, la modalidad `L`.
 *
 * Esto no cruza datos de nadie: solo dice qué otras cartas son del mismo grupo, para poder
 * preguntar «¿dónde deseas pedir?» y llevar al cliente a la que elija. Cada sede sigue sirviendo SU
 * carta, con sus precios y su WhatsApp.
 *
 * Devuelve la lista completa —la sede de la URL incluida— o **vacío** cuando no hay nada que
 * elegir: un negocio que va solo, o un grupo en el que solo una sede puede atender. Preguntar
 * entre una sola opción es una pantalla de más.
 *
 * El plan se comprueba con `getIdsConPlanActivo` y no con un `fecha_fin >= hoy` en el SQL: así los
 * cinco días de gracia y el caso de quien renueva antes de tiempo se resuelven en el mismo sitio
 * que los resuelve el resto del sistema, y la carta no inventa su propia idea de «plan activo».
 */
async function listarSedes(idNegocio) {
    const filas = await Models.sequelize.query(
        `WITH grupo AS (
             SELECT COALESCE(id_negocio_padre, id_negocio) AS id_matriz
               FROM general.gener_negocio
              WHERE id_negocio = :idNegocio
         )
         SELECT n.id_negocio, n.nombre, n.direccion
           FROM general.gener_negocio n
           JOIN grupo g
             ON n.id_negocio = g.id_matriz OR n.id_negocio_padre = g.id_matriz
          WHERE n.estado = 'A'
          ORDER BY (n.id_negocio_padre IS NULL) DESC, n.nombre ASC;`,
        { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT },
    );
    if (filas.length < 2) return [];

    const conPlan = await getIdsConPlanActivo(filas.map((f) => f.id_negocio));
    const sedes = filas.filter((f) => conPlan.has(Number(f.id_negocio)));
    return sedes.length < 2 ? [] : sedes;
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

module.exports = { getNegocioPublico, listarSedes, getPaletaNegocioPublico };
