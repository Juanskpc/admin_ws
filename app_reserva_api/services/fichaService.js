'use strict';
/**
 * Ficha del cliente (función `ficha`): notas, fórmulas de color, contraindicaciones,
 * consentimientos firmados, vacunas de la mascota, referencias de un diseño.
 *
 * ## Datos sensibles
 *
 * En estética y en mascotas esto es información de salud (Ley 1581). Tres reglas:
 *
 * 1. Leerla exige permiso propio (`clientes_ficha_ver` desde Clientes, `agenda_ficha` desde la
 *    cita que se atiende); tenerlo para ver la agenda no basta.
 * 2. Los archivos (el consentimiento firmado, el carné de vacunas) se guardan en
 *    `uploads/reserva/fichas`, que **no** se sirve como estático: se descargan por una ruta con
 *    token que vuelve a comprobar el negocio.
 * 3. La tabla se audita sin copiar `contenido` (ver `migrate_reserva_perfiles.js`).
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Models = require('../../app_core/models/conection');

const TIPOS = ['NOTA', 'FORMULA', 'CONTRAINDICACION', 'CONSENTIMIENTO', 'VACUNA', 'REFERENCIA'];
const BASE = path.resolve(path.join(__dirname, '..', '..', 'uploads', 'reserva', 'fichas'));
const EXTENSIONES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

async function listar(idNegocio, { idPersonaNegocio = null, idMascota = null, idCita = null } = {}) {
    let persona = idPersonaNegocio;
    if (!persona && idCita) {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio }, attributes: ['id_persona_negocio'],
        });
        persona = cita?.id_persona_negocio || null;
    }
    if (!persona) return [];

    const where = { id_negocio: idNegocio, id_persona_negocio: persona, estado: 'A' };
    if (idMascota) where.id_mascota = idMascota;
    const filas = await Models.ReservaFicha.findAll({
        where,
        include: [
            { model: Models.GenerUsuario, as: 'autor', attributes: ['primer_nombre', 'primer_apellido'], required: false },
            { model: Models.ReservaMascota, as: 'mascota', attributes: ['nombre'], required: false },
        ],
        order: [['fecha_creacion', 'DESC']],
        limit: 200,
    });
    return filas.map((f) => {
        const j = f.toJSON();
        return {
            ...j,
            autor: j.autor ? `${j.autor.primer_nombre} ${j.autor.primer_apellido}`.trim() : null,
            mascota: j.mascota?.nombre || null,
            // La ruta real no sale del servidor: el frontend pide el archivo por id.
            archivo_url: undefined,
            tiene_archivo: !!j.archivo_url,
        };
    });
}

function guardarArchivo(idNegocio, archivo) {
    if (!archivo) return null;
    const extension = EXTENSIONES[archivo.mimetype];
    if (!extension) throw error('Formato no admitido. Usa JPG, PNG, WEBP o PDF.', 422);
    if (!archivo.buffer?.length) throw error('El archivo llegó vacío.', 422);
    const dir = path.join(BASE, String(Number(idNegocio)));
    fs.mkdirSync(dir, { recursive: true });
    const nombre = `${uuidv4()}.${extension}`;
    fs.writeFileSync(path.join(dir, nombre), archivo.buffer);
    return `/uploads/reserva/fichas/${Number(idNegocio)}/${nombre}`;
}

/**
 * Anota en la ficha. Si llega `id_cita` (el profesional anota desde la cita que atiende), el
 * cliente y la mascota salen de la cita: así no puede anotar en la ficha de cualquiera.
 */
async function crear(idNegocio, idUsuario, datos, archivo = null) {
    const tipo = String(datos.tipo || '').toUpperCase();
    if (!TIPOS.includes(tipo)) throw error('Tipo de anotación no válido.', 422);

    let idPersona = datos.id_persona_negocio || null;
    let idMascota = datos.id_mascota || null;
    let idCita = datos.id_cita ? Number(datos.id_cita) : null;
    if (idCita) {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            attributes: ['id_cita', 'id_persona_negocio', 'id_mascota'],
        });
        if (!cita) throw error('Cita no encontrada.', 404);
        if (!cita.id_persona_negocio) {
            throw error('Esta cita no está ligada a un cliente (sin teléfono válido): no tiene ficha.', 409, 'CITA_SIN_CLIENTE');
        }
        idPersona = cita.id_persona_negocio;
        idMascota = idMascota || cita.id_mascota;
    }
    if (!idPersona) throw error('Indica el cliente.', 422);

    const [dueno] = await Models.sequelize.query(
        `SELECT 1 AS ok FROM platform.persona_negocio WHERE id_persona_negocio = :p AND id_negocio = :n;`,
        { replacements: { p: idPersona, n: idNegocio }, type: 'SELECT' },
    );
    if (!dueno) throw error('El cliente no pertenece a este negocio.', 404);
    if (idMascota) {
        const m = await Models.ReservaMascota.findOne({
            where: { id_mascota: idMascota, id_negocio: idNegocio, id_persona_negocio: idPersona },
            attributes: ['id_mascota'],
        });
        if (!m) throw error('La mascota no es de este cliente.', 422);
    }

    const contenido = String(datos.contenido || '').trim().slice(0, 5000) || null;
    const titulo = String(datos.titulo || '').trim().slice(0, 150) || null;
    if (!contenido && !titulo && !archivo) throw error('La anotación está vacía.', 422);
    if (tipo === 'CONSENTIMIENTO' && !archivo && !contenido) {
        throw error('Adjunta el consentimiento firmado o describe cómo se firmó.', 422);
    }

    const archivoUrl = guardarArchivo(idNegocio, archivo);
    return Models.ReservaFicha.create({
        id_negocio: idNegocio,
        id_persona_negocio: idPersona,
        id_mascota: idMascota,
        id_cita: idCita,
        tipo,
        titulo,
        contenido,
        archivo_url: archivoUrl,
        vence_en: datos.vence_en || null,
        id_usuario: idUsuario || null,
    });
}

async function eliminar(idNegocio, idFicha) {
    const f = await Models.ReservaFicha.findOne({ where: { id_ficha: idFicha, id_negocio: idNegocio, estado: 'A' } });
    if (!f) throw error('Anotación no encontrada.', 404);
    return f.update({ estado: 'I', fecha_actualizacion: new Date() });
}

/** Ruta absoluta del archivo de una anotación, comprobando que es de este negocio. */
async function rutaArchivo(idNegocio, idFicha) {
    const f = await Models.ReservaFicha.findOne({
        where: { id_ficha: idFicha, id_negocio: idNegocio, estado: 'A' }, attributes: ['archivo_url'],
    });
    if (!f?.archivo_url) throw error('Archivo no disponible.', 404);
    const raiz = path.resolve(path.join(__dirname, '..', '..'));
    const abs = path.resolve(raiz, f.archivo_url.replace(/^\/+/, ''));
    if (!abs.startsWith(BASE)) throw error('Ruta inválida.', 400);
    if (!fs.existsSync(abs)) throw error('Archivo no encontrado.', 404);
    return abs;
}

/** ¿La cita ya tiene su consentimiento registrado? Para el aviso del detalle de la cita. */
async function consentimientoDeCita(idNegocio, idCita) {
    const n = await Models.ReservaFicha.count({
        where: { id_negocio: idNegocio, id_cita: idCita, tipo: 'CONSENTIMIENTO', estado: 'A' },
    });
    return n > 0;
}

module.exports = { TIPOS, listar, crear, eliminar, rutaArchivo, consentimientoDeCita };
