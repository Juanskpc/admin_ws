/**
 * Adaptador de Factus (R2.2–R2.4 de `docs/plan-fe-restaurante.md`). Sin base y sin red: `fetch`
 * está simulado. Los cuerpos son recortes de respuestas reales del sandbox
 * (`scripts/factus_sondeo.js`, 2026-10-08).
 *
 * Correr con:  npx jest __tests__/facturacion/proveedor_factus.test.js
 */
'use strict';

const factus = require('../../app_core/facturacion/proveedores/factus');
const { getProveedor } = require('../../app_core/facturacion/proveedores');

const CREDENCIALES = {
    client_id: 'cliente-de-prueba',
    client_secret: 'SECRETO-QUE-NO-DEBE-SALIR',
    username: 'pruebas@escalapp.cloud',
    password: 'CLAVE-QUE-NO-DEBE-SALIR',
};

const VALIDADA = {
    status: 'Created',
    message: 'Documento con el código de referencia EAP1-FV-10 registrado y validado con éxito',
    data: {
        reference_code: 'EAP1-FV-10',
        number: 'SETP990024139',
        is_validated: true,
        validated_at: '08-10-2026 09:23:26 PM',
        errors: {
            FAJ43b: 'Regla: FAJ43b, Notificación: Nombre informado No corresponde al registrado en el RUT con respecto al Nit suministrado.',
            RUT01: 'Regla: RUT01, Notificación: La validación del estado del RUT próximamente estará disponible',
        },
        totals: { total: '6000.00' },
        cufe: '9da991158fc3f7989a29c02e6f4993e5',
        links: {
            qr: 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=9da9',
            public_url: 'https://app-sandbox.factus.com.co/documents/bills/0189',
        },
    },
};

const documento = (adquiriente) => ({
    codigo_referencia: 'EAP1-FV-10',
    origen_referencia: 'ORD-0010',
    adquiriente: adquiriente || { consumidor_final: true },
    pagos: [{ codigo_dian: '10', valor: 50500 }],
});

const lineas = [
    {
        codigo: 'HAMB',
        descripcion: 'Hamburguesa sencilla',
        cantidad: 2,
        precio_neto: 20370.37,
        codigo_impuesto: '04',
        tarifa_impuesto: 8,
        unidad_medida: '94',
    },
    {
        codigo: 'LIMO',
        descripcion: 'Limonada natural',
        cantidad: 1,
        precio_neto: 6018.52,
        codigo_impuesto: 'ZZ',
        tarifa_impuesto: 0,
        unidad_medida: 'HUR',
    },
];

const respuesta = (status, cuerpo) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (cuerpo === undefined ? '' : JSON.stringify(cuerpo)),
});
const token = () => respuesta(200, { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });

const emitir = (extra = {}) =>
    factus.emitirFactura({
        credenciales: CREDENCIALES,
        ambiente: 'PRUEBAS',
        documento: documento(),
        lineas,
        idRango: 389,
        enviarCorreo: true,
        ...extra,
    });

let fetchOriginal;
beforeEach(() => {
    fetchOriginal = global.fetch;
    global.fetch = jest.fn();
    factus.olvidarTokens();
});
afterEach(() => {
    global.fetch = fetchOriginal;
});

describe('clasificar', () => {
    test.each([
        ['un fallo de red', { status: null, cuerpo: null, errorRed: 'TimeoutError' }, 'ERROR_RED'],
        ['credenciales que Factus no acepta', { status: 401, cuerpo: null }, 'ERROR_CREDENCIALES'],
        ['otra factura pendiente', { status: 409, cuerpo: { message: 'Se encontró una factura pendiente' } }, 'BLOQUEADO_PENDIENTE'],
        [
            'un rechazo de validación',
            { status: 422, cuerpo: { message: 'Error de validación', data: { errors: { 'customer.names': ['El campo nombres es obligatorio.'] } } } },
            'RECHAZADO',
        ],
        ['el proveedor caído', { status: 503, cuerpo: { crudo: '<html>' } }, 'ERROR_PROVEEDOR'],
        ['demasiadas peticiones', { status: 429, cuerpo: null }, 'ERROR_PROVEEDOR'],
        [
            'un rechazo de la DIAN',
            { status: 201, cuerpo: { data: { number: 'SETP1', is_validated: false, errors: { FAD06: 'Regla: FAD06, Rechazo: la fecha no es válida' } } } },
            'RECHAZADO',
        ],
        ['la DIAN que va lenta', { status: 201, cuerpo: { data: { number: 'SETP1', is_validated: false, errors: {} } } }, 'PENDIENTE_DIAN'],
        ['una factura validada', { status: 201, cuerpo: VALIDADA }, 'ACEPTADO'],
    ])('%s', (_nombre, entrada, esperado) => {
        expect(factus.clasificar(entrada).resultado).toBe(esperado);
    });

    test('una validada trae número, CUFE, enlaces y los avisos aparte de los rechazos', () => {
        const r = factus.clasificar({ status: 201, cuerpo: VALIDADA });
        expect(r).toMatchObject({
            numero: 'SETP990024139',
            cufe: '9da991158fc3f7989a29c02e6f4993e5',
            urlPublica: 'https://app-sandbox.factus.com.co/documents/bills/0189',
            rechazos: [],
        });
        expect(r.urlQr).toMatch(/searchqr/);
        expect(r.avisos.map((a) => a.codigo)).toEqual(['FAJ43b', 'RUT01']);
    });

    test('la fecha de Factus es día-mes-año en hora de Bogotá, no mes-día', () => {
        const r = factus.clasificar({ status: 201, cuerpo: VALIDADA });
        expect(r.fechaValidacion).toBe('2026-10-08T21:23:26-05:00');
        expect(factus.fechaDeFactus('01-01-2027 12:05:00 AM')).toBe('2027-01-01T00:05:00-05:00');
        expect(factus.fechaDeFactus('cualquier cosa')).toBeNull();
    });

    test('el rechazo de validación dice qué campo falló', () => {
        const r = factus.clasificar({
            status: 422,
            cuerpo: { data: { errors: { 'customer.names': ['El campo nombres es obligatorio.'] } } },
        });
        expect(r.rechazos).toEqual([{ codigo: 'customer.names', mensaje: 'El campo nombres es obligatorio.' }]);
        expect(r.mensaje).toMatch(/nombres es obligatorio/);
    });
});

describe('sesión con Factus', () => {
    test('ante un 401 pide otro token y repite una vez', async () => {
        global.fetch
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(respuesta(401, { message: 'Unauthenticated.' }))
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(respuesta(201, VALIDADA));
        const r = await emitir();
        expect(r.resultado).toBe('ACEPTADO');
        expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    test('dos emisiones seguidas comparten el token', async () => {
        global.fetch
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(respuesta(201, VALIDADA))
            .mockResolvedValueOnce(respuesta(201, VALIDADA));
        await emitir();
        await emitir();
        const aToken = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'));
        expect(aToken).toHaveLength(1);
    });

    test('dos negocios no comparten sesión', async () => {
        global.fetch.mockImplementation(async (url) =>
            String(url).endsWith('/oauth/token') ? token() : respuesta(201, VALIDADA)
        );
        await emitir();
        await emitir({ credenciales: { ...CREDENCIALES, username: 'otro@negocio.co' } });
        const aToken = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'));
        expect(aToken).toHaveLength(2);
    });

    test('un timeout no lanza: es ERROR_RED', async () => {
        const corte = new Error('The operation was aborted');
        corte.name = 'AbortError';
        global.fetch.mockResolvedValueOnce(token()).mockRejectedValueOnce(corte);
        const r = await emitir();
        expect(r.resultado).toBe('ERROR_RED');
        expect(r.payload.reference_code).toBe('EAP1-FV-10');
    });

    test('credenciales malas no lanzan: es ERROR_CREDENCIALES', async () => {
        global.fetch.mockResolvedValue(respuesta(400, { error: 'invalid_grant', error_description: 'x' }));
        const r = await emitir();
        expect(r.resultado).toBe('ERROR_CREDENCIALES');
    });

    test('el ambiente PRODUCCION está prohibido fuera de producción', async () => {
        await expect(emitir({ ambiente: 'PRODUCCION' })).rejects.toMatchObject({ code: 'FE_AMBIENTE_PROHIBIDO' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('ningún error ni resultado lleva la contraseña o el secreto', async () => {
        global.fetch.mockResolvedValue(respuesta(401, { error: 'invalid_client', message: 'Client authentication failed' }));
        const r = await emitir();
        const error = await factus.probarConexion({ credenciales: CREDENCIALES, ambiente: 'PRUEBAS' }).catch((e) => e);
        const todo = JSON.stringify(r) + error.message + error.stack;
        expect(error.code).toBe('FE_CREDENCIALES_INVALIDAS');
        expect(todo).not.toContain(CREDENCIALES.password);
        expect(todo).not.toContain(CREDENCIALES.client_secret);
    });
});

describe('traducirFactura', () => {
    const traducir = (adquiriente, enviarCorreo = true) =>
        factus.traducirFactura({ documento: documento(adquiriente), lineas, idRango: 389, enviarCorreo });

    test('consumidor final: el comprador genérico y sin correo', () => {
        const f = traducir();
        expect(f.customer).toEqual({
            identification_document_code: '13',
            identification: '222222222222',
            names: 'Consumidor Final',
            legal_organization_code: '2',
        });
        expect(f.send_email).toBe(false);
        expect(f).toMatchObject({ reference_code: 'EAP1-FV-10', document: '01', numbering_range_id: 389 });
        expect(f.payment_details).toEqual([{ payment_form: '1', payment_method_code: '10', amount: '50500.00' }]);
    });

    test('las líneas: neto con dos decimales, impuesto o excluido, y la unidad no confirmada va como 94', () => {
        const [hamb, limo] = traducir().items;
        expect(hamb).toMatchObject({ price: '20370.37', quantity: '2.00', taxes: [{ code: '04', rate: '8.00' }] });
        expect(limo.taxes).toEqual([{ is_excluded: true }]);
        expect(limo.unit_measure_code).toBe('94');
    });

    test('una empresa: NIT con DV y razón social', () => {
        const f = traducir({
            consumidor_final: false,
            tipo_persona: '1',
            tipo_documento: '31',
            numero_documento: '900123456',
            dv: '8',
            razon_social: 'Empresa Prueba SAS',
            nombres: null,
            correo: 'compras@empresa.co',
            telefono: null,
            direccion: null,
        });
        expect(f.customer).toEqual({
            identification_document_code: '31',
            identification: '900123456',
            dv: '8',
            company: 'Empresa Prueba SAS',
            legal_organization_code: '1',
            email: 'compras@empresa.co',
        });
        // El correo lo manda EscalApp, nunca el proveedor: si no, el cliente recibiría dos.
        expect(f.send_email).toBe(false);
    });

    test('con correo pero con el envío apagado en el negocio, no se envía', () => {
        const f = traducir(
            { consumidor_final: false, tipo_persona: '2', tipo_documento: '13', numero_documento: '1', nombres: 'A', correo: 'a@b.co' },
            false
        );
        expect(f.send_email).toBe(false);
    });
});

describe('lo demás del puerto', () => {
    test('consultarPorReferencia: null si Factus no tiene esa referencia', async () => {
        global.fetch
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(respuesta(200, { data: { data: [], pagination: { last_page: 1 } } }));
        const r = await factus.consultarPorReferencia({
            credenciales: CREDENCIALES,
            ambiente: 'PRUEBAS',
            codigoReferencia: 'EAP1-FV-10',
        });
        expect(r).toBeNull();
    });

    test('consultarPorReferencia: si está, trae el documento entero por su número', async () => {
        global.fetch
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(
                respuesta(200, { data: { data: [{ number: 'SETP990024139', reference_code: 'EAP1-FV-10' }] } })
            )
            .mockResolvedValueOnce(respuesta(200, VALIDADA));
        const r = await factus.consultarPorReferencia({
            credenciales: CREDENCIALES,
            ambiente: 'PRUEBAS',
            codigoReferencia: 'EAP1-FV-10',
        });
        expect(r).toMatchObject({ resultado: 'ACEPTADO', numero: 'SETP990024139' });
        expect(String(global.fetch.mock.calls[2][0])).toMatch(/\/v2\/bills\/SETP990024139$/);
    });

    test('listarRangos: solo los activos, con el tipo traducido', async () => {
        const rango = (extra) => ({
            id: 389,
            document: 'Factura de Venta',
            prefix: 'SETP',
            from: 990000000,
            to: 995000000,
            current: 990019105,
            resolution_number: '18760000001',
            start_date: '2019-01-19',
            end_date: '2030-01-19',
            is_expired: false,
            is_active: true,
            deleted_at: null,
            ...extra,
        });
        global.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(
            respuesta(200, {
                data: {
                    data: [
                        rango(),
                        rango({ id: 1776, document: 'Nota Crédito', prefix: 'CRTE' }),
                        rango({ id: 5, document: 'Documento Soporte' }),
                        rango({ id: 6, is_active: false }),
                    ],
                    pagination: { last_page: 1 },
                },
            })
        );
        const rangos = await factus.listarRangos({ credenciales: CREDENCIALES, ambiente: 'PRUEBAS' });
        expect(rangos.map((r) => [r.id, r.tipoDocumento])).toEqual([
            [389, 'FV'],
            [1776, 'NC'],
            [5, null],
        ]);
        expect(rangos[0]).toMatchObject({ prefijo: 'SETP', actual: 990019105, vencido: false, vigenciaHasta: '2030-01-19' });
    });

    test('descargarArchivo devuelve los bytes, o un error tipado si no vienen', async () => {
        global.fetch
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(respuesta(200, { data: { pdf_base_64_encoded: Buffer.from('%PDF-1.4').toString('base64') } }))
            .mockResolvedValueOnce(respuesta(404, { message: 'No encontrado' }));
        const args = { credenciales: CREDENCIALES, ambiente: 'PRUEBAS', numero: 'SETP1' };
        expect((await factus.descargarArchivo({ ...args, tipo: 'PDF' })).toString()).toBe('%PDF-1.4');
        await expect(factus.descargarArchivo({ ...args, tipo: 'XML' })).rejects.toMatchObject({
            code: 'FE_ARCHIVO_NO_DISPONIBLE',
        });
    });

    test('crearRango: la factura lleva resolución y la nota crédito no', async () => {
        global.fetch.mockImplementation(async (url) =>
            String(url).endsWith('/oauth/token') ? token() : respuesta(201, { data: { id: 3021, prefix: 'FE', current: 1001 } })
        );
        const base = { credenciales: CREDENCIALES, ambiente: 'PRUEBAS' };
        const creado = await factus.crearRango({ ...base, tipoDocumento: 'FV', prefijo: 'FE', resolucion: '18764116756455', actual: 1001 });
        expect(creado).toEqual({ id: 3021, prefijo: 'FE', actual: 1001 });
        await factus.crearRango({ ...base, tipoDocumento: 'NC', prefijo: 'NC', actual: 90 });

        const cuerpos = global.fetch.mock.calls
            .filter(([url]) => String(url).endsWith('/v2/numbering-ranges'))
            .map(([, opciones]) => JSON.parse(opciones.body));
        expect(cuerpos).toEqual([
            { document: '21', prefix: 'FE', current: '1001', resolution_number: '18764116756455' },
            { document: '22', prefix: 'NC', current: '90' },
        ]);
    });

    test('crearRango: si Factus no lo crea, el error dice por qué', async () => {
        global.fetch
            .mockResolvedValueOnce(token())
            .mockResolvedValueOnce(respuesta(422, { data: { errors: { prefix: ['El prefijo no está asociado en la DIAN.'] } } }));
        await expect(
            factus.crearRango({ credenciales: CREDENCIALES, ambiente: 'PRUEBAS', tipoDocumento: 'FV', prefijo: 'XX', resolucion: '1', actual: 1 })
        ).rejects.toMatchObject({ code: 'FE_RANGO_NO_CREADO', statusCode: 422, message: expect.stringMatching(/no está asociado/) });
    });

    test('listarRangosDian traduce lo que la DIAN tiene asociado', async () => {
        global.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(
            respuesta(200, {
                data: [{ prefix: 'FE', resolution_number: 18764116756455, from: 1001, to: 1500, start_date: '2026-10-06', end_date: '2028-10-06' }],
            })
        );
        expect(await factus.listarRangosDian({ credenciales: CREDENCIALES, ambiente: 'PRUEBAS' })).toEqual([
            { prefijo: 'FE', resolucion: '18764116756455', desde: 1001, hasta: 1500, vigenciaDesde: '2026-10-06', vigenciaHasta: '2028-10-06' },
        ]);
    });

    test('el registro conoce a FACTUS y a nadie más', () => {
        expect(getProveedor('FACTUS')).toBe(factus);
        expect(() => getProveedor('OTRO')).toThrow(expect.objectContaining({ code: 'FE_PROVEEDOR_DESCONOCIDO' }));
    });
});
