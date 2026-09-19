/**
 * Cifra y descifra credenciales de terceros que EscalApp custodia por negocio (Embedded Signup
 * de WhatsApp hoy; facturación electrónica más adelante, cuando `fe_configuracion` exista).
 *
 * ## Por qué es genérico y no `whatsappCifrado.js`
 *
 * El día que la facturación electrónica guarde credenciales por negocio va a necesitar exactamente
 * esto: cifrar un texto, guardarlo, descifrarlo al leer. Es texto → texto, sin saber qué tabla lo
 * llama ni qué representa el secreto — así se puede compartir sin acoplar los dos módulos entre sí.
 *
 * ## Por qué AES-256-GCM y una clave de entorno, no un KMS
 *
 * Decisión explícita: un KMS gestionado añadiría una pieza de infraestructura que hoy no existe
 * (1 vCPU, un solo dev). GCM da autenticación además de cifrado — si alguien manipula el texto
 * cifrado en la base, `descifrar()` falla en vez de devolver basura silenciosamente.
 */
'use strict';
const crypto = require('crypto');

const ALGORITMO = 'aes-256-gcm';
const LONGITUD_IV = 12; // recomendado para GCM
const LONGITUD_TAG = 16;

function fallo(mensaje, code) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = 500;
    return e;
}

function leerClave() {
    const clave = process.env.WHATSAPP_TOKEN_KEY;
    if (!clave) {
        throw fallo(
            'Falta WHATSAPP_TOKEN_KEY: sin ella no se puede cifrar ni descifrar ninguna credencial.',
            'CIFRADO_CLAVE_FALTANTE'
        );
    }
    const buffer = Buffer.from(clave, 'base64');
    if (buffer.length !== 32) {
        throw fallo(
            'WHATSAPP_TOKEN_KEY debe decodificar a 32 bytes en base64 (AES-256). ' +
                `Decodificó a ${buffer.length}.`,
            'CIFRADO_CLAVE_INVALIDA'
        );
    }
    return buffer;
}

/**
 * @param {string} textoPlano
 * @returns {string} un solo string base64: iv (12) + authTag (16) + cifrado, concatenados.
 */
function cifrar(textoPlano) {
    if (typeof textoPlano !== 'string' || !textoPlano) {
        throw fallo('No hay nada que cifrar.', 'CIFRADO_TEXTO_VACIO');
    }
    const clave = leerClave();
    const iv = crypto.randomBytes(LONGITUD_IV);
    const cipher = crypto.createCipheriv(ALGORITMO, clave, iv);
    const cifrado = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, cifrado]).toString('base64');
}

/**
 * @param {string} textoCifrado — lo que devolvió `cifrar()`.
 * @returns {string} el texto plano original.
 * @throws si la clave no coincide o el texto fue manipulado — GCM lo detecta, no lo adivina.
 */
function descifrar(textoCifrado) {
    if (typeof textoCifrado !== 'string' || !textoCifrado) {
        throw fallo('No hay nada que descifrar.', 'CIFRADO_TEXTO_VACIO');
    }
    const clave = leerClave();
    let datos;
    try {
        datos = Buffer.from(textoCifrado, 'base64');
    } catch {
        throw fallo('El texto cifrado no es base64 válido.', 'CIFRADO_FORMATO_INVALIDO');
    }
    if (datos.length < LONGITUD_IV + LONGITUD_TAG) {
        throw fallo('El texto cifrado es demasiado corto para contener iv + authTag.', 'CIFRADO_FORMATO_INVALIDO');
    }
    const iv = datos.subarray(0, LONGITUD_IV);
    const authTag = datos.subarray(LONGITUD_IV, LONGITUD_IV + LONGITUD_TAG);
    const cifrado = datos.subarray(LONGITUD_IV + LONGITUD_TAG);

    const decipher = crypto.createDecipheriv(ALGORITMO, clave, iv);
    decipher.setAuthTag(authTag);
    try {
        const textoPlano = Buffer.concat([decipher.update(cifrado), decipher.final()]);
        return textoPlano.toString('utf8');
    } catch {
        // GCM lanza aquí si la clave no coincide o el texto fue alterado. No decir cuál de las
        // dos: un mensaje que distinga "clave mala" de "dato corrupto" ayuda a quien ataca más
        // que a quien depura.
        throw fallo('No se pudo descifrar: clave incorrecta o texto corrupto.', 'CIFRADO_FALLO_VERIFICACION');
    }
}

module.exports = { cifrar, descifrar };
