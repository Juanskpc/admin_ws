'use strict';
/**
 * El comprador de una factura, tal como llega del cobro → la forma que se guarda en
 * `fe_documento.adquiriente`.
 *
 * Devolver `null` no es un error: significa «no dijeron a nombre de quién», y quien llama decide
 * si eso es consumidor final o un documento que espera datos (D10).
 */
const { normalizarDocumento, calcularDv, esDvValido } = require('../helpers/nit');

/** 13 cédula · 22 cédula de extranjería · 31 NIT · 41 pasaporte */
const TIPOS_DOCUMENTO = ['13', '22', '31', '41'];
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalido(mensaje) {
    const e = new Error(mensaje);
    e.code = 'FE_COMPRADOR_INVALIDO';
    e.statusCode = 422;
    return e;
}

const texto = (v) => {
    const t = v === null || v === undefined ? '' : String(v).trim();
    return t.length ? t : null;
};

function normalizarComprador(entrada) {
    if (entrada === null || entrada === undefined) return null;

    const tipoPersona = texto(entrada.tipo_persona);
    const tipoDocumento = texto(entrada.tipo_documento);
    if (!['1', '2'].includes(tipoPersona)) throw invalido('El tipo de persona del comprador no es válido.');
    if (!TIPOS_DOCUMENTO.includes(tipoDocumento)) throw invalido('El tipo de documento del comprador no es válido.');

    // Un pasaporte lleva letras: solo se limpia a dígitos lo que es numérico por definición.
    const numero = tipoDocumento === '41' ? texto(entrada.numero_documento) : normalizarDocumento(entrada.numero_documento);
    if (!numero) throw invalido('Falta el número de documento del comprador.');

    let dv = null;
    if (tipoDocumento === '31') {
        const esperado = calcularDv(numero);
        if (esperado === null) throw invalido('El NIT del comprador no es válido.');
        const recibido = texto(entrada.dv);
        if (recibido !== null && !esDvValido(numero, recibido)) {
            throw invalido(`El dígito de verificación no corresponde al NIT (debería ser ${esperado}).`);
        }
        dv = String(esperado);
    }

    const razonSocial = texto(entrada.razon_social);
    const nombres = texto(entrada.nombres);
    if (tipoPersona === '1' && !razonSocial) throw invalido('Falta la razón social del comprador.');
    if (tipoPersona === '2' && !nombres) throw invalido('Falta el nombre del comprador.');

    const correo = texto(entrada.correo);
    if (correo && !CORREO.test(correo)) throw invalido('El correo del comprador no es válido.');

    return {
        consumidor_final: false,
        tipo_persona: tipoPersona,
        tipo_documento: tipoDocumento,
        numero_documento: numero,
        dv,
        razon_social: tipoPersona === '1' ? razonSocial : null,
        nombres: tipoPersona === '2' ? nombres : null,
        correo,
        telefono: texto(entrada.telefono),
        direccion: texto(entrada.direccion),
    };
}

module.exports = { normalizarComprador };
