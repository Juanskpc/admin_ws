'use strict';
/**
 * Puerto de proveedores de facturación electrónica.
 *
 * Todo adaptador exporta:
 *   codigo: string                                   'FACTUS'
 *   probarConexion({ credenciales, ambiente })       → { nit, dv, razon_social }
 *   listarRangos({ credenciales, ambiente })         → [RangoProveedor]
 *   listarRangosDian({ credenciales, ambiente })     → [{ prefijo, resolucion, desde, hasta,
 *                                                         vigenciaDesde, vigenciaHasta }]
 *   crearRango({ credenciales, ambiente, tipoDocumento: 'FV'|'NC', prefijo, resolucion, actual })
 *                                                    → { id, prefijo, actual }
 *   emitirFactura({ credenciales, ambiente, documento, lineas, idRango, enviarCorreo })
 *                                                    → ResultadoEmision
 *   consultarPorReferencia({ credenciales, ambiente, codigoReferencia })
 *                                                    → ResultadoEmision | null (null = no existe)
 *   eliminarPendiente({ credenciales, ambiente, codigoReferencia }) → void
 *   descargarArchivo({ credenciales, ambiente, numero, tipo: 'PDF'|'XML', documento: 'FV'|'NC' })
 *                                                    → Buffer
 *   emitirNotaCredito({ credenciales, ambiente, documento, lineas, facturaReferencia, idRango })
 *                                                    → ResultadoEmision          (R10.1)
 *
 * ResultadoEmision = {
 *   resultado: 'ACEPTADO' | 'PENDIENTE_DIAN' | 'RECHAZADO' | 'BLOQUEADO_PENDIENTE'
 *            | 'ERROR_CREDENCIALES' | 'ERROR_PROVEEDOR' | 'ERROR_RED',
 *   httpStatus: number | null,
 *   numero, cufe, fechaValidacion, urlPublica, urlQr,   // null salvo ACEPTADO
 *   avisos: [{ codigo, mensaje }], rechazos: [{ codigo, mensaje }],
 *   payload: object,      // lo que se envió (sin credenciales)
 *   respuesta: object,    // lo que contestó, tal cual
 *   mensaje: string,      // una frase legible para una persona
 * }
 *
 * RangoProveedor = { id, prefijo, desde, hasta, actual, resolucion,
 *                    vigenciaDesde, vigenciaHasta, vencido, tipoDocumento }
 *
 * Los adaptadores NO tocan la base de datos. Reciben todo por parámetro y devuelven datos.
 */
const factus = require('./factus');

const ADAPTADORES = new Map([[factus.codigo, factus]]);

function getProveedor(codigo) {
    const a = ADAPTADORES.get(codigo);
    if (!a) {
        const e = new Error(`Proveedor de facturación desconocido: ${codigo}`);
        e.code = 'FE_PROVEEDOR_DESCONOCIDO';
        e.statusCode = 500;
        throw e;
    }
    return a;
}

module.exports = { getProveedor };
