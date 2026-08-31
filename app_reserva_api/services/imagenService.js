'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Almacenamiento de imágenes del vertical `reserva` (logos y fotos de servicio).
 *
 * ## El nombre del archivo no es el que sube el usuario
 *
 * Un nombre que llega del cliente puede traer acentos, espacios, emojis o `../`. Aquí el nombre
 * se **construye**, no se sanea: `servicio_00007.webp`, `logo_00010.webp`. Es determinista (lo
 * fija el id de la entidad), predecible al depurar, y elimina de raíz cualquier travesía de
 * rutas — no hay nada del usuario en la ruta final.
 *
 * ## Por qué el archivo se sobrescribe en vez de acumular
 *
 * Con el nombre atado al id, subir una foto nueva pisa la anterior: no quedan huérfanos que
 * nadie va a borrar y el disco no crece con cada edición. Lo único que hay que limpiar son las
 * versiones con **otra extensión** (un `.jpg` viejo cuando el navegador ahora manda `.webp`), y
 * de eso se encarga `limpiarOtrasExtensiones`.
 *
 * El precio es que la URL no cambia, así que el navegador serviría la imagen vieja de su caché.
 * Por eso la URL devuelta lleva `?v=<timestamp>`.
 *
 * ## Compresión
 *
 * El recorte llega ya redimensionado y en WebP desde el navegador (el cropper exporta al ancho
 * de salida pedido con calidad 0.82). No se vuelve a comprimir en el servidor: hacerlo exigiría
 * `sharp` —una dependencia nativa pesada— para recomprimir algo que ya viene optimizado, y
 * cada recompresión de un formato con pérdida degrada un poco más.
 */

const BASE = path.resolve(path.join(__dirname, '..', '..', 'uploads', 'reserva'));

const TIPOS = {
    logo:     { carpeta: 'logos',     prefijo: 'logo' },
    servicio: { carpeta: 'servicios', prefijo: 'servicio' },
};

const EXTENSIONES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

function error(mensaje, statusCode = 400) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

/** Carpeta de un negocio para un tipo dado. Se crea si no existe. */
function directorio(tipo, idNegocio) {
    const cfg = TIPOS[tipo];
    if (!cfg) throw error('Tipo de imagen no válido.');
    const dir = path.join(BASE, cfg.carpeta, String(Number(idNegocio)));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** `servicio_00007.webp` — el id, con ceros a la izquierda para que ordene bien en el disco. */
function nombreArchivo(tipo, idEntidad, extension) {
    const cfg = TIPOS[tipo];
    return `${cfg.prefijo}_${String(Number(idEntidad)).padStart(5, '0')}.${extension}`;
}

/**
 * Borra las versiones del mismo id con otra extensión.
 *
 * Es lo que impide que un `.jpg` de antes conviva con el `.webp` nuevo y que la carpeta acumule
 * un archivo por cada formato que haya pasado por ahí.
 */
function limpiarOtrasExtensiones(dir, nombreActual, tipo, idEntidad) {
    const cfg = TIPOS[tipo];
    const raiz = `${cfg.prefijo}_${String(Number(idEntidad)).padStart(5, '0')}.`;
    try {
        for (const archivo of fs.readdirSync(dir)) {
            if (archivo !== nombreActual && archivo.startsWith(raiz)) {
                fs.unlinkSync(path.join(dir, archivo));
            }
        }
    } catch { /* limpieza best-effort: no debe tumbar una subida que ya funcionó */ }
}

/**
 * Guarda el buffer recibido y devuelve la URL pública.
 *
 * @returns {{ url: string, ruta: string, bytes: number }}
 */
function guardar({ tipo, idNegocio, idEntidad, buffer, mimetype }) {
    const extension = EXTENSIONES[mimetype];
    if (!extension) throw error('Formato no admitido. Usa WEBP, JPG o PNG.');
    if (!buffer?.length) throw error('El archivo llegó vacío.');

    const dir = directorio(tipo, idNegocio);
    const nombre = nombreArchivo(tipo, idEntidad, extension);
    const ruta = path.join(dir, nombre);

    fs.writeFileSync(ruta, buffer);
    limpiarOtrasExtensiones(dir, nombre, tipo, idEntidad);

    const carpeta = TIPOS[tipo].carpeta;
    return {
        // `?v=` invalida la caché: el nombre es fijo, así que sin esto el navegador seguiría
        // mostrando la imagen anterior tras reemplazarla.
        url: `/uploads/reserva/${carpeta}/${Number(idNegocio)}/${nombre}?v=${Date.now()}`,
        ruta,
        bytes: buffer.length,
    };
}

/**
 * Borra del disco la imagen de una entidad, sea cual sea su extensión.
 *
 * Se llama al quitar la foto y al eliminar el servicio: un registro borrado en la base y su
 * archivo suelto en el disco es exactamente el tipo de basura que nadie encuentra después.
 */
function eliminar({ tipo, idNegocio, idEntidad }) {
    try {
        const dir = directorio(tipo, idNegocio);
        limpiarOtrasExtensiones(dir, null, tipo, idEntidad);
        return true;
    } catch {
        return false;
    }
}

module.exports = { guardar, eliminar, directorio, nombreArchivo, TIPOS, EXTENSIONES };
