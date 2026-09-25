const Models = require('../../app_core/models/conection');
const { avisar, TEMAS } = require('./avisoService');

/**
 * mesaSeccionService — las secciones del salon («Piso 1», «Patio», «Terraza»…).
 *
 * Una seccion se CREA una vez y las mesas se le ASIGNAN; antes era un texto libre por mesa y
 * escribir «Piso 1» a mano en cada una creaba una seccion nueva con cada error de dedo.
 *
 * Todo va acotado por `id_negocio` (multi-inquilino): las rutas reciben ids sueltos y un id de
 * otro negocio nunca debe poder leerse ni tocarse.
 *
 * Los errores llevan `.code` y `.statusCode` para que el controlador los reenvie tal cual.
 */

const NOMBRE_MAX = 60;

function error(mensaje, code, statusCode) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/** «  Piso   1 » → «Piso 1». */
function normalizarNombre(valor) {
    return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

function validarNombre(valor) {
    const nombre = normalizarNombre(valor);
    if (nombre.length < 1) throw error('Escribe el nombre de la sección.', 'NOMBRE_REQUERIDO', 422);
    if (nombre.length > NOMBRE_MAX) {
        throw error(`El nombre no puede pasar de ${NOMBRE_MAX} caracteres.`, 'NOMBRE_MUY_LARGO', 422);
    }
    return nombre;
}

async function existeNombre({ idNegocio, nombre, exceptoId = null, transaction }) {
    const { Op, fn, col, where } = Models.Sequelize;
    const filtro = {
        id_negocio: idNegocio,
        [Op.and]: [where(fn('LOWER', col('nombre')), nombre.toLowerCase())],
    };
    if (exceptoId) filtro.id_seccion = { [Op.ne]: exceptoId };
    return Boolean(await Models.RestMesaSeccion.findOne({ where: filtro, transaction }));
}

async function obtener({ idSeccion, idNegocio, transaction }) {
    const seccion = await Models.RestMesaSeccion.findOne({
        where: { id_seccion: idSeccion, id_negocio: idNegocio },
        transaction,
    });
    if (!seccion) throw error('La sección no existe.', 'SECCION_NO_ENCONTRADA', 404);
    return seccion;
}

/**
 * Comprueba que una seccion es de ESTE negocio (o `null` = sin seccion). Lo usan las mesas al
 * crearse o editarse: sin esto, un `id_seccion` de otro negocio quedaria escrito en la mesa.
 */
async function validarDelNegocio(idSeccion, idNegocio, { transaction } = {}) {
    if (idSeccion === null || idSeccion === undefined) return null;
    const seccion = await Models.RestMesaSeccion.findOne({
        where: { id_seccion: idSeccion, id_negocio: idNegocio },
        attributes: ['id_seccion'],
        transaction,
    });
    if (!seccion) throw error('La sección no pertenece a este negocio.', 'SECCION_INVALIDA', 422);
    return seccion.id_seccion;
}

/** Las secciones del negocio en su orden, cada una con cuantas mesas tiene. */
async function listar(idNegocio) {
    const secciones = await Models.RestMesaSeccion.findAll({
        where: { id_negocio: idNegocio },
        order: [['orden', 'ASC'], ['id_seccion', 'ASC']],
        raw: true,
    });
    const conteos = await Models.sequelize.query(
        `SELECT id_seccion, COUNT(*)::int AS total
           FROM restaurante.rest_mesa
          WHERE id_negocio = :n AND id_seccion IS NOT NULL
          GROUP BY id_seccion`,
        { replacements: { n: idNegocio }, type: Models.sequelize.QueryTypes.SELECT },
    );
    const porSeccion = new Map(conteos.map((c) => [c.id_seccion, c.total]));
    return secciones.map((s) => ({
        id_seccion: s.id_seccion,
        nombre: s.nombre,
        orden: s.orden,
        total_mesas: porSeccion.get(s.id_seccion) ?? 0,
    }));
}

async function crear({ idNegocio, nombre }) {
    const limpio = validarNombre(nombre);
    if (await existeNombre({ idNegocio, nombre: limpio })) {
        throw error(`Ya existe una sección llamada «${limpio}».`, 'NOMBRE_DUPLICADO', 409);
    }
    const maximo = await Models.RestMesaSeccion.max('orden', { where: { id_negocio: idNegocio } });
    const seccion = await Models.RestMesaSeccion.create({
        id_negocio: idNegocio,
        nombre: limpio,
        orden: (Number.isFinite(Number(maximo)) ? Number(maximo) : -1) + 1,
    });
    avisar(idNegocio, TEMAS.MESAS);
    return { id_seccion: seccion.id_seccion, nombre: seccion.nombre, orden: seccion.orden, total_mesas: 0 };
}

async function renombrar({ idSeccion, idNegocio, nombre }) {
    const limpio = validarNombre(nombre);
    const seccion = await obtener({ idSeccion, idNegocio });
    if (await existeNombre({ idNegocio, nombre: limpio, exceptoId: idSeccion })) {
        throw error(`Ya existe una sección llamada «${limpio}».`, 'NOMBRE_DUPLICADO', 409);
    }
    await seccion.update({ nombre: limpio });
    avisar(idNegocio, TEMAS.MESAS);
    return { id_seccion: seccion.id_seccion, nombre: seccion.nombre, orden: seccion.orden };
}

/**
 * Borra la seccion. Sus mesas NO se borran: quedan «sin seccion». Devuelve cuantas quedaron asi para
 * que la pantalla pueda decirlo.
 */
async function eliminar({ idSeccion, idNegocio }) {
    return Models.sequelize.transaction(async (t) => {
        const seccion = await obtener({ idSeccion, idNegocio, transaction: t });
        const [, meta] = await Models.sequelize.query(
            `UPDATE restaurante.rest_mesa SET id_seccion = NULL
              WHERE id_seccion = :s AND id_negocio = :n`,
            { replacements: { s: idSeccion, n: idNegocio }, transaction: t },
        );
        await seccion.destroy({ transaction: t });
        avisar(idNegocio, TEMAS.MESAS);
        return { mesas_sin_seccion: meta?.rowCount ?? 0 };
    });
}

/**
 * Guarda el orden de las secciones. Recibe TODOS los ids en el orden nuevo: es la unica forma de que
 * dos pantallas que reordenan a la vez no se pisen sin enterarse (gana la ultima lista completa).
 */
async function reordenar({ idNegocio, ids }) {
    const lista = Array.isArray(ids) ? ids.map(Number) : [];
    return Models.sequelize.transaction(async (t) => {
        const existentes = await Models.RestMesaSeccion.findAll({
            where: { id_negocio: idNegocio },
            attributes: ['id_seccion'],
            transaction: t,
        });
        const propios = new Set(existentes.map((s) => s.id_seccion));
        if (lista.some((id) => !propios.has(id)) || new Set(lista).size !== lista.length) {
            throw error('La lista de secciones no es válida.', 'ORDEN_INVALIDO', 422);
        }
        for (let i = 0; i < lista.length; i += 1) {
            await Models.RestMesaSeccion.update(
                { orden: i },
                { where: { id_seccion: lista[i], id_negocio: idNegocio }, transaction: t },
            );
        }
        avisar(idNegocio, TEMAS.MESAS);
        return { ids: lista };
    });
}

/**
 * Fija QUE mesas tiene una seccion: las de la lista pasan a ella (aunque estuvieran en otra) y las
 * que estaban y ya no aparecen quedan «sin seccion». Es una asignacion completa —lo que se marca en
 * pantalla— y no una suma, para que quitar una mesa de la lista tambien la quite de verdad.
 */
async function asignarMesas({ idSeccion, idNegocio, idsMesas }) {
    const ids = [...new Set((Array.isArray(idsMesas) ? idsMesas : []).map(Number))];
    return Models.sequelize.transaction(async (t) => {
        await obtener({ idSeccion, idNegocio, transaction: t });

        if (ids.length > 0) {
            const propias = await Models.RestMesa.count({
                where: { id_negocio: idNegocio, id_mesa: ids },
                transaction: t,
            });
            if (propias !== ids.length) {
                throw error('Alguna de las mesas no pertenece a este negocio.', 'MESAS_INVALIDAS', 422);
            }
        }

        // Las que estaban y ya no van, primero (así no se pisan con el UPDATE de abajo).
        await Models.RestMesa.update(
            { id_seccion: null },
            {
                where: {
                    id_negocio: idNegocio,
                    id_seccion: idSeccion,
                    ...(ids.length > 0 ? { id_mesa: { [Models.Sequelize.Op.notIn]: ids } } : {}),
                },
                transaction: t,
            },
        );
        if (ids.length > 0) {
            await Models.RestMesa.update(
                { id_seccion: idSeccion },
                { where: { id_negocio: idNegocio, id_mesa: ids }, transaction: t },
            );
        }
        avisar(idNegocio, TEMAS.MESAS);
        return { id_seccion: idSeccion, mesas: ids.length };
    });
}

module.exports = {
    normalizarNombre,
    validarDelNegocio,
    listar,
    crear,
    renombrar,
    eliminar,
    reordenar,
    asignarMesas,
};
