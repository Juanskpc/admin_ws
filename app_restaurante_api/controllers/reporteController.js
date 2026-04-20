const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const reporteService = require('../services/reporteService');
const exportService = require('../../app_parqueadero_api/services/reporteExportService');

function getErrorStatus(error) {
    return Number(error?.statusCode) || 500;
}

function getErrorMessage(error, fallback) {
    return error?.message || fallback;
}

function getValidationError(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        Respuesta.error(res, 'Parametros invalidos', 422, errors.array());
        return true;
    }
    return false;
}

function buildSlugFromNegocio(nombreNegocio) {
    return String(nombreNegocio || 'negocio')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .toLowerCase();
}

async function getReportes(req, res) {
    if (getValidationError(req, res)) return;

    try {
        const data = await reporteService.getReporte({
            idUsuario: req.usuario.id_usuario,
            idNegocio: req.query.id_negocio,
            tipo: req.query.tipo,
            fechaDesde: req.query.fecha_desde,
            fechaHasta: req.query.fecha_hasta,
            page: req.query.page,
            pageSize: req.query.page_size,
        });

        return Respuesta.success(res, 'Reporte generado', data);
    } catch (error) {
        const status = getErrorStatus(error);
        if (status >= 500) {
            console.error('[Restaurante][Reportes] Error getReportes:', error.message);
        }
        return Respuesta.error(res, getErrorMessage(error, 'Error al generar el reporte.'), status);
    }
}

async function exportarReporte(req, res) {
    if (getValidationError(req, res)) return;

    try {
        const formato = (req.query.formato || 'xlsx').toLowerCase();
        const payload = await reporteService.getExportPayload({
            idUsuario: req.usuario.id_usuario,
            idNegocio: req.query.id_negocio,
            tipo: req.query.tipo,
            fechaDesde: req.query.fecha_desde,
            fechaHasta: req.query.fecha_hasta,
        });

        const slugNegocio = buildSlugFromNegocio(payload.negocio.nombre);
        const exportOptions = {
            slugNegocio,
            tipoReporte: payload.tipo,
            titulo: payload.titulo,
            columnas: payload.columns.map((column) => column.label),
            kpis: payload.resumen,
        };

        let exportResult;
        if (formato === 'pdf') {
            exportResult = await exportService.generarPDF(payload.exportRows, exportOptions);
        } else {
            exportResult = await exportService.generarXLSX(payload.exportRows, exportOptions);
        }

        return res.download(exportResult.filePath, exportResult.filename);
    } catch (error) {
        const status = getErrorStatus(error);
        if (status >= 500) {
            console.error('[Restaurante][Reportes] Error exportarReporte:', error.message);
        }
        return Respuesta.error(res, getErrorMessage(error, 'No se pudo exportar el reporte.'), status);
    }
}

async function getDetalleVentaPeriodo(req, res) {
    if (getValidationError(req, res)) return;

    try {
        const data = await reporteService.getDetalleVentaPeriodo({
            idUsuario: req.usuario.id_usuario,
            idNegocio: req.query.id_negocio,
            idOrden: req.params.id_orden,
        });

        return Respuesta.success(res, 'Detalle de venta obtenido', data);
    } catch (error) {
        const status = getErrorStatus(error);
        if (status >= 500) {
            console.error('[Restaurante][Reportes] Error getDetalleVentaPeriodo:', error.message);
        }
        return Respuesta.error(res, getErrorMessage(error, 'No se pudo obtener el detalle de la venta.'), status);
    }
}

module.exports = {
    getReportes,
    exportarReporte,
    getDetalleVentaPeriodo,
};
