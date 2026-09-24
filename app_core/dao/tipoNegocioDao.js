const Models = require('../models/conection');
const tipoOperativo = require('../helpers/tipoNegocioOperativo');

const TIPO_ATTRS = [
    'id_tipo_negocio', 'nombre', 'descripcion',
    'icono', 'color_hex', 'estado', 'id_tipo_modulo',
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

    const porId = new Map(tipos.map((t) => [Number(t.id_tipo_negocio), t]));
    const modulos = modulosDe(tipos, operativos);

    return tipos.map((t) => {
        // Un aplicativo se atiende a sí mismo aunque no se apunte (RESERVA no lo hace en la base).
        const modulo = t.id_tipo_modulo != null
            ? porId.get(Number(t.id_tipo_modulo))
            : (modulos.has(Number(t.id_tipo_negocio)) ? t : null);
        return {
            ...t.get({ plain: true }),
            operativo: operativos.has(Number(t.id_tipo_negocio)),
            // El aplicativo que lo atiende, con nombre legible. `null` = sin aplicativo: hoy no
            // se ofrece ni se puede atender.
            aplicativo: modulo ? nombreLegible(modulo.nombre) : null,
            // ¿Es uno de los aplicativos que se pueden elegir al crear un tipo?
            es_modulo: modulos.has(Number(t.id_tipo_negocio)),
        };
    });
}

/**
 * Los aplicativos habilitados: los tipos a los que apunta algún oficio (`id_tipo_modulo`) y que
 * tienen permisos sembrados. Es la misma condición con la que `getRubros` decide qué se ofrece.
 * No se exige que el módulo se apunte a sí mismo: RESTAURANTE lo hace, RESERVA no.
 */
function modulosDe(tipos, operativos) {
    const apuntados = new Set(
        tipos.filter((t) => t.id_tipo_modulo != null).map((t) => Number(t.id_tipo_modulo)),
    );
    return new Set([...apuntados].filter((id) => operativos.has(id)));
}

/** 'RESTAURANTE' → 'Restaurante'. Los módulos tienen nombre de una palabra en mayúsculas. */
function nombreLegible(nombre) {
    const t = String(nombre || '').toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
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
 * Crea un nuevo tipo de negocio (un OFICIO) y lo liga al aplicativo que lo atiende.
 *
 * El aplicativo es `id_tipo_modulo` y es OBLIGATORIO: un tipo sin módulo se queda fuera de todo
 * lo que se ofrece (`NULL` = «hoy no lo podemos atender»), así que crearlo así solo produce una
 * fila que nadie puede elegir. Se valida contra los módulos habilitados de verdad (`modulosDe`):
 * tipos a los que ya apunta algún oficio y que tienen permisos sembrados —hoy RESTAURANTE y
 * RESERVA—. Elegir cualquier otra cosa es un 409 en vez de un negocio inservible.
 *
 * @param {Object} data { nombre, descripcion, icono, color_hex, id_tipo_modulo }
 * @returns {Object} El tipo de negocio creado
 */
async function createTipoNegocio(data) {
    const idModulo = Number(data.id_tipo_modulo);
    if (!Number.isInteger(idModulo) || idModulo < 1) {
        const err = new Error('Elige el aplicativo que atiende a este tipo de negocio.');
        err.code = 'MODULO_REQUERIDO';
        err.statusCode = 400;
        throw err;
    }

    const [tipos, operativos] = await Promise.all([
        Models.GenerTipoNegocio.findAll({
            where: { estado: 'A' },
            attributes: ['id_tipo_negocio', 'id_tipo_modulo'],
        }),
        tipoOperativo.getTiposOperativos(),
    ]);
    if (!modulosDe(tipos, operativos).has(idModulo)) {
        const err = new Error('Ese aplicativo no está habilitado: elige Restaurante o Reserva.');
        err.code = 'MODULO_NO_DISPONIBLE';
        err.statusCode = 409;
        throw err;
    }

    return Models.GenerTipoNegocio.create({
        nombre: data.nombre,
        descripcion: data.descripcion ?? null,
        icono: data.icono ?? null,
        color_hex: data.color_hex ?? null,
        id_tipo_modulo: idModulo,
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
