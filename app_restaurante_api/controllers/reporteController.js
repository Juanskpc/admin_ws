const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const reporteService = require('../services/reporteService');
// El exportador propio del restaurante: sabe el tipo de cada columna, así que puede dar
// formato al dinero y a las fechas. El genérico del parqueadero volcaba el valor crudo.
const exportService = require('../services/reporteExportService');

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
            // Lista o CSV: el frontend los pone en la URL para que el reporte sea enlazable.
            idsProducto: req.query.id_producto,
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
            idsProducto: req.query.id_producto,
        });

        const slugNegocio = buildSlugFromNegocio(payload.negocio.nombre);
        // Se mandan las filas CRUDAS (no `exportRows`, que son texto ya aplanado) junto con la
        // definición de las columnas: el exportador da el formato y, en el Excel, las cifras
        // llegan como números que se pueden sumar.
        const exportOptions = {
            slugNegocio,
            tipoReporte: payload.tipo,
            titulo: payload.titulo,
            nombreNegocio: payload.negocio.nombre,
            periodo: payload.periodo,
            columnas: payload.columns,
            filas: payload.rows,
            resumenItems: payload.resumenItems,
            desglosePago: payload.desglosePago,
        };

        if (formato === 'pdf') {
            const { buffer, filename } = await exportService.generarPDFBuffer(exportOptions);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(buffer);
        }

        const { buffer, filename } = await exportService.generarXLSXBuffer(exportOptions);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(buffer);
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

async function getCatalogoProductos(req, res) {
    if (getValidationError(req, res)) return;

    try {
        const data = await reporteService.getCatalogoProductos({
            idUsuario: req.usuario.id_usuario,
            idNegocio: req.query.id_negocio,
        });

        return Respuesta.success(res, 'Catalogo de productos', data);
    } catch (error) {
        const status = getErrorStatus(error);
        if (status >= 500) {
            console.error('[Restaurante][Reportes] Error getCatalogoProductos:', error.message);
        }
        return Respuesta.error(res, getErrorMessage(error, 'No se pudo cargar el catalogo de productos.'), status);
    }
}

module.exports = {
    getReportes,
    exportarReporte,
    getDetalleVentaPeriodo,
    getCatalogoProductos,
};
