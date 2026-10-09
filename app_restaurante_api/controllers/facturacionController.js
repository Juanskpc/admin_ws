/**
 * Lo que el restaurante ve de la facturación electrónica: si está activa, y la pestaña «Facturas»
 * de Caja (listar, ver el PDF, reintentar, completar los datos del comprador). R7.3 y R9.1 de
 * `docs/plan-fe-restaurante.md`.
 *
 * El restaurante no configura nada aquí: eso es del super admin. Estas rutas son la única vía por
 * la que la vertical lee documentos fiscales, y todas pasan por el módulo de facturación.
 */
'use strict';

const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const datosFiscales = require('../../app_core/facturacion/datosFiscales');
const configuracionDao = require('../../app_core/facturacion/configuracionDao');
const emisionService = require('../../app_core/facturacion/emisionService');
const { topeConsumidorFinal, MEDIOS_PAGO_DIAN } = require('../../app_core/facturacion/constantes');

/**
 * Valida, comprueba que el usuario opera en ese negocio y reenvía los errores de dominio.
 * La pertenencia se comprueba aquí a mano porque el middleware global puede ir en modo observación.
 */
function manejar(nombre, fn) {
    return async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 422, errors.array());

            const idNegocio = Number(req.query.id_negocio ?? req.body?.id_negocio);
            const principal = await resolverPrincipalUsuario(req.usuario?.id_usuario);
            if (!principal || !principal.puedeOperarEn(idNegocio)) {
                return Respuesta.error(res, 'No tienes acceso a este negocio', 403);
            }
            return await fn(req, res, idNegocio);
        } catch (err) {
            if (!err.statusCode) console.error(`[Restaurante/Facturacion] ${nombre}:`, err.message);
            return Respuesta.error(res, err.statusCode ? err.message : 'Error en la facturación electrónica.', err.statusCode || 500, {
                code: err.code,
            });
        }
    };
}

/** El documento, solo si es de ese negocio. No se distingue «no existe» de «no es tuyo». */
async function exigirDocumento(idDocumento, idNegocio) {
    const doc = await emisionService.obtenerDeNegocio(idDocumento, idNegocio);
    if (!doc) {
        const e = new Error('Documento no encontrado');
        e.code = 'FE_DOCUMENTO_NO_ENCONTRADO';
        e.statusCode = 404;
        throw e;
    }
    return doc;
}

const getEstado = manejar('getEstado', async (req, res, idNegocio) => {
    const [decision, ficha, catalogos] = await Promise.all([
        configuracionDao.debeFacturar(idNegocio),
        datosFiscales.obtener(idNegocio),
        datosFiscales.catalogos(),
    ]);
    return Respuesta.success(res, 'Estado de la facturación electrónica', {
        activa: decision.facturar,
        modo: ficha?.modo_facturacion ?? 'NINGUNO',
        ambiente: decision.config?.ambiente ?? null,
        tope_identificacion: topeConsumidorFinal(),
        motivo: decision.motivo,
        medios_pago: MEDIOS_PAGO_DIAN,
        // Los impuestos que se le pueden poner a un producto de la carta.
        impuestos: catalogos.impuestos.map((i) => ({ codigo: i.codigo, nombre: i.nombre, tarifa: Number(i.tarifa) })),
        // Solo tiene sentido avisar de los rangos a quien ya emite.
        alertas: decision.facturar ? await configuracionDao.alertasDe(idNegocio) : [],
    });
});

const listarDocumentos = manejar('listarDocumentos', async (req, res, idNegocio) => {
    const documentos = await emisionService.listar(idNegocio, {
        desde: req.query.desde || null,
        hasta: req.query.hasta || null,
        estado: req.query.estado || null,
    });
    return Respuesta.success(res, 'Documentos obtenidos', documentos);
});

const getPdf = manejar('getPdf', async (req, res, idNegocio) => {
    const doc = await exigirDocumento(req.params.id, idNegocio);
    const pdf = await emisionService.obtenerArchivo(doc.id_documento, 'PDF');
    res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${doc.numero || doc.id_documento}.pdf"`,
        'Cache-Control': 'private, no-store',
    });
    return res.send(pdf);
});

const reintentar = manejar('reintentar', async (req, res, idNegocio) => {
    const doc = await exigirDocumento(req.params.id, idNegocio);
    const final = await emisionService.reintentar(doc.id_documento);
    return Respuesta.success(res, 'Documento reenviado', emisionService.resumen(final));
});

const completarComprador = manejar('completarComprador', async (req, res, idNegocio) => {
    const doc = await exigirDocumento(req.params.id, idNegocio);
    const { id_negocio: _omitido, ...comprador } = req.body;
    await emisionService.completarComprador(doc.id_documento, comprador);
    const final = await emisionService.procesarDocumento(doc.id_documento, { forzar: true });
    return Respuesta.success(res, 'Datos del comprador guardados', emisionService.resumen(final));
});

module.exports = { getEstado, listarDocumentos, getPdf, reintentar, completarComprador };
