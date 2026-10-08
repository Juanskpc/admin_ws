/**
 * Cobranza — el comprobante de pago que el cliente descarga desde «Mis pagos».
 *
 * Estas pruebas NO tocan la base. Lo que cubren es lo que se equivoca en silencio: un PDF que
 * sale mal nadie lo ve fallar —se ve raro meses después, en manos del contador del cliente—, y
 * un comprobante que diga «pagado» sobre un cobro que no lo está es un documento falso.
 *
 * Ejecutar: npx jest __tests__/cobranza/comprobante.test.js
 */
'use strict';

jest.mock('../../app_core/dao/cobranzaDao');

const Dao = require('../../app_core/dao/cobranzaDao');
const Comprobante = require('../../app_admin_api/services/comprobanteService');
const { dinero, medioDePago, concepto, diaLargo, slug } = Comprobante._interno;

const PAGO = {
    id_factura: 123,
    referencia: 'EA-6-202610',
    id_negocio: 6,
    negocio: 'Zona Burger',
    nit: '901.234.567-8',
    email_negocio: 'contacto@zonaburger.co',
    telefono: null,
    direccion: 'Calle 45 # 12-34, Bogotá',
    tipo: 'renovacion',
    plan: 'Plan Avanzado',
    periodo_inicio: '2026-10-01',
    periodo_fin: '2026-10-31',
    moneda: 'COP',
    subtotal: 89998,
    impuestos: 0,
    total: 89998,
    fecha_pago: new Date('2026-10-05T14:32:00-05:00'),
    pasarela: 'wompi',
    medio_pago_texto: null,
    numero_factura: null,
    cufe: null,
    lineas: [
        { tipo: 'plan', descripcion: 'Plan Avanzado (mensual)', cantidad: 1, precio_unitario: 59999, subtotal: 59999 },
        { tipo: 'complemento', descripcion: 'Usuario adicional', cantidad: 2, precio_unitario: 15000, subtotal: 30000 },
    ],
};

describe('redacción del documento', () => {
    test('el medio tecleado a mano manda sobre el nombre de la pasarela', () => {
        expect(medioDePago({ pasarela: 'manual', medio_pago_texto: 'Transferencia Bancolombia 9348' }))
            .toBe('Transferencia Bancolombia 9348');
        expect(medioDePago({ pasarela: 'wompi', medio_pago_texto: null })).toBe('Wompi');
        expect(medioDePago({ pasarela: 'dlocal', medio_pago_texto: '' })).toBe('dLocal Go');
    });

    test('un ajuste no se llama mensualidad: es la diferencia de cambiar de plan', () => {
        expect(concepto({ tipo: 'ajuste', plan: 'Plan Avanzado' })).toBe('Cambio de plan · Plan Avanzado');
        expect(concepto({ tipo: 'renovacion', plan: 'Plan Básico' })).toBe('Mensualidad EscalApp · Plan Básico');
        // Facturas viejas sin `id_plan`: el concepto sigue siendo cierto, solo más corto.
        expect(concepto({ tipo: 'renovacion', plan: null })).toBe('Mensualidad EscalApp');
    });

    test('el dinero se escribe en la moneda de la factura, y el peso no lleva céntimos', () => {
        expect(dinero(89998, 'COP')).toMatch(/89\.998/);
        expect(dinero(89998, 'COP')).not.toMatch(/,00/);
        expect(dinero(12.5, 'PEN')).toMatch(/12,50/);
    });

    test('las fechas de período son de calendario: el 1 de octubre no se corre de día', () => {
        expect(diaLargo('2026-10-01')).toBe('1 de octubre de 2026');
        expect(diaLargo(null)).toBe('—');
    });

    test('el nombre del archivo sale de la referencia, sin acentos ni signos', () => {
        expect(slug('EA-6-202610')).toBe('ea_6_202610');
    });
});

describe('generarPDF', () => {
    test('devuelve un PDF de verdad, nombrado por su referencia', async () => {
        const { buffer, filename } = await Comprobante.generarPDF(PAGO);

        expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
        expect(filename).toBe('comprobante_ea_6_202610.pdf');
        expect(buffer.length).toBeGreaterThan(1000);
    });

    test('una factura sin líneas de detalle también se dibuja (facturas anteriores al detalle)', async () => {
        const { buffer } = await Comprobante.generarPDF({ ...PAGO, lineas: [] });
        expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    });

    test('con número de factura el documento se titula factura; sin él, comprobante', async () => {
        const conFactura = await Comprobante.generarPDF({ ...PAGO, numero_factura: 'FV-00142' });
        const sinFactura = await Comprobante.generarPDF(PAGO);
        // El título va en los metadatos del PDF, que es lo que se puede leer sin un parser.
        expect(conFactura.buffer.toString('latin1')).toContain('Factura de venta');
        expect(sinFactura.buffer.toString('latin1')).toContain('Comprobante de pago');
    });
});

describe('datosComprobante', () => {
    beforeEach(() => jest.resetAllMocks());

    test('una factura que no existe es un 404', async () => {
        Dao.getFactura.mockResolvedValue(null);
        await expect(Comprobante.datosComprobante(999)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('no emite comprobante de un cobro que nadie pagó', async () => {
        Dao.getFactura.mockResolvedValue({ id_factura: 1, estado: 'pendiente' });
        await expect(Comprobante.datosComprobante(1)).rejects.toMatchObject({
            statusCode: 409,
            code: 'PAGO_NO_CONFIRMADO',
        });
    });

    test('tampoco de una factura anulada: se perdonó, no se pagó', async () => {
        Dao.getFactura.mockResolvedValue({ id_factura: 1, estado: 'anulada' });
        await expect(Comprobante.datosComprobante(1)).rejects.toMatchObject({ statusCode: 409 });
    });
});
