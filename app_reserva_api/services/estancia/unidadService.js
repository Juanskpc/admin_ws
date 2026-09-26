'use strict';
/**
 * Lo que se reserva por noches: tipos de unidad (con su tarifa y temporadas), las unidades
 * concretas, sus bloqueos manuales y los calendarios externos que se importan.
 */
const Models = require('../../../app_core/models/conection');
const { Op } = Models.Sequelize;
const ImagenService = require('../imagenService');
const T = require('./tarifas');

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

const texto = (v, max) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : null;
};
const numero = (v, { min = 0, entero = false, nulo = false } = {}) => {
    if ((v === null || v === '' || v === undefined) && nulo) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || (entero && !Number.isInteger(n))) throw error('Valor numérico no válido.', 422);
    return n;
};

// ── Tipos ──

async function listarTipos(idNegocio) {
    return Models.ReservaUnidadTipo.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [
            { model: Models.ReservaUnidad, as: 'unidades', required: false, where: { estado: 'A' },
              include: [{ model: Models.ReservaCalendarioExterno, as: 'calendarios', required: false, where: { estado: 'A' },
                          attributes: ['id_calendario', 'nombre', 'url_ical', 'ultima_sincronizacion', 'ultimo_error'] }] },
            { model: Models.ReservaTarifaTemporada, as: 'temporadas', required: false, where: { estado: 'A' } },
        ],
        order: [
            ['orden', 'ASC'], ['nombre', 'ASC'],
            [{ model: Models.ReservaUnidad, as: 'unidades' }, 'orden', 'ASC'],
            [{ model: Models.ReservaTarifaTemporada, as: 'temporadas' }, 'desde', 'ASC'],
        ],
    });
}

async function tipoDelNegocio(idNegocio, idTipo, transaction) {
    const t = await Models.ReservaUnidadTipo.findOne({
        where: { id_unidad_tipo: idTipo, id_negocio: idNegocio, estado: 'A' }, transaction,
    });
    if (!t) throw error('Tipo de unidad no encontrado.', 404);
    return t;
}

function datosTipo(d, parcial = false) {
    const salida = {};
    const poner = (campo, fn) => { if (!parcial || d[campo] !== undefined) salida[campo] = fn(d[campo]); };
    poner('nombre', (v) => {
        const s = texto(v, 100);
        if (!s) throw error('El nombre es obligatorio.', 422);
        return s;
    });
    poner('descripcion', (v) => texto(v, 2000));
    poner('ocupacion_base', (v) => numero(v ?? 2, { min: 1, entero: true }));
    poner('capacidad_max', (v) => numero(v ?? 2, { min: 1, entero: true }));
    poner('tarifa_base', (v) => numero(v ?? 0));
    poner('tarifa_fin_semana', (v) => numero(v, { nulo: true }));
    poner('tarifa_persona_extra', (v) => numero(v ?? 0));
    poner('min_noches', (v) => numero(v ?? 1, { min: 1, entero: true }));
    poner('orden', (v) => numero(v ?? 0, { entero: true }));
    poner('comodidades', (v) => (Array.isArray(v) ? v.map((x) => texto(x, 60)).filter(Boolean).slice(0, 30) : []));
    if (salida.capacidad_max != null && salida.ocupacion_base != null && salida.ocupacion_base > salida.capacidad_max) {
        throw error('La ocupación incluida no puede superar la capacidad.', 422);
    }
    return salida;
}

/** Crea un tipo con `cantidad` unidades («Habitación doble» × 3 → 101, 102, 103 si se dan nombres). */
async function crearTipo(idNegocio, datos) {
    const limpio = datosTipo(datos);
    const nombres = Array.isArray(datos.unidades) && datos.unidades.length
        ? datos.unidades.map((n) => texto(n, 60)).filter(Boolean)
        : Array.from({ length: Math.min(Math.max(Number(datos.cantidad) || 1, 1), 100) },
            (_, i) => `${limpio.nombre} ${i + 1}`);
    return Models.sequelize.transaction(async (t) => {
        const tipo = await Models.ReservaUnidadTipo.create({ ...limpio, id_negocio: idNegocio }, { transaction: t });
        for (const [i, nombre] of nombres.entries()) {
            await Models.ReservaUnidad.create({ id_negocio: idNegocio, id_unidad_tipo: tipo.id_unidad_tipo, nombre, orden: i }, { transaction: t });
        }
        return tipo;
    });
}

async function actualizarTipo(idNegocio, idTipo, datos) {
    const tipo = await tipoDelNegocio(idNegocio, idTipo);
    const limpio = datosTipo(datos, true);
    const ocup = limpio.ocupacion_base ?? tipo.ocupacion_base;
    const cap = limpio.capacidad_max ?? tipo.capacidad_max;
    if (ocup > cap) throw error('La ocupación incluida no puede superar la capacidad.', 422);
    return tipo.update({ ...limpio, fecha_actualizacion: new Date() });
}

/** Inactiva un tipo si no tiene estancias vivas en ninguna de sus unidades. */
async function inactivarTipo(idNegocio, idTipo) {
    return Models.sequelize.transaction(async (t) => {
        const tipo = await tipoDelNegocio(idNegocio, idTipo, t);
        const vivas = await Models.ReservaEstancia.count({
            where: { id_unidad_tipo: idTipo, estado: ['pendiente', 'confirmada', 'en_curso'] }, transaction: t,
        });
        if (vivas) throw error(`Hay ${vivas} estancia(s) vivas de este tipo: cancélalas o muévelas antes.`, 409, 'TIENE_ESTANCIAS');
        await Models.ReservaUnidad.update({ estado: 'I' }, { where: { id_unidad_tipo: idTipo }, transaction: t });
        return tipo.update({ estado: 'I', fecha_actualizacion: new Date() }, { transaction: t });
    });
}

async function subirImagenTipo(idNegocio, idTipo, archivo) {
    const tipo = await tipoDelNegocio(idNegocio, idTipo);
    if (!archivo) throw error('Falta la imagen.', 422);
    const { url } = ImagenService.guardar({
        tipo: 'unidad', idNegocio, idEntidad: idTipo, buffer: archivo.buffer, mimetype: archivo.mimetype,
    });
    return tipo.update({ imagen_url: url, fecha_actualizacion: new Date() });
}

async function eliminarImagenTipo(idNegocio, idTipo) {
    const tipo = await tipoDelNegocio(idNegocio, idTipo);
    ImagenService.eliminar({ tipo: 'unidad', idNegocio, idEntidad: idTipo });
    return tipo.update({ imagen_url: null, fecha_actualizacion: new Date() });
}

// ── Temporadas ──

async function guardarTemporada(idNegocio, idTipo, datos, idTarifa = null) {
    await tipoDelNegocio(idNegocio, idTipo);
    const nombre = texto(datos.nombre, 80);
    if (!nombre) throw error('La temporada necesita un nombre.', 422);
    T.aDia(datos.desde); T.aDia(datos.hasta);
    if (String(datos.hasta) < String(datos.desde)) throw error('La temporada termina antes de empezar.', 422);
    const fila = {
        nombre, desde: datos.desde, hasta: datos.hasta,
        precio_noche: numero(datos.precio_noche),
        min_noches: numero(datos.min_noches, { min: 1, entero: true, nulo: true }),
    };
    if (idTarifa) {
        const t = await Models.ReservaTarifaTemporada.findOne({ where: { id_tarifa: idTarifa, id_negocio: idNegocio, id_unidad_tipo: idTipo } });
        if (!t) throw error('Temporada no encontrada.', 404);
        return t.update(fila);
    }
    return Models.ReservaTarifaTemporada.create({ ...fila, id_negocio: idNegocio, id_unidad_tipo: idTipo });
}

async function eliminarTemporada(idNegocio, idTarifa) {
    const t = await Models.ReservaTarifaTemporada.findOne({ where: { id_tarifa: idTarifa, id_negocio: idNegocio } });
    if (!t) throw error('Temporada no encontrada.', 404);
    return t.update({ estado: 'I' });
}

// ── Unidades ──

async function crearUnidad(idNegocio, idTipo, { nombre, notas }) {
    await tipoDelNegocio(idNegocio, idTipo);
    const n = texto(nombre, 60);
    if (!n) throw error('El nombre es obligatorio.', 422);
    const orden = await Models.ReservaUnidad.count({ where: { id_unidad_tipo: idTipo } });
    return Models.ReservaUnidad.create({ id_negocio: idNegocio, id_unidad_tipo: idTipo, nombre: n, notas: texto(notas, 255), orden });
}

async function unidadDelNegocio(idNegocio, idUnidad, transaction) {
    const u = await Models.ReservaUnidad.findOne({ where: { id_unidad: idUnidad, id_negocio: idNegocio, estado: 'A' }, transaction });
    if (!u) throw error('Unidad no encontrada.', 404);
    return u;
}

async function actualizarUnidad(idNegocio, idUnidad, { nombre, notas }) {
    const u = await unidadDelNegocio(idNegocio, idUnidad);
    const cambios = { fecha_actualizacion: new Date() };
    if (nombre !== undefined) {
        const n = texto(nombre, 60);
        if (!n) throw error('El nombre es obligatorio.', 422);
        cambios.nombre = n;
    }
    if (notas !== undefined) cambios.notas = texto(notas, 255);
    return u.update(cambios);
}

async function inactivarUnidad(idNegocio, idUnidad) {
    const u = await unidadDelNegocio(idNegocio, idUnidad);
    const vivas = await Models.ReservaEstancia.count({
        where: { id_unidad: idUnidad, estado: ['pendiente', 'confirmada', 'en_curso'] },
    });
    if (vivas) throw error(`La unidad tiene ${vivas} estancia(s) vivas.`, 409, 'TIENE_ESTANCIAS');
    return u.update({ estado: 'I', fecha_actualizacion: new Date() });
}

/** El token del calendario exportado se puede regenerar si se filtró. */
async function regenerarTokenIcal(idNegocio, idUnidad) {
    const u = await unidadDelNegocio(idNegocio, idUnidad);
    const [[fila]] = await Models.sequelize.query('SELECT gen_random_uuid() AS token;');
    return u.update({ ical_token: fila.token });
}

// ── Bloqueos manuales ──

async function crearBloqueo(idNegocio, idUnidad, { desde, hasta, motivo }) {
    await unidadDelNegocio(idNegocio, idUnidad);
    T.noches(desde, hasta);
    const choca = await Models.ReservaEstancia.count({
        where: {
            id_unidad: idUnidad, estado: ['pendiente', 'confirmada', 'en_curso'],
            fecha_entrada: { [Op.lt]: hasta }, fecha_salida: { [Op.gt]: desde },
        },
    });
    if (choca) throw error('Hay estancias en esas fechas: muévelas antes de bloquear la unidad.', 409, 'TIENE_ESTANCIAS');
    return Models.ReservaBloqueoUnidad.create({
        id_negocio: idNegocio, id_unidad: idUnidad, fecha_desde: desde, fecha_hasta: hasta,
        motivo: texto(motivo, 255), origen: 'manual',
    });
}

async function eliminarBloqueo(idNegocio, idBloqueo) {
    const b = await Models.ReservaBloqueoUnidad.findOne({ where: { id_bloqueo: idBloqueo, id_negocio: idNegocio } });
    if (!b) throw error('Bloqueo no encontrado.', 404);
    if (b.origen === 'ical') throw error('Este bloqueo viene de otro calendario: se quita allá.', 409, 'BLOQUEO_EXTERNO');
    await b.destroy();
    return true;
}

// ── Calendarios externos ──

function validarUrlIcal(url) {
    const u = String(url || '').trim();
    let parsed;
    try { parsed = new URL(u); } catch { throw error('La dirección del calendario no es válida.', 422); }
    if (parsed.protocol !== 'https:') throw error('El calendario debe ser una dirección https.', 422);
    if (u.length > 1000) throw error('La dirección es demasiado larga.', 422);
    return u;
}

async function crearCalendario(idNegocio, idUnidad, { nombre, url_ical }) {
    await unidadDelNegocio(idNegocio, idUnidad);
    const n = texto(nombre, 60);
    if (!n) throw error('Ponle un nombre (Airbnb, Booking…).', 422);
    return Models.ReservaCalendarioExterno.create({
        id_negocio: idNegocio, id_unidad: idUnidad, nombre: n, url_ical: validarUrlIcal(url_ical),
    });
}

async function eliminarCalendario(idNegocio, idCalendario) {
    const c = await Models.ReservaCalendarioExterno.findOne({ where: { id_calendario: idCalendario, id_negocio: idNegocio } });
    if (!c) throw error('Calendario no encontrado.', 404);
    // Sus bloqueos se van con él (ON DELETE CASCADE): las noches vuelven a estar libres aquí.
    await c.destroy();
    return true;
}

module.exports = {
    listarTipos, crearTipo, actualizarTipo, inactivarTipo, subirImagenTipo, eliminarImagenTipo,
    guardarTemporada, eliminarTemporada,
    crearUnidad, actualizarUnidad, inactivarUnidad, regenerarTokenIcal,
    crearBloqueo, eliminarBloqueo,
    crearCalendario, eliminarCalendario, validarUrlIcal,
};
