/**
 * Servicio de QR para parqueadero.
 * Genera códigos QR PNG, verifica tokens y procesa salidas por QR.
 */
const QRCode  = require('qrcode');
const crypto  = require('crypto');
const Models  = require('../../app_core/models/conection');
const { Op }  = require('sequelize');

// ──── HELPERS ────

function calcularCosto(fechaEntrada, tarifa, fechaSalida = new Date()) {
  if (!tarifa) return 0;
  const diffMs   = Math.max(0, fechaSalida.getTime() - new Date(fechaEntrada).getTime());
  const mins     = Math.max(1, Math.floor(diffMs / 60000));
  const valor    = Number(tarifa.valor);
  const adicional = tarifa.valor_adicional != null ? Number(tarifa.valor_adicional) : null;
  switch (tarifa.tipo_cobro) {
    case 'HORA': {
      const periodos = Math.ceil(mins / 60);
      if (adicional != null && periodos > 1) return valor + adicional * (periodos - 1);
      return periodos * valor;
    }
    case 'FRACCION': {
      const periodos = Math.ceil(mins / 30);
      if (adicional != null && periodos > 1) return valor + adicional * (periodos - 1);
      return periodos * valor;
    }
    case 'DIA':  return Math.ceil(mins / (60 * 24)) * valor;
    case 'MES':  return valor;
    default:     return 0;
  }
}

function formatMoneda(v) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v ?? 0);
}

/**
 * Genera un token único aleatorio (64 caracteres hex)
 */
function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ──── API PÚBLICA ────

/**
 * Genera un Buffer PNG con el código QR.
 * @param {string} url - La URL que codifica el QR
 * @param {number} size - Tamaño en píxeles (default: 300)
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generarQR(url, size = 300) {
  return QRCode.toBuffer(url, {
    type: 'png',
    width: size,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/**
 * Genera un QR como data URL (base64 embebido) para HTML.
 * @param {string} url
 * @param {number} size
 * @returns {Promise<string>} data:image/png;base64,...
 */
async function generarQRDataUrl(url, size = 300) {
  return QRCode.toDataURL(url, {
    type: 'image/png',
    width: size,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

/**
 * Busca un vehículo activo por su qr_token y retorna info + costo calculado.
 * @param {string} token
 * @returns {object|null}
 */
async function getVehiculoPorToken(token) {
  const vehiculo = await Models.ParqVehiculo.findOne({
    where: { qr_token: token, estado: 'A' },
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
      { model: Models.ParqTarifa,       as: 'tarifa',       attributes: ['tipo_cobro', 'valor', 'valor_adicional'] },
    ],
  });
  if (!vehiculo) return null;

  const costo = calcularCosto(vehiculo.fecha_entrada, vehiculo.tarifa);

  const mins = Math.floor((Date.now() - new Date(vehiculo.fecha_entrada).getTime()) / 60000);
  const tiempo = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

  return {
    id_vehiculo:    vehiculo.id_vehiculo,
    placa:          vehiculo.placa,
    qr_token:       vehiculo.qr_token,
    fecha_entrada:  vehiculo.fecha_entrada,
    tipoVehiculo:   vehiculo.tipoVehiculo ? { nombre: vehiculo.tipoVehiculo.nombre } : null,
    tarifa:         vehiculo.tarifa ? {
      tipo_cobro: vehiculo.tarifa.tipo_cobro,
      valor: Number(vehiculo.tarifa.valor),
      valor_adicional: vehiculo.tarifa.valor_adicional != null ? Number(vehiculo.tarifa.valor_adicional) : null,
    } : null,
    costo,
    costo_formateado: formatMoneda(costo),
    tiempo_transcurrido: tiempo,
    observaciones: vehiculo.observaciones,
  };
}

/**
 * Procesa la salida de un vehículo por QR (sin usuario autenticado).
 * @param {string} token
 * @returns {object|null} - Datos del vehículo con fecha_salida, valor_cobrado y número de factura
 */
async function procesarSalidaQR(token) {
  const vehiculo = await Models.ParqVehiculo.findOne({
    where: { qr_token: token, estado: 'A' },
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
      { model: Models.ParqTarifa,       as: 'tarifa',       attributes: ['tipo_cobro', 'valor', 'valor_adicional'] },
    ],
  });
  if (!vehiculo) return null;

  const fechaSalida = new Date();
  const costo = calcularCosto(vehiculo.fecha_entrada, vehiculo.tarifa);

  vehiculo.fecha_salida  = fechaSalida;
  vehiculo.valor_cobrado = costo;
  vehiculo.estado        = 'S';
  await vehiculo.save();

  // Cerrar factura
  await Models.ParqFactura.update(
    { valor_total: costo, estado: 'C', fecha_cierre: fechaSalida },
    { where: { id_vehiculo: vehiculo.id_vehiculo, id_negocio: vehiculo.id_negocio, estado: 'A' } }
  );

  const factura = await Models.ParqFactura.findOne({
    where: { id_vehiculo: vehiculo.id_vehiculo, id_negocio: vehiculo.id_negocio, estado: 'C' },
    order: [['fecha_cierre', 'DESC']],
  });

  const mins = Math.floor((fechaSalida.getTime() - new Date(vehiculo.fecha_entrada).getTime()) / 60000);
  const tiempo = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

  return {
    id_vehiculo:    vehiculo.id_vehiculo,
    placa:          vehiculo.placa,
    fecha_entrada:  vehiculo.fecha_entrada,
    fecha_salida:   fechaSalida,
    tipoVehiculo:   vehiculo.tipoVehiculo ? { nombre: vehiculo.tipoVehiculo.nombre } : null,
    tarifa:         vehiculo.tarifa ? {
      tipo_cobro: vehiculo.tarifa.tipo_cobro,
      valor: Number(vehiculo.tarifa.valor),
    } : null,
    valor_cobrado: costo,
    costo_formateado: formatMoneda(costo),
    tiempo_transcurrido: tiempo,
    id_factura:     factura?.id_factura,
    numero_factura: factura?.numero_factura,
  };
}

module.exports = {
  generarToken,
  generarQR,
  generarQRDataUrl,
  getVehiculoPorToken,
  procesarSalidaQR,
};
