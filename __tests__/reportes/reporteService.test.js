/**
 * reporteService.test.js
 * Tests unitarios para la capa de negocio del módulo de reportes.
 *
 * Ejecutar: npx jest __tests__/reportes/
 */

'use strict';

// Mock del DAO
jest.mock('../../app_core/dao/reporteDao');
const reporteDao = require('../../app_core/dao/reporteDao');
const reporteService = require('../../app_parqueadero_api/services/reporteService');

// ─────────────────────────────────────────────
// Datos de prueba
// ─────────────────────────────────────────────

const INGRESOS_MOCK = [
  { periodo: new Date('2026-01-01T00:00:00-05:00'), num_transacciones: '48', total_ingresos: '450000.00', ticket_promedio: '9375.00', duracion_promedio_min: '62.5' },
  { periodo: new Date('2026-01-02T00:00:00-05:00'), num_transacciones: '54', total_ingresos: '512000.00', ticket_promedio: '9481.48', duracion_promedio_min: '58.3' },
];

const TRANSACCIONES_MOCK = {
  total: 2,
  items: [
    {
      id_factura: 1001,
      numero_factura: 'F-001001',
      placa: 'ABC123',
      id_tipo_vehiculo: 1,
      nombre_tipo_vehiculo: 'Carro',
      fecha_entrada_local: new Date('2026-01-15T08:23:00-05:00'),
      fecha_cierre_local:  new Date('2026-01-15T10:45:00-05:00'),
      duracion_minutos: '142.00',
      valor_total: '12000.00',
      estado: 'C',
      tipo_cobro: 'HORA',
      id_negocio: 5,
      nombre_cajero: 'Juan Pérez',
    },
    {
      id_factura: 1002,
      numero_factura: 'F-001002',
      placa: 'XYZ789',
      id_tipo_vehiculo: 2,
      nombre_tipo_vehiculo: 'Moto',
      fecha_entrada_local: new Date('2026-01-15T09:00:00-05:00'),
      fecha_cierre_local:  new Date('2026-01-15T09:45:00-05:00'),
      duracion_minutos: '45.00',
      valor_total: '4500.00',
      estado: 'C',
      tipo_cobro: 'HORA',
      id_negocio: 5,
      nombre_cajero: 'María López',
    },
  ],
};

// ─────────────────────────────────────────────
// Tests de ingresos agregados
// ─────────────────────────────────────────────

describe('reporteService.getIngresosAgregados', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retorna serie y totales correctos', async () => {
    reporteDao.getIngresosAgregados.mockResolvedValue(INGRESOS_MOCK);

    const resultado = await reporteService.getIngresosAgregados({
      idNegocio:    5,
      fechaDesde:   '2026-01-01',
      fechaHasta:   '2026-01-31',
      granularidad: 'daily',
    });

    expect(resultado.serie).toHaveLength(2);
    expect(resultado.totales.total_periodo).toBeCloseTo(962000, 0);
    expect(resultado.totales.transacciones_periodo).toBe(102);
    expect(resultado.totales.ticket_promedio).toBeCloseTo(9431.37, 0);
  });

  it('llama al DAO con los parámetros correctos', async () => {
    reporteDao.getIngresosAgregados.mockResolvedValue([]);

    await reporteService.getIngresosAgregados({
      idNegocio: 5, fechaDesde: '2026-01-01', fechaHasta: '2026-01-31', granularidad: 'monthly',
    });

    expect(reporteDao.getIngresosAgregados).toHaveBeenCalledWith(
      expect.objectContaining({ idNegocio: 5, granularidad: 'monthly' }),
    );
  });

  it('maneja dataset vacío sin dividir por cero', async () => {
    reporteDao.getIngresosAgregados.mockResolvedValue([]);

    const resultado = await reporteService.getIngresosAgregados({
      idNegocio: 5, fechaDesde: '2026-01-01', fechaHasta: '2026-01-31', granularidad: 'daily',
    });

    expect(resultado.totales.ticket_promedio).toBe(0);
    expect(resultado.totales.total_periodo).toBe(0);
  });
});

// ─────────────────────────────────────────────
// Tests de transacciones paginadas
// ─────────────────────────────────────────────

describe('reporteService.getTransacciones', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delega al DAO y retorna resultado', async () => {
    reporteDao.getTransaccionesPaginadas.mockResolvedValue(TRANSACCIONES_MOCK);

    const resultado = await reporteService.getTransacciones({
      idNegocio: 5, fechaDesde: '2026-01-01', fechaHasta: '2026-01-31',
      page: 1, pageSize: 50,
    });

    expect(resultado.total).toBe(2);
    expect(resultado.items).toHaveLength(2);
  });

  it('filtra solo facturas del tenant correcto', async () => {
    reporteDao.getTransaccionesPaginadas.mockResolvedValue(TRANSACCIONES_MOCK);

    await reporteService.getTransacciones({ idNegocio: 5, fechaDesde: '2026-01-01', fechaHasta: '2026-01-31' });

    expect(reporteDao.getTransaccionesPaginadas).toHaveBeenCalledWith(
      expect.objectContaining({ idNegocio: 5 }),
    );
  });
});

// ─────────────────────────────────────────────
// Tests de timezone (crítico)
// ─────────────────────────────────────────────

describe('Conversión de timezone America/Bogota', () => {
  it('una factura cerrada a las 05:30 UTC debe aparecer como 00:30 en Bogotá', () => {
    const utcDate    = new Date('2026-01-15T05:30:00Z');
    const localStr   = utcDate.toLocaleString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false });
    expect(localStr).toBe('00:30');
  });

  it('una factura a las 04:59 UTC debe agruparse en el día anterior en Bogotá', () => {
    const utcDate   = new Date('2026-01-15T04:59:59Z');
    const localDate = new Date(utcDate.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    expect(localDate.getDate()).toBe(14); // 14 de enero en Bogotá
  });

  it('una factura a las 05:00 UTC en adelante es el mismo día en Bogotá', () => {
    const utcDate   = new Date('2026-01-15T05:00:00Z');
    const localDate = new Date(utcDate.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    expect(localDate.getDate()).toBe(15); // 15 de enero en Bogotá
  });
});

// ─────────────────────────────────────────────
// Tests de reconciliación de caja
// ─────────────────────────────────────────────

describe('reporteService.getReconciliacionCaja', () => {
  const CAJA_MOCK = {
    id_caja: 45,
    id_negocio: 5,
    nombre_cajero: 'María López',
    monto_apertura: '100000.00',
    monto_cierre: '635000.00',
    total_ingresos_caja: '540000.00',
    total_egresos_caja: '5000.00',
    diferencia: '0.00',
    estado: 'C',
    movimientos: [],
  };

  it('calcula diferencia = 0 cuando el cajero declaró el monto correcto', async () => {
    reporteDao.getReconciliacionCaja.mockResolvedValue(CAJA_MOCK);

    const resultado = await reporteService.getReconciliacionCaja({ idNegocio: 5, idCaja: 45 });
    expect(parseFloat(resultado.diferencia)).toBe(0);
  });

  it('retorna null si la caja no existe', async () => {
    reporteDao.getReconciliacionCaja.mockResolvedValue(null);

    const resultado = await reporteService.getReconciliacionCaja({ idNegocio: 5, idCaja: 999 });
    expect(resultado).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Tests de generarReporte (routing por tipo)
// ─────────────────────────────────────────────

describe('reporteService.generarReporte', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reporteDao.getIngresosAgregados.mockResolvedValue(INGRESOS_MOCK);
  });

  it('retorna status ready para formato json', async () => {
    const resultado = await reporteService.generarReporte({
      tipoReporte: 'daily_revenue',
      idNegocio:   5,
      fechaDesde:  '2026-01-01',
      fechaHasta:  '2026-01-31',
      formato:     'json',
    });

    expect(resultado.status).toBe('ready');
    expect(resultado.datos).toBeDefined();
  });

  it('lanza error para tipo de reporte desconocido', async () => {
    await expect(
      reporteService.generarReporte({
        tipoReporte: 'reporte_inexistente',
        idNegocio:   5,
        fechaDesde:  '2026-01-01',
        fechaHasta:  '2026-01-31',
        formato:     'json',
      }),
    ).rejects.toThrow('Tipo de reporte desconocido');
  });
});
