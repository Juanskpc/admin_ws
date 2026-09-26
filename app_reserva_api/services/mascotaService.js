'use strict';
/**
 * Mascotas de los clientes (perfil MASCOTAS). La mascota cuelga del cliente del negocio
 * (`platform.persona_negocio`): quien reserva es el dueño, el sujeto del servicio es el animal.
 *
 * Todo va acotado por `id_negocio`, como la cartera de clientes: dos negocios con el mismo
 * cliente tienen cada uno sus fichas de mascota.
 */
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

const ESPECIES = ['PERRO', 'GATO', 'OTRO'];
const TAMANOS = ['PEQUENO', 'MEDIANO', 'GRANDE', 'GIGANTE'];

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

function limpiar(datos = {}) {
    const txt = (v, max) => {
        const s = String(v ?? '').trim();
        return s ? s.slice(0, max) : null;
    };
    const especie = String(datos.especie || 'PERRO').toUpperCase();
    const tamano = datos.tamano ? String(datos.tamano).toUpperCase() : null;
    if (!ESPECIES.includes(especie)) throw error('Especie no válida.', 422);
    if (tamano && !TAMANOS.includes(tamano)) throw error('Tamaño no válido.', 422);
    const peso = datos.peso_kg === '' || datos.peso_kg == null ? null : Number(datos.peso_kg);
    if (peso != null && (!Number.isFinite(peso) || peso < 0 || peso > 200)) throw error('Peso no válido.', 422);
    return {
        nombre: txt(datos.nombre, 80),
        especie,
        raza: txt(datos.raza, 80),
        tamano,
        peso_kg: peso,
        fecha_nacimiento: datos.fecha_nacimiento || null,
        sexo: ['M', 'H'].includes(datos.sexo) ? datos.sexo : null,
        comportamiento: txt(datos.comportamiento, 160),
        notas: txt(datos.notas, 2000),
    };
}

async function listarDeCliente(idNegocio, idPersonaNegocio, { transaction } = {}) {
    return Models.ReservaMascota.findAll({
        where: { id_negocio: idNegocio, id_persona_negocio: idPersonaNegocio, estado: 'A' },
        order: [['nombre', 'ASC']],
        transaction,
    });
}

/** Listado de la vista Mascotas: búsqueda por nombre de la mascota o de su dueño. */
async function listar(idNegocio, { q = '', limite = 50, pagina = 1 } = {}) {
    const lim = Math.min(Math.max(Number(limite) || 50, 1), 200);
    const pag = Math.max(Number(pagina) || 1, 1);
    const termino = String(q || '').trim();
    const [filas, [{ total }]] = await Promise.all([
        Models.sequelize.query(`
            SELECT m.*, pn.nombre_mostrado AS dueno_nombre, pn.telefono_e164 AS dueno_telefono,
                   (SELECT max(c.fecha_hora_inicio) FROM reserva.reserva_cita c
                     WHERE c.id_mascota = m.id_mascota AND c.estado = 'completada') AS ultima_visita,
                   (SELECT count(*)::int FROM reserva.reserva_cita c
                     WHERE c.id_mascota = m.id_mascota AND c.estado = 'completada') AS visitas
              FROM reserva.reserva_mascota m
              JOIN platform.persona_negocio pn ON pn.id_persona_negocio = m.id_persona_negocio
             WHERE m.id_negocio = :n AND m.estado = 'A'
               AND (:q = '' OR m.nombre ILIKE :like OR pn.nombre_mostrado ILIKE :like
                    OR m.raza ILIKE :like OR pn.telefono_e164 ILIKE :like)
             ORDER BY m.nombre ASC
             LIMIT :lim OFFSET :off;`,
        { replacements: { n: idNegocio, q: termino, like: `%${termino}%`, lim, off: (pag - 1) * lim }, type: 'SELECT' }),
        Models.sequelize.query(`
            SELECT count(*)::int AS total
              FROM reserva.reserva_mascota m
              JOIN platform.persona_negocio pn ON pn.id_persona_negocio = m.id_persona_negocio
             WHERE m.id_negocio = :n AND m.estado = 'A'
               AND (:q = '' OR m.nombre ILIKE :like OR pn.nombre_mostrado ILIKE :like
                    OR m.raza ILIKE :like OR pn.telefono_e164 ILIKE :like);`,
        { replacements: { n: idNegocio, q: termino, like: `%${termino}%` }, type: 'SELECT' }),
    ]);
    return { items: filas, total, pagina: pag, limite: lim };
}

async function obtener(idNegocio, idMascota, { transaction } = {}) {
    const m = await Models.ReservaMascota.findOne({
        where: { id_mascota: idMascota, id_negocio: idNegocio }, transaction,
    });
    if (!m) throw error('Mascota no encontrada.', 404, 'MASCOTA_NO_ENCONTRADA');
    return m;
}

async function crear(idNegocio, idPersonaNegocio, datos, { transaction } = {}) {
    const limpio = limpiar(datos);
    if (!limpio.nombre) throw error('El nombre de la mascota es obligatorio.', 422);
    const dueno = await Models.sequelize.query(
        `SELECT 1 FROM platform.persona_negocio WHERE id_persona_negocio = :p AND id_negocio = :n;`,
        { replacements: { p: idPersonaNegocio, n: idNegocio }, type: 'SELECT', transaction },
    );
    if (!dueno.length) throw error('El cliente no pertenece a este negocio.', 404, 'CLIENTE_NO_ENCONTRADO');
    return Models.ReservaMascota.create({
        ...limpio, id_negocio: idNegocio, id_persona_negocio: idPersonaNegocio,
    }, { transaction });
}

async function actualizar(idNegocio, idMascota, datos) {
    const m = await obtener(idNegocio, idMascota);
    const limpio = limpiar({ ...m.toJSON(), ...datos });
    if (!limpio.nombre) throw error('El nombre de la mascota es obligatorio.', 422);
    return m.update({ ...limpio, fecha_actualizacion: new Date() });
}

async function inactivar(idNegocio, idMascota) {
    const m = await obtener(idNegocio, idMascota);
    return m.update({ estado: 'I', fecha_actualizacion: new Date() });
}

/**
 * La mascota de una reserva del portal: la misma si el dueño ya la trajo antes (mismo nombre,
 * sin distinguir mayúsculas), nueva si no. Si ya existe se completan los datos que faltaban
 * (raza, tamaño), nunca se pisan los que el negocio corrigió a mano.
 */
async function resolverOCrear(idNegocio, idPersonaNegocio, datos, { transaction } = {}) {
    const limpio = limpiar(datos);
    if (!limpio.nombre) throw error('Cuéntanos el nombre de tu mascota.', 422, 'MASCOTA_REQUERIDA');
    const existente = await Models.ReservaMascota.findOne({
        where: {
            id_negocio: idNegocio,
            id_persona_negocio: idPersonaNegocio,
            estado: 'A',
            nombre: { [Op.iLike]: limpio.nombre },
        },
        transaction,
    });
    if (!existente) return crear(idNegocio, idPersonaNegocio, limpio, { transaction });

    const faltantes = {};
    for (const campo of ['raza', 'tamano', 'peso_kg']) {
        if (existente[campo] == null && limpio[campo] != null) faltantes[campo] = limpio[campo];
    }
    if (Object.keys(faltantes).length) await existente.update(faltantes, { transaction });
    return existente;
}

module.exports = {
    ESPECIES, TAMANOS, listar, listarDeCliente, obtener, crear, actualizar, inactivar, resolverOCrear,
};
