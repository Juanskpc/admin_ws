/**
 * auditoriaController.js — Consulta de auditoría para el Super Admin (Hito 4).
 *
 * Endpoints (todos requieren verificarToken + requireSuperAdmin):
 *   GET /admin/auditoria/datos           → cambios de datos (auditoria.audit_dato)
 *   GET /admin/auditoria/eventos         → eventos de aplicación (auditoria.audit_evento)
 *   GET /admin/auditoria/catalogo        → valores para los filtros (tablas, módulos, negocios)
 *   GET /admin/auditoria/datos/export    → CSV (mismos filtros, máx 10.000 filas)
 *   GET /admin/auditoria/eventos/export  → CSV
 *
 * Filtros por rango de fecha usan `fecha >= :desde AND fecha < :hasta + 1 día`
 * (hora de pared Bogotá) para aprovechar el particionado mensual.
 */
'use strict';
const { validationResult } = require('express-validator');
const { stringify } = require('csv-stringify/sync');
const Models = require('../../app_core/models/conection');
const Respuesta = require('../../app_core/helpers/respuesta');

const LIMIT_DEFAULT = 25;
const LIMIT_MAX = 100;
const EXPORT_MAX = 10000;

/** Construye WHERE + replacements para audit_dato según query params. */
function buildFiltrosDatos(q) {
    const cond = [];
    const repl = {};
    if (q.esquema)    { cond.push('d.esquema = :esquema');        repl.esquema = q.esquema; }
    if (q.tabla)      { cond.push('d.tabla = :tabla');            repl.tabla = q.tabla; }
    if (q.operacion)  { cond.push('d.operacion = :operacion');    repl.operacion = q.operacion; }
    if (q.id_negocio) { cond.push('d.id_negocio = :idNegocio');   repl.idNegocio = Number(q.id_negocio); }
    if (q.id_usuario) { cond.push('d.id_usuario = :idUsuario');   repl.idUsuario = Number(q.id_usuario); }
    if (q.desde)      { cond.push('d.fecha >= :desde::date');     repl.desde = q.desde; }
    if (q.hasta)      { cond.push(`d.fecha < :hasta::date + interval '1 day'`); repl.hasta = q.hasta; }
    return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', repl };
}

/** Construye WHERE + replacements para audit_evento según query params. */
function buildFiltrosEventos(q) {
    const cond = [];
    const repl = {};
    if (q.modulo)     { cond.push('e.modulo = :modulo');          repl.modulo = q.modulo; }
    if (q.accion)     { cond.push('e.accion = :accion');          repl.accion = q.accion; }
    if (q.resultado)  { cond.push('e.resultado = :resultado');    repl.resultado = q.resultado; }
    if (q.id_negocio) { cond.push('e.id_negocio = :idNegocio');   repl.idNegocio = Number(q.id_negocio); }
    if (q.id_usuario) { cond.push('e.id_usuario = :idUsuario');   repl.idUsuario = Number(q.id_usuario); }
    if (q.desde)      { cond.push('e.fecha >= :desde::date');     repl.desde = q.desde; }
    if (q.hasta)      { cond.push(`e.fecha < :hasta::date + interval '1 day'`); repl.hasta = q.hasta; }
    return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', repl };
}

function getPaginacion(q) {
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(LIMIT_MAX, Math.max(1, parseInt(q.limit, 10) || LIMIT_DEFAULT));
    return { page, limit, offset: (page - 1) * limit };
}

/** SELECT base de datos con nombres de actor y negocio resueltos. */
const SELECT_DATOS = `
    SELECT d.id_audit, d.fecha, d.esquema, d.tabla, d.operacion,
           d.id_negocio, d.id_usuario, d.pk_registro,
           d.datos_antes, d.datos_despues,
           n.nombre AS negocio_nombre,
           TRIM(COALESCE(u.primer_nombre, '') || ' ' || COALESCE(u.primer_apellido, '')) AS usuario_nombre
      FROM auditoria.audit_dato d
      LEFT JOIN general.gener_negocio n ON n.id_negocio = d.id_negocio
      LEFT JOIN general.gener_usuario u ON u.id_usuario = d.id_usuario`;

const SELECT_EVENTOS = `
    SELECT e.id_evento, e.fecha, e.modulo, e.accion, e.resultado,
           e.id_negocio, e.id_usuario, e.ip, e.detalle,
           n.nombre AS negocio_nombre,
           TRIM(COALESCE(u.primer_nombre, '') || ' ' || COALESCE(u.primer_apellido, '')) AS usuario_nombre
      FROM auditoria.audit_evento e
      LEFT JOIN general.gener_negocio n ON n.id_negocio = e.id_negocio
      LEFT JOIN general.gener_usuario u ON u.id_usuario = e.id_usuario`;

/** GET /auditoria/datos — cambios de datos paginados. */
async function getDatos(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    }
    try {
        const { where, repl } = buildFiltrosDatos(req.query);
        const { page, limit, offset } = getPaginacion(req.query);

        const [[{ total }]] = await Models.sequelize.query(
            `SELECT count(*)::int AS total FROM auditoria.audit_dato d ${where};`,
            { replacements: repl }
        );
        const [rows] = await Models.sequelize.query(
            `${SELECT_DATOS} ${where}
             ORDER BY d.fecha DESC, d.id_audit DESC
             LIMIT :limit OFFSET :offset;`,
            { replacements: { ...repl, limit, offset } }
        );
        return Respuesta.success(res, 'Auditoría de datos obtenida', { total, page, limit, rows });
    } catch (err) {
        console.error('[Auditoria] Error getDatos:', err);
        return Respuesta.error(res, 'Error al consultar la auditoría de datos');
    }
}

/** GET /auditoria/eventos — eventos de aplicación paginados. */
async function getEventos(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    }
    try {
        const { where, repl } = buildFiltrosEventos(req.query);
        const { page, limit, offset } = getPaginacion(req.query);

        const [[{ total }]] = await Models.sequelize.query(
            `SELECT count(*)::int AS total FROM auditoria.audit_evento e ${where};`,
            { replacements: repl }
        );
        const [rows] = await Models.sequelize.query(
            `${SELECT_EVENTOS} ${where}
             ORDER BY e.fecha DESC, e.id_evento DESC
             LIMIT :limit OFFSET :offset;`,
            { replacements: { ...repl, limit, offset } }
        );
        return Respuesta.success(res, 'Auditoría de eventos obtenida', { total, page, limit, rows });
    } catch (err) {
        console.error('[Auditoria] Error getEventos:', err);
        return Respuesta.error(res, 'Error al consultar la auditoría de eventos');
    }
}

/** GET /auditoria/catalogo — valores disponibles para los filtros. */
async function getCatalogo(req, res) {
    try {
        const [tablas] = await Models.sequelize.query(
            `SELECT DISTINCT esquema, tabla FROM auditoria.audit_dato ORDER BY esquema, tabla;`
        );
        const [modulos] = await Models.sequelize.query(
            `SELECT modulo, array_agg(DISTINCT accion ORDER BY accion) AS acciones
               FROM auditoria.audit_evento GROUP BY modulo ORDER BY modulo;`
        );
        const [negocios] = await Models.sequelize.query(
            `SELECT id_negocio, nombre FROM general.gener_negocio ORDER BY nombre;`
        );
        return Respuesta.success(res, 'Catálogo de auditoría', { tablas, modulos, negocios });
    } catch (err) {
        console.error('[Auditoria] Error getCatalogo:', err);
        return Respuesta.error(res, 'Error al obtener el catálogo de auditoría');
    }
}

/** Serializa filas a CSV y responde como descarga. */
function responderCsv(res, filename, columns, rows) {
    const csv = stringify(rows, { header: true, columns, cast: { date: (d) => d.toISOString() } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM para que Excel abra el UTF-8 correctamente
    return res.send('﻿' + csv);
}

/** GET /auditoria/datos/export — CSV con los mismos filtros (máx 10.000). */
async function exportDatos(req, res) {
    try {
        const { where, repl } = buildFiltrosDatos(req.query);
        const [rows] = await Models.sequelize.query(
            `${SELECT_DATOS} ${where}
             ORDER BY d.fecha DESC, d.id_audit DESC
             LIMIT ${EXPORT_MAX};`,
            { replacements: repl }
        );
        const data = rows.map(r => ({
            ...r,
            datos_antes: r.datos_antes ? JSON.stringify(r.datos_antes) : '',
            datos_despues: r.datos_despues ? JSON.stringify(r.datos_despues) : '',
        }));
        return responderCsv(res, 'auditoria_datos.csv', [
            'id_audit', 'fecha', 'esquema', 'tabla', 'operacion', 'id_negocio',
            'negocio_nombre', 'id_usuario', 'usuario_nombre', 'pk_registro',
            'datos_antes', 'datos_despues',
        ], data);
    } catch (err) {
        console.error('[Auditoria] Error exportDatos:', err);
        return Respuesta.error(res, 'Error al exportar la auditoría de datos');
    }
}

/** GET /auditoria/eventos/export — CSV con los mismos filtros (máx 10.000). */
async function exportEventos(req, res) {
    try {
        const { where, repl } = buildFiltrosEventos(req.query);
        const [rows] = await Models.sequelize.query(
            `${SELECT_EVENTOS} ${where}
             ORDER BY e.fecha DESC, e.id_evento DESC
             LIMIT ${EXPORT_MAX};`,
            { replacements: repl }
        );
        const data = rows.map(r => ({
            ...r,
            detalle: r.detalle ? JSON.stringify(r.detalle) : '',
        }));
        return responderCsv(res, 'auditoria_eventos.csv', [
            'id_evento', 'fecha', 'modulo', 'accion', 'resultado', 'id_negocio',
            'negocio_nombre', 'id_usuario', 'usuario_nombre', 'ip', 'detalle',
        ], data);
    } catch (err) {
        console.error('[Auditoria] Error exportEventos:', err);
        return Respuesta.error(res, 'Error al exportar la auditoría de eventos');
    }
}

module.exports = { getDatos, getEventos, getCatalogo, exportDatos, exportEventos };
