const Models = require('../models/conection');
const tipoOperativo = require('../helpers/tipoNegocioOperativo');

const TIPO_ATTRS = [
    'id_tipo_negocio', 'nombre', 'descripcion',
    'icono', 'color_hex', 'estado',
    'fecha_creacion', 'fecha_actualizacion',
];

/**
 * Obtiene todos los tipos de negocio activos.
 *
 * Cada tipo viaja con `operativo`: si tiene módulo de verdad o es solo una fila del catálogo.
 *
 * No se filtran aquí los que no lo son porque esta lista también alimenta los **filtros** de la
 * consola —hay negocios antiguos de tipos sin módulo y deben poder listarse—. Quien crea un
 * negocio sí debe ofrecer únicamente los operativos. Ver `helpers/tipoNegocioOperativo.js`.
 */
async function getListaTiposNegocio() {
    const [tipos, operativos] = await Promise.all([
        Models.GenerTipoNegocio.findAll({
            where: { estado: 'A' },
            attributes: TIPO_ATTRS,
            order: [['nombre', 'ASC']],
        }),
        tipoOperativo.getTiposOperativos(),
    ]);

    return tipos.map((t) => ({
        ...t.get({ plain: true }),
        operativo: operativos.has(Number(t.id_tipo_negocio)),
    }));
}

/**
 * Obtiene un tipo de negocio por su ID.
 * @param {number} idTipoNegocio
 * @returns {Object|null}
 */
function getTipoNegocioById(idTipoNegocio) {
    return Models.GenerTipoNegocio.findOne({
        where: { id_tipo_negocio: idTipoNegocio },
        attributes: TIPO_ATTRS
    });
}

/**
 * Crea un nuevo tipo de negocio.
 * @param {Object} data { nombre, descripcion, icono, color_hex }
 * @returns {Object} El tipo de negocio creado
 */
function createTipoNegocio(data) {
    return Models.GenerTipoNegocio.create({
        nombre: data.nombre,
        descripcion: data.descripcion ?? null,
        icono: data.icono ?? null,
        color_hex: data.color_hex ?? null,
        estado: 'A',
    });
}

/**
 * Los oficios que se le pueden ofrecer a un cliente, ya filtrados por módulo disponible.
 *
 * Es lo que alimenta el desplegable de la consola y los chips de la landing, para que la
 * decisión viva en un solo sitio en vez de en cuatro copias que había que sincronizar a mano.
 */
function getRubros() {
    return tipoOperativo.getRubros();
}

module.exports = { getListaTiposNegocio, getTipoNegocioById, createTipoNegocio, getRubros };
