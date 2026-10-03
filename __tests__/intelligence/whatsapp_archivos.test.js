/**
 * Fotos, stickers y audios en la Bandeja (2026-10-02) — la parte que no toca la base.
 *
 *   - al recibir, se guarda la REFERENCIA del archivo (id de Meta, tipo, pie de foto), no el archivo;
 *   - al abrirlo, se le pide a Meta con el token del negocio (dos llamadas, las dos con token) y no
 *     se guarda nada; lo caducado (más de 7 días) y lo demasiado grande se rechazan con su código.
 *
 * Correr con:  npx jest __tests__/intelligence/whatsapp_archivos.test.js
 */
'use strict';

const { archivoDeMensaje } = require('../../intelligence/channels/whatsapp/adaptador');
const api = require('../../intelligence/channels/whatsapp/api');

describe('al recibir: la referencia del archivo, no el archivo', () => {
    test('una foto con pie guarda id, tipo y pie', () => {
        expect(
            archivoDeMensaje({
                type: 'image',
                image: { id: '1234567890', mime_type: 'image/jpeg', sha256: 'x', caption: 'el comprobante' },
            })
        ).toEqual({ id: '1234567890', mime: 'image/jpeg', caption: 'el comprobante' });
    });

    test('un sticker animado lo dice', () => {
        expect(archivoDeMensaje({ type: 'sticker', sticker: { id: '9', mime_type: 'image/webp', animated: true } }))
            .toEqual({ id: '9', mime: 'image/webp', animado: true });
    });

    test('un documento guarda su nombre', () => {
        expect(archivoDeMensaje({ type: 'document', document: { id: '5', mime_type: 'application/pdf', filename: 'factura.pdf' } }))
            .toEqual({ id: '5', mime: 'application/pdf', nombre: 'factura.pdf' });
    });

    test.each([
        [{ type: 'text', text: { body: 'hola' } }],
        [{ type: 'location', location: { latitude: 1, longitude: 2 } }],
        [{ type: 'reaction', reaction: { emoji: '👍' } }],
        [{ type: 'image', image: {} }],
    ])('sin archivo descargable → null', (m) => {
        expect(archivoDeMensaje(m)).toBeNull();
    });
});

describe('al abrirlo: se le pide a Meta, con el token del negocio', () => {
    const config = {
        leer: () => ({ token: 'TOKEN_GLOBAL', versionApi: 'v21.0', baseUrl: 'https://graph.test' }),
        tokenDeNegocio: (id) => (id === 6 ? 'TOKEN_ZONA' : null),
        numeroDeNegocio: (id) => (id === 6 ? '417195084805553' : null),
    };
    const respuesta = (status, cuerpo, headers = {}) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => cuerpo,
        body: status < 300 ? 'flujo' : null,
    });

    test('EL CASO: dos llamadas con el token del negocio; devuelve la descarga sin leerla', async () => {
        const llamadas = [];
        const fetchImpl = async (url, opciones) => {
            llamadas.push({ url, auth: opciones.headers.Authorization });
            return llamadas.length === 1
                ? respuesta(200, { url: 'https://lookaside.test/archivo', mime_type: 'image/jpeg', file_size: 1234 })
                : respuesta(200, null, { 'content-type': 'image/jpeg' });
        };

        const r = await api.obtenerArchivo({ idArchivo: '1234567890', idNegocio: 6, fetchImpl, config });

        expect(llamadas).toEqual([
            { url: 'https://graph.test/v21.0/1234567890?phone_number_id=417195084805553', auth: 'Bearer TOKEN_ZONA' },
            { url: 'https://lookaside.test/archivo', auth: 'Bearer TOKEN_ZONA' },
        ]);
        expect(r).toMatchObject({ mime: 'image/jpeg', bytes: 1234 });
        expect(r.respuesta.body).toBe('flujo');
    });

    test('caducado (más de 7 días) → ARCHIVO_NO_DISPONIBLE, sin reintento', async () => {
        const fetchImpl = async () => respuesta(400, { error: { message: 'invalid' } });
        await expect(api.obtenerArchivo({ idArchivo: 'viejo', idNegocio: 6, fetchImpl, config }))
            .rejects.toMatchObject({ code: 'ARCHIVO_NO_DISPONIBLE', reintentable: false });
    });

    test('más grande que el tope → ARCHIVO_DEMASIADO_GRANDE, y no se descarga', async () => {
        let llamadas = 0;
        const fetchImpl = async () => {
            llamadas += 1;
            return respuesta(200, { url: 'https://x', mime_type: 'video/mp4', file_size: api.MAX_BYTES_ARCHIVO + 1 });
        };
        await expect(api.obtenerArchivo({ idArchivo: 'grande', idNegocio: 6, fetchImpl, config }))
            .rejects.toMatchObject({ code: 'ARCHIVO_DEMASIADO_GRANDE' });
        expect(llamadas).toBe(1);
    });

    test('sin token propio usa el global (negocio con alta manual)', async () => {
        const auths = [];
        const fetchImpl = async (url, o) => {
            auths.push(o.headers.Authorization);
            return auths.length === 1 ? respuesta(200, { url: 'https://x' }) : respuesta(200, null);
        };
        await api.obtenerArchivo({ idArchivo: '1', idNegocio: 12, fetchImpl, config });
        expect(auths).toEqual(['Bearer TOKEN_GLOBAL', 'Bearer TOKEN_GLOBAL']);
    });
});
