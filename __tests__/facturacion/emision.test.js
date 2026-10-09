/**
 * Servicio de emisión (R4.1–R4.6 de `docs/plan-fe-restaurante.md`), con el proveedor simulado.
 *
 * Requiere `npm run migrate:facturacion` y `npm run migrate:facturacion-emision`.
 *
 * Correr contra la base LOCAL (compara `now()` de Postgres con el reloj del PC):
 *   DB_PORT=5432 npx jest __tests__/facturacion/emision.test.js --forceExit
 *
 * Lo que se comprueba es lo que no puede fallar en producción: que **la venta nunca se entera**
 * de un problema de facturación, que **un pedido no se factura dos veces**, y que un documento
 * que no pudo salir **vuelve a intentarse solo**.
 */
'use strict';
require('dotenv').config();

// Antes de cargar cualquier módulo: `features` lee la escotilla al importarse.
process.env.FEATURES_FORZADAS = 'facturacion_electronica';
process.env.WHATSAPP_TOKEN_KEY ||= require('crypto').randomBytes(32).toString('base64');

jest.mock('../../app_core/facturacion/proveedores', () => {
    const adaptador = {
        codigo: 'FACTUS',
        emitirFactura: jest.fn(),
        emitirNotaCredito: jest.fn(),
        consultarPorReferencia: jest.fn(),
        eliminarPendiente: jest.fn(),
        descargarArchivo: jest.fn(),
    };
    return { getProveedor: () => adaptador, adaptador };
});

jest.mock('../../app_admin_api/services/mailService', () => ({ sendHtmlEmail: jest.fn(async () => true) }));

const db = require('../../app_core/models/conection');
const MailService = require('../../app_admin_api/services/mailService');
const { adaptador } = require('../../app_core/facturacion/proveedores');
const configuracionDao = require('../../app_core/facturacion/configuracionDao');
const emision = require('../../app_core/facturacion/emisionService');
const { alCobrarPedido } = require('../../app_core/facturacion');

const sequelize = db.sequelize;
const SELECT = sequelize.QueryTypes.SELECT;
const CREDENCIALES = { client_id: 'id', client_secret: 'secreto', username: 'u@prueba.co', password: 'clave' };

let idNegocio;
let idUsuario;
let idPuntoCaja;
let idProducto;
let secuencia = 0;

const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: SELECT });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Un pedido con una sola línea de `precio`, ya cobrado salvo que se diga otra cosa. */
async function crearPedido({ precio = 20000, estadoPago = 'pagado', estado = 'CERRADA', haceMinutos = 0 } = {}) {
    secuencia += 1;
    const [o] = await q(
        `INSERT INTO restaurante.pedid_orden
             (id_negocio, id_usuario, numero_orden, subtotal, total, estado, estado_pago, id_punto_caja, fecha_creacion)
         VALUES (:idNegocio, :idUsuario, :numero, :precio, :precio, :estado, :estadoPago, :idPuntoCaja,
                 now()::timestamp - make_interval(mins => :haceMinutos))
         RETURNING id_orden;`,
        { idNegocio, idUsuario, numero: `FE2-${secuencia}`, precio, estado, estadoPago, idPuntoCaja, haceMinutos }
    );
    await q(
        `INSERT INTO restaurante.pedid_detalle (id_orden, id_producto, cantidad, precio_unitario, subtotal)
         VALUES (:idOrden, :idProducto, 1, :precio, :precio) RETURNING id_detalle;`,
        { idOrden: o.id_orden, idProducto, precio }
    );
    return o.id_orden;
}

const documentoDe = async (idOrden, tipo = 'FV') =>
    (await q(`SELECT * FROM facturacion.fe_documento WHERE id_negocio = :idNegocio AND origen_id = :id AND tipo = :tipo;`, {
        idNegocio,
        id: String(idOrden),
        tipo,
    }))[0];

const aceptado = (numero = 'SETP1') => ({
    resultado: 'ACEPTADO',
    httpStatus: 201,
    numero,
    cufe: `cufe-${numero}`,
    fechaValidacion: '2026-10-08T21:23:26-05:00',
    urlPublica: `https://factus.test/${numero}`,
    urlQr: `https://dian.test/${numero}`,
    avisos: [{ codigo: 'RUT01', mensaje: 'aviso' }],
    rechazos: [],
    payload: { reference_code: 'x' },
    respuesta: { data: { number: numero } },
    mensaje: 'validado',
});
const fallido = (resultado, extra = {}) => ({
    resultado,
    httpStatus: null,
    numero: null,
    cufe: null,
    fechaValidacion: null,
    urlPublica: null,
    urlQr: null,
    avisos: [],
    rechazos: [],
    payload: { reference_code: 'x' },
    respuesta: null,
    mensaje: `falló: ${resultado}`,
    ...extra,
});

beforeAll(async () => {
    idUsuario = (await q(`SELECT min(id_usuario) AS id FROM general.gener_usuario;`))[0].id;
    idNegocio = (await q(`INSERT INTO general.gener_negocio (nombre, estado) VALUES ('TEST FE-2 emisión (borrar)', 'A') RETURNING id_negocio;`))[0].id_negocio;
    await q(
        `INSERT INTO general.gener_negocio_fiscal
             (id_negocio, estado_registro, modo_facturacion, tipo_persona, tipo_documento, numero_documento, dv,
              razon_social, responsabilidades_fiscales, tributos, responsable_inc, direccion_fiscal,
              municipio_dane, departamento_dane, correo_facturacion)
         VALUES (:idNegocio, 'REGISTRADO', 'POS', '1', '31', '800197268', '4', 'NEGOCIO DE PRUEBA S.A.S.',
                 ARRAY['R-99-PN'], ARRAY['ZZ'], false, 'Calle 1 # 2-3', '05001', '05', 'fe@ejemplo.test')
         ON CONFLICT (id_negocio) DO NOTHING RETURNING id_negocio;`,
        { idNegocio }
    );
    idPuntoCaja = (await q(`INSERT INTO restaurante.rest_punto_caja (id_negocio, nombre) VALUES (:idNegocio, 'Caja FE') RETURNING id_punto_caja;`, { idNegocio }))[0].id_punto_caja;
    const idCategoria = (await q(`INSERT INTO restaurante.carta_categoria (id_negocio, nombre) VALUES (:idNegocio, 'FE') RETURNING id_categoria;`, { idNegocio }))[0].id_categoria;
    idProducto = (await q(`INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio) VALUES (:idNegocio, :idCategoria, 'Hamburguesa', 20000) RETURNING id_producto;`, { idNegocio, idCategoria }))[0].id_producto;

    // La mayoría de la suite prueba el envío en sí, así que el negocio lo factura todo; el
    // caso por defecto —solo lo que se pide— tiene su propio bloque más abajo.
    await configuracionDao.guardar(idNegocio, { credenciales: CREDENCIALES, facturar_todo: true });
    const rangos = await configuracionDao.guardarRangos(idNegocio, [
        { id: 389, tipoDocumento: 'FV', prefijo: 'SETP', desde: 990000000, hasta: 995000000, actual: 990000010, vencido: false },
        { id: 1776, tipoDocumento: 'NC', prefijo: 'CRTE', vencido: false },
        { id: 2058, tipoDocumento: null, prefijo: 'SEDS', vencido: false },
    ]);
    for (const r of rangos) await configuracionDao.usarRango(idNegocio, r.id_resolucion);
    await configuracionDao.cambiarEstado(idNegocio, 'EN_PRUEBAS', idUsuario);
});

afterAll(async () => {
    await esperar(300); // deja terminar el archivado que queda en vuelo tras un ACEPTADO
    if (idNegocio) {
        await sequelize.transaction(async (t) => {
            const borrar = (sql) => sequelize.query(sql, { replacements: { idNegocio }, transaction: t });
            await borrar(`SET LOCAL facturacion.permitir_borrado_pruebas = 'on';`);
            await borrar(`DELETE FROM facturacion.fe_intento WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM facturacion.fe_documento_linea WHERE id_negocio = :idNegocio;`);
            await borrar(
                `DELETE FROM facturacion.fe_documento_archivo a USING facturacion.fe_documento d
                  WHERE d.id_documento = a.id_documento AND d.id_negocio = :idNegocio;`
            );
            await borrar(`DELETE FROM facturacion.fe_documento WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM facturacion.fe_resolucion WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM facturacion.fe_configuracion WHERE id_negocio = :idNegocio;`);
            await borrar(
                `DELETE FROM restaurante.pedid_detalle d USING restaurante.pedid_orden o
                  WHERE o.id_orden = d.id_orden AND o.id_negocio = :idNegocio;`
            );
            await borrar(`DELETE FROM restaurante.pedid_orden WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM restaurante.carta_producto WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM restaurante.carta_categoria WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM restaurante.rest_punto_caja WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM general.gener_negocio_fiscal WHERE id_negocio = :idNegocio;`);
            await borrar(`DELETE FROM general.gener_negocio WHERE id_negocio = :idNegocio;`);
        });
    }
    await sequelize.close();
});

beforeEach(() => {
    jest.clearAllMocks();
    adaptador.emitirFactura.mockResolvedValue(aceptado());
    adaptador.emitirNotaCredito.mockResolvedValue(aceptado('CRTE1'));
    adaptador.consultarPorReferencia.mockResolvedValue(null);
    adaptador.eliminarPendiente.mockResolvedValue();
    adaptador.descargarArchivo.mockImplementation(async ({ tipo }) => Buffer.from(`contenido ${tipo}`));
    process.env.FE_ESPERA_MS = '5000';
});

describe('la configuración del negocio', () => {
    test('nunca devuelve las credenciales en la fila, y se guardan cifradas', async () => {
        const config = await configuracionDao.obtener(idNegocio);
        expect(config.tiene_credenciales).toBe(true);
        expect(config).not.toHaveProperty('credenciales_cifradas');
        const [fila] = await q(`SELECT credenciales_cifradas AS c FROM facturacion.fe_configuracion WHERE id_negocio = :idNegocio;`, { idNegocio });
        expect(fila.c).not.toContain('secreto');
        expect(await configuracionDao.obtenerCredenciales(idNegocio)).toEqual(CREDENCIALES);
    });

    test('un rango que no es factura ni nota crédito no se copia', async () => {
        const rangos = await configuracionDao.listarRangos(idNegocio);
        expect(rangos.map((r) => [r.id_rango_proveedor, r.tipo_documento, r.en_uso])).toEqual([
            [389, 'FV', true],
            [1776, 'NC', true],
        ]);
    });

    test('un impuesto que no está en el catálogo no se guarda', async () => {
        await expect(
            configuracionDao.guardar(idNegocio, { impuesto_defecto_codigo: '04', impuesto_defecto_tarifa: 7 })
        ).rejects.toMatchObject({ code: 'FE_IMPUESTO_INVALIDO' });
    });

    test('con los cuatro interruptores encendidos, factura', async () => {
        expect(await configuracionDao.debeFacturar(idNegocio)).toMatchObject({ facturar: true, motivo: null });
    });
});

describe('alCobrarPedido', () => {
    test('un pedido cobrado queda facturado, con su número, su CUFE y el intento anotado', async () => {
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({ idOrden, idUsuario });
        expect(r).toMatchObject({ estado: 'ACEPTADO', numero: 'SETP1', mensaje: 'Factura SETP1 enviada' });

        const doc = await documentoDe(idOrden);
        expect(doc).toMatchObject({ estado: 'ACEPTADO', numero: 'SETP1', cufe: 'cufe-SETP1', ambiente: 'PRUEBAS', intentos: 1 });
        expect(Number(doc.total)).toBe(20000);
        expect(doc.adquiriente.consumidor_final).toBe(true);
        expect(doc.emisor.razon_social).toBe('NEGOCIO DE PRUEBA S.A.S.');
        expect(doc.codigo_referencia).toMatch(new RegExp(`^EAP${idNegocio}-FV-${idOrden}-[0-9a-f]{8}$`));
        const intentos = await q(`SELECT resultado FROM facturacion.fe_intento WHERE id_documento = :id;`, { id: doc.id_documento });
        expect(intentos).toEqual([{ resultado: 'ACEPTADO' }]);

        const envio = adaptador.emitirFactura.mock.calls[0][0];
        expect(envio).toMatchObject({ credenciales: CREDENCIALES, ambiente: 'PRUEBAS', idRango: 389 });
        expect(envio.lineas).toHaveLength(1);
        // El negocio no es responsable de IVA ni de INC: la línea va sin impuesto (D7).
        expect(envio.lineas[0]).toMatchObject({ codigo_impuesto: 'ZZ', precio_neto: 20000 });
    });

    test('guarda su propia copia del PDF y el XML', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const doc = await documentoDe(idOrden);
        await emision.archivar(doc.id_documento);
        const archivos = await q(`SELECT tipo, bytes, sha256 FROM facturacion.fe_documento_archivo WHERE id_documento = :id ORDER BY tipo;`, { id: doc.id_documento });
        expect(archivos.map((a) => a.tipo)).toEqual(['PDF', 'XML']);
        expect(archivos[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test('llamarlo dos veces no factura dos veces', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const segunda = await alCobrarPedido({ idOrden });
        expect(segunda.estado).toBe('ACEPTADO');
        expect(adaptador.emitirFactura).toHaveBeenCalledTimes(1);
        const docs = await q(`SELECT 1 AS x FROM facturacion.fe_documento WHERE id_negocio = :idNegocio AND origen_id = :id;`, { idNegocio, id: String(idOrden) });
        expect(docs).toHaveLength(1);
    });

    test('si Factus no responde, queda para reintentar en un minuto', async () => {
        adaptador.emitirFactura.mockResolvedValue(fallido('ERROR_RED'));
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({ idOrden });
        expect(r.estado).toBe('ERROR');
        const doc = await documentoDe(idOrden);
        const enSegundos = (new Date(doc.proximo_intento_en) - Date.now()) / 1000;
        expect(enSegundos).toBeGreaterThan(45);
        expect(enSegundos).toBeLessThan(75);
    });

    test('un rechazo no se reintenta solo, y se retira de Factus para no bloquear las siguientes', async () => {
        adaptador.emitirFactura.mockResolvedValue(
            fallido('RECHAZADO', { httpStatus: 201, rechazos: [{ codigo: 'FAD06', mensaje: 'Rechazo: fecha inválida' }] })
        );
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({ idOrden });
        expect(r.estado).toBe('RECHAZADO');
        const doc = await documentoDe(idOrden);
        expect(doc.proximo_intento_en).toBeNull();
        expect(doc.ultimo_error).toMatch(/fecha inválida/);
        expect(adaptador.eliminarPendiente).toHaveBeenCalledWith(
            expect.objectContaining({ codigoReferencia: doc.codigo_referencia })
        );
    });

    test('credenciales rechazadas: espera a una persona, no reintenta', async () => {
        adaptador.emitirFactura.mockResolvedValue(fallido('ERROR_CREDENCIALES', { httpStatus: 401 }));
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const doc = await documentoDe(idOrden);
        expect(doc).toMatchObject({ estado: 'ERROR', proximo_intento_en: null });
    });

    test('si Factus tarda, el cobro no lo espera y la factura termina sola', async () => {
        process.env.FE_ESPERA_MS = '50';
        adaptador.emitirFactura.mockImplementation(async () => {
            await esperar(500);
            return aceptado('SETP-LENTA');
        });
        const idOrden = await crearPedido();
        const inicio = Date.now();
        const r = await alCobrarPedido({ idOrden });
        expect(Date.now() - inicio).toBeLessThan(400);
        expect(['EN_COLA', 'ENVIANDO']).toContain(r.estado);
        expect(r.mensaje).toMatch(/procesando/);
        await esperar(800);
        expect((await documentoDe(idOrden)).estado).toBe('ACEPTADO');
    });

    test('si el proveedor revienta, el cobro no se entera y el documento no se queda enviando', async () => {
        adaptador.emitirFactura.mockRejectedValue(new Error('explotó'));
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({ idOrden });
        expect(r.estado).toBe('ERROR');
        const doc = await documentoDe(idOrden);
        expect(doc.estado).toBe('ERROR');
        expect(doc.ultimo_error).toBe('explotó');
        expect(doc.proximo_intento_en).not.toBeNull();
    });

    test('por encima de 5 UVT sin comprador: espera los datos y no se envía', async () => {
        const idOrden = await crearPedido({ precio: 300000 });
        const r = await alCobrarPedido({ idOrden });
        expect(r.estado).toBe('PENDIENTE_DATOS');
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();

        // …y cuando la caja pone el comprador, sale.
        const doc = await documentoDe(idOrden);
        await emision.completarComprador(doc.id_documento, {
            tipo_persona: '1',
            tipo_documento: '31',
            numero_documento: '800197268',
            razon_social: 'Empresa Cliente SAS',
        });
        const final = await emision.procesarDocumento(doc.id_documento);
        expect(final.estado).toBe('ACEPTADO');
        expect(final.adquiriente).toMatchObject({ consumidor_final: false, dv: '4' });
    });

    test('un comprador mal escrito no se convierte en consumidor final', async () => {
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({
            idOrden,
            comprador: { tipo_persona: '1', tipo_documento: '31', numero_documento: '800197268', dv: '9', razon_social: 'X' },
        });
        expect(r.estado).toBe('PENDIENTE_DATOS');
        expect(r.mensaje).toMatch(/debería ser 4/);
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();
    });

    test('un pedido sin cobrar o anulado no se factura', async () => {
        const sinCobrar = await crearPedido({ estadoPago: 'pendiente_pago', estado: 'ABIERTA' });
        const anulado = await crearPedido({ estado: 'ANULADA' });
        expect(await alCobrarPedido({ idOrden: sinCobrar })).toBeNull();
        expect(await alCobrarPedido({ idOrden: anulado })).toBeNull();
        expect(await documentoDe(sinCobrar)).toBeUndefined();
    });
});

describe('reintentos y reconciliación', () => {
    test('dos procesos sobre el mismo documento envían una sola vez', async () => {
        const idOrden = await crearPedido();
        const doc = await emision.crearDocumentoPedido({ idOrden });
        const [a, b] = await Promise.all([
            emision.procesarDocumento(doc.id_documento),
            emision.procesarDocumento(doc.id_documento),
        ]);
        expect(adaptador.emitirFactura).toHaveBeenCalledTimes(1);
        expect([a.estado, b.estado]).toEqual(['ACEPTADO', 'ACEPTADO']);
    });

    test('el segundo intento pregunta primero si Factus ya lo tiene, y no reenvía', async () => {
        adaptador.emitirFactura.mockResolvedValue(fallido('ERROR_RED'));
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const doc = await documentoDe(idOrden);

        adaptador.emitirFactura.mockClear();
        adaptador.consultarPorReferencia.mockResolvedValue({ ...aceptado('SETP-YA-ESTABA'), payload: null });
        const final = await emision.procesarDocumento(doc.id_documento, { forzar: true });
        expect(final).toMatchObject({ estado: 'ACEPTADO', numero: 'SETP-YA-ESTABA', intentos: 2 });
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();
    });

    test('procesarPendientes envía lo que ya toca y deja lo que espera a una persona', async () => {
        adaptador.emitirFactura.mockResolvedValue(fallido('ERROR_RED'));
        const toca = await crearPedido();
        await alCobrarPedido({ idOrden: toca });
        adaptador.emitirFactura.mockResolvedValue(fallido('ERROR_CREDENCIALES', { httpStatus: 401 }));
        const espera = await crearPedido();
        await alCobrarPedido({ idOrden: espera });
        await q(`UPDATE facturacion.fe_documento SET proximo_intento_en = now() - interval '1 second' WHERE origen_id = :id AND id_negocio = :idNegocio RETURNING 1;`, { id: String(toca), idNegocio });

        adaptador.emitirFactura.mockResolvedValue(aceptado('SETP-REINTENTO'));
        await emision.procesarPendientes();
        expect((await documentoDe(toca)).estado).toBe('ACEPTADO');
        expect((await documentoDe(espera)).estado).toBe('ERROR');
    });

    test('reintentar un rechazado estrena referencia', async () => {
        adaptador.emitirFactura.mockResolvedValue(fallido('RECHAZADO', { httpStatus: 201 }));
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const antes = await documentoDe(idOrden);

        adaptador.emitirFactura.mockResolvedValue(aceptado('SETP-CORREGIDA'));
        const final = await emision.reintentar(antes.id_documento);
        expect(final.estado).toBe('ACEPTADO');
        expect(final.codigo_referencia).toBe(`${antes.codigo_referencia}-r1`);
    });

    test('la reconciliación recoge un pedido cobrado que se quedó sin documento', async () => {
        // Solo cuentan los pedidos posteriores a la activación: el negocio de la suite se activó
        // hace segundos, así que se le adelanta para que un pedido de hace 5 minutos entre.
        await q(`UPDATE facturacion.fe_configuracion SET activado_en = now() - interval '1 hour' WHERE id_negocio = :idNegocio RETURNING 1;`, { idNegocio });
        const huerfano = await crearPedido({ haceMinutos: 5 });
        const reciente = await crearPedido(); // menos de 2 minutos: todavía puede estar en el gancho
        const creados = await emision.reconciliar();
        expect(creados).toBeGreaterThanOrEqual(1);
        expect((await documentoDe(huerfano)).estado).toBe('EN_COLA');
        expect(await documentoDe(reciente)).toBeUndefined();
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();
    });
});

describe('facturar solo lo que se pide (el caso por defecto)', () => {
    beforeAll(() => configuracionDao.guardar(idNegocio, { facturar_todo: false }));
    afterAll(() => configuracionDao.guardar(idNegocio, { facturar_todo: true }));

    test('un cobro sin pedir factura no crea nada ni llama al proveedor', async () => {
        const idOrden = await crearPedido();
        expect(await alCobrarPedido({ idOrden })).toBeNull();
        expect(await documentoDe(idOrden)).toBeUndefined();
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();
    });

    test('pedirla anónima la emite a consumidor final', async () => {
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({ idOrden, comprador: { consumidor_final: true } });
        expect(r.estado).toBe('ACEPTADO');
        expect((await documentoDe(idOrden)).adquiriente.consumidor_final).toBe(true);
    });

    test('pedirla con datos la emite a nombre del cliente', async () => {
        const idOrden = await crearPedido();
        const r = await alCobrarPedido({
            idOrden,
            comprador: { tipo_persona: '2', tipo_documento: '13', numero_documento: '1000000009', nombres: 'Ana Pérez' },
        });
        expect(r.estado).toBe('ACEPTADO');
        expect((await documentoDe(idOrden)).adquiriente).toMatchObject({ consumidor_final: false, nombres: 'Ana Pérez' });
    });

    test('anónima por encima del tope: espera los datos del comprador', async () => {
        const idOrden = await crearPedido({ precio: 300000 });
        const r = await alCobrarPedido({ idOrden, comprador: { consumidor_final: true } });
        expect(r.estado).toBe('PENDIENTE_DATOS');
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();
    });

    test('cerrar un pedido que ya se facturó al cobrarlo devuelve esa factura, sin pedir otra', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden, comprador: { consumidor_final: true } });
        const alCerrar = await alCobrarPedido({ idOrden });
        expect(alCerrar).toMatchObject({ estado: 'ACEPTADO', numero: 'SETP1' });
        expect(adaptador.emitirFactura).toHaveBeenCalledTimes(1);
    });

    test('la reconciliación no factura por su cuenta lo que nadie pidió', async () => {
        await q(`UPDATE facturacion.fe_configuracion SET activado_en = now() - interval '1 hour' WHERE id_negocio = :idNegocio RETURNING 1;`, { idNegocio });
        const idOrden = await crearPedido({ haceMinutos: 5 });
        await emision.reconciliar();
        expect(await documentoDe(idOrden)).toBeUndefined();
    });
});

describe('anular un pedido cobrado', () => {
    const { alAnularPedido } = require('../../app_core/facturacion');

    test('si la factura todavía no salió, se anula sin llamar al proveedor', async () => {
        const idOrden = await crearPedido({ precio: 300000 }); // queda esperando datos
        await alCobrarPedido({ idOrden });
        const r = await alAnularPedido({ idOrden, idUsuario });
        expect(r.estado).toBe('ANULADO');
        expect((await documentoDe(idOrden)).estado).toBe('ANULADO');
        expect(adaptador.emitirFactura).not.toHaveBeenCalled();
        expect(adaptador.emitirNotaCredito).not.toHaveBeenCalled();
    });

    test('si ya fue aceptada, se emite una nota crédito por el total que la referencia', async () => {
        adaptador.emitirFactura.mockResolvedValue(aceptado('SETP-A-ANULAR'));
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const r = await alAnularPedido({ idOrden, idUsuario });
        expect(r).toMatchObject({ tipo: 'NC', estado: 'ACEPTADO', numero: 'CRTE1', mensaje: 'Nota crédito CRTE1 enviada' });

        const factura = await documentoDe(idOrden);
        const nota = await documentoDe(idOrden, 'NC');
        expect(factura.estado).toBe('ACEPTADO'); // la factura aceptada no se toca
        expect(nota.id_documento_referencia).toBe(factura.id_documento);
        expect(Number(nota.total)).toBe(Number(factura.total));
        expect(nota.codigo_referencia).toMatch(new RegExp(`^EAP${idNegocio}-NC-${idOrden}-`));

        const envio = adaptador.emitirNotaCredito.mock.calls[0][0];
        expect(envio.facturaReferencia).toEqual({ numero: 'SETP-A-ANULAR' });
        expect(envio.idRango).toBe(1776);
        expect(envio.lineas).toHaveLength(1);
    });

    test('anular dos veces no emite dos notas', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        await alAnularPedido({ idOrden });
        await alAnularPedido({ idOrden });
        expect(adaptador.emitirNotaCredito).toHaveBeenCalledTimes(1);
    });

    test('un pedido sin factura no hace nada', async () => {
        const idOrden = await crearPedido({ estadoPago: 'pendiente_pago', estado: 'ABIERTA' });
        expect(await alAnularPedido({ idOrden })).toBeNull();
    });
});

describe('el correo al comprador lo manda EscalApp', () => {
    const conCorreo = { tipo_persona: '2', tipo_documento: '13', numero_documento: '1000000009', nombres: 'Ana Pérez', correo: 'ana@correo.co' };

    test('al aceptarse, se le manda solo y una vez, con el PDF, el XML y la marca del negocio', async () => {
        MailService.sendHtmlEmail.mockClear();
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden, comprador: conCorreo });
        await esperar(400); // el correo sale en segundo plano, después de archivar
        const doc = await documentoDe(idOrden);
        expect(await emision.enviarCorreo(doc.id_documento)).toBe(false); // ya se mandó
        expect(MailService.sendHtmlEmail).toHaveBeenCalledTimes(1);
        const correo = MailService.sendHtmlEmail.mock.calls[0][0];
        expect(correo.to).toBe('ana@correo.co');
        expect(correo.attachments.map((a) => a.filename)).toEqual(['SETP1.pdf', 'SETP1.xml']);
        expect(correo.html).toContain('TEST FE-2 emisión (borrar)');
        expect((await documentoDe(idOrden)).correo_enviado_en).not.toBeNull();
    });

    test('sin correo del comprador no se manda nada', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        MailService.sendHtmlEmail.mockClear();
        expect(await emision.enviarCorreo((await documentoDe(idOrden)).id_documento)).toBe(false);
        expect(MailService.sendHtmlEmail).not.toHaveBeenCalled();
    });

    test('si el envío falla, queda libre para reintentarlo', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden, comprador: conCorreo });
        const doc = await documentoDe(idOrden);
        await q('UPDATE facturacion.fe_documento SET correo_enviado_en = NULL WHERE id_documento = :id RETURNING 1;', { id: doc.id_documento });
        MailService.sendHtmlEmail.mockRejectedValueOnce(new Error('SMTP caído'));
        expect(await emision.enviarCorreo(doc.id_documento)).toBe(false);
        expect((await documentoDe(idOrden)).correo_enviado_en).toBeNull();
        expect(await emision.enviarCorreo(doc.id_documento)).toBe(true);
    });
});

describe('lo que ve la caja', () => {
    test('la lista trae los documentos del negocio, y solo los suyos', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const lista = await emision.listar(idNegocio, { estado: 'ACEPTADO' });
        expect(lista.length).toBeGreaterThan(0);
        expect(lista[0]).toMatchObject({ estado: 'ACEPTADO', consumidor_final: true });
        expect(await emision.listar(idNegocio, { desde: '2099-01-01' })).toEqual([]);
        expect(await emision.listar(-1)).toEqual([]);
    });

    test('un documento no se puede pedir desde otro negocio', async () => {
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const doc = await documentoDe(idOrden);
        expect(await emision.obtenerDeNegocio(doc.id_documento, idNegocio)).not.toBeNull();
        expect(await emision.obtenerDeNegocio(doc.id_documento, idNegocio + 1)).toBeNull();
    });

    test('el PDF se trae del proveedor si todavía no estaba guardado', async () => {
        adaptador.descargarArchivo.mockImplementation(async ({ tipo }) => Buffer.from(`%${tipo} de prueba`));
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const doc = await documentoDe(idOrden);
        const pdf = await emision.obtenerArchivo(doc.id_documento, 'PDF');
        expect(pdf.toString()).toBe('%PDF de prueba');
    });

    test('cada factura aceptada anota hasta dónde va el rango', async () => {
        adaptador.emitirFactura.mockResolvedValue(aceptado('SETP990000123'));
        const idOrden = await crearPedido();
        await alCobrarPedido({ idOrden });
        const rango = await configuracionDao.rangoEnUso(idNegocio, 'FV');
        expect(Number(rango.consecutivo_actual)).toBe(990000123);
    });

    test('avisa cuando el rango se acaba o la resolución vence', async () => {
        expect(await configuracionDao.alertasDe(idNegocio)).toEqual([]);
        await q(
            `UPDATE facturacion.fe_resolucion
                SET rango_desde = 1, rango_hasta = 1000, consecutivo_actual = 950, vigencia_hasta = CURRENT_DATE + 10
              WHERE id_negocio = :idNegocio AND tipo_documento = 'FV' RETURNING 1;`,
            { idNegocio }
        );
        const alertas = await configuracionDao.alertasDe(idNegocio);
        expect(alertas).toHaveLength(2);
        expect(alertas.join(' ')).toMatch(/vence el \d{2}\/\d{2}\/\d{4}/);
        expect(alertas.join(' ')).toMatch(/Quedan 50 números/);
        await q(
            `UPDATE facturacion.fe_resolucion
                SET rango_desde = NULL, rango_hasta = NULL, vigencia_hasta = NULL
              WHERE id_negocio = :idNegocio AND tipo_documento = 'FV' RETURNING 1;`,
            { idNegocio }
        );
    });
});

describe('el negocio que no factura', () => {
    test('en modo NINGUNO el cobro no crea nada ni llama a nadie', async () => {
        await q(`UPDATE general.gener_negocio_fiscal SET modo_facturacion = 'NINGUNO' WHERE id_negocio = :idNegocio RETURNING 1;`, { idNegocio });
        try {
            const idOrden = await crearPedido();
            expect(await alCobrarPedido({ idOrden })).toBeNull();
            expect(await documentoDe(idOrden)).toBeUndefined();
            expect(adaptador.emitirFactura).not.toHaveBeenCalled();
            expect(await configuracionDao.debeFacturar(idNegocio)).toMatchObject({ facturar: false, motivo: 'MODO_NINGUNO' });
        } finally {
            await q(`UPDATE general.gener_negocio_fiscal SET modo_facturacion = 'POS' WHERE id_negocio = :idNegocio RETURNING 1;`, { idNegocio });
        }
    });

    test('con la configuración suspendida, tampoco', async () => {
        await configuracionDao.cambiarEstado(idNegocio, 'SUSPENDIDO');
        try {
            const idOrden = await crearPedido();
            expect(await alCobrarPedido({ idOrden })).toBeNull();
        } finally {
            await configuracionDao.cambiarEstado(idNegocio, 'EN_PRUEBAS');
        }
    });

    test('no se puede activar sin credenciales ni rango, y el error dice qué falta', async () => {
        const [otro] = await q(`INSERT INTO general.gener_negocio (nombre, estado) VALUES ('TEST FE-2 vacío (borrar)', 'A') RETURNING id_negocio;`);
        try {
            await expect(configuracionDao.cambiarEstado(otro.id_negocio, 'EN_PRUEBAS')).rejects.toMatchObject({
                code: 'FE_NO_LISTO',
                message: expect.stringMatching(/credenciales.*rango/),
            });
        } finally {
            await q(`DELETE FROM general.gener_negocio_fiscal WHERE id_negocio = :id RETURNING 1;`, { id: otro.id_negocio });
            await q(`DELETE FROM general.gener_negocio WHERE id_negocio = :id RETURNING 1;`, { id: otro.id_negocio });
        }
    });
});
