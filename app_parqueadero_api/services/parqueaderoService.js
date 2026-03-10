const Models = require('../../app_core/models/conection');
const { Op } = require('sequelize');

// ──── HELPERS ────

/**
 * Genera número de factura secuencial por negocio: PAR-{id}-{year}-{seq:04d}
 */
async function getNumeroFactura(idNegocio) {
  const year = new Date().getFullYear();
  const count = await Models.ParqFactura.count({ where: { id_negocio: idNegocio } });
  return `PAR-${idNegocio}-${year}-${String(count + 1).padStart(4, '0')}`;
}

/**
 * Calcula el costo de estancia dado tiempo y tarifa.
 * @param {Date} fechaEntrada - Fecha de entrada
 * @param {Date} fechaSalida  - Fecha de salida (default: now)
 * @param {{ tipo_cobro: string, valor: number }} tarifa
 * @returns {number} valor en pesos colombianos
 */
function calcularCosto(fechaEntrada, tarifa, fechaSalida = new Date()) {
  if (!tarifa) return 0;
  const diffMs  = Math.max(0, fechaSalida.getTime() - new Date(fechaEntrada).getTime());
  const mins    = Math.max(1, Math.floor(diffMs / 60000));
  const valor   = Number(tarifa.valor);
  switch (tarifa.tipo_cobro) {
    case 'HORA':     return Math.ceil(mins / 60)         * valor;
    case 'FRACCION': return Math.ceil(mins / 30)         * valor;
    case 'DIA':      return Math.ceil(mins / (60 * 24))  * valor;
    case 'MES':      return valor;
    default:         return 0;
  }
}

/**
 * Genera HTML de recibo para impresión.
 * Llamado tanto en entrada (recibo parcial) como en salida (recibo final).
 */
function generarHtmlRecibo({ factura, config, fechaSalida = null, total = null }) {
  const COT = { timeZone: 'America/Bogota', hour12: false };
  const fmtDate = (d) => d
    ? new Date(d).toLocaleString('es-CO', { ...COT, dateStyle: 'short', timeStyle: 'short' })
    : '—';
  const fmtMoneda = (v) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v ?? 0);
  const negocioNombre = config?.nombre_comercial || 'Parqueadero';
  const negocioDireccion = config?.direccion || '';
  const negocioTelefono  = config?.telefono  || '';
  const esCierre = !!fechaSalida;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<title>Recibo ${factura.numero_factura}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Courier New', monospace; font-size:12px; width:280px; margin:0 auto; padding:8px; }
  h1  { font-size:14px; text-align:center; font-weight:bold; }
  .sub { text-align:center; font-size:11px; margin-bottom:4px; }
  hr  { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; margin:2px 0; }
  .label { font-weight:bold; }
  .total { font-size:15px; font-weight:bold; text-align:center; margin:6px 0; }
  .footer { text-align:center; font-size:10px; margin-top:8px; }
  @media print {
    @page { margin:0; size:80mm auto; }
    body  { width:80mm; padding:4mm; }
  }
</style>
</head>
<body>
<h1>${negocioNombre.toUpperCase()}</h1>
${negocioDireccion ? `<p class="sub">${negocioDireccion}</p>` : ''}
${negocioTelefono  ? `<p class="sub">Tel: ${negocioTelefono}</p>` : ''}
<hr/>
<div class="row"><span class="label">Factura:</span><span>${factura.numero_factura}</span></div>
<div class="row"><span class="label">Placa:</span><span>${factura.placa || '—'}</span></div>
${factura.tipo_cobro ? `<div class="row"><span class="label">Tarifa:</span><span>${factura.tipo_cobro}</span></div>` : ''}
<hr/>
<div class="row"><span class="label">Entrada:</span><span>${fmtDate(factura.fecha_entrada)}</span></div>
${esCierre ? `<div class="row"><span class="label">Salida:</span><span>${fmtDate(fechaSalida)}</span></div>` : ''}
<hr/>
${esCierre
  ? `<div class="total">TOTAL: ${fmtMoneda(total)}</div>`
  : `<div style="text-align:center;font-size:11px;margin:4px 0;">Ticket de entrada — pague al salir</div>`
}
<hr/>
<p class="footer">¡Gracias por su visita!</p>
<p class="footer">${fmtDate(new Date())}</p>
${esCierre ? '<script>window.onload=()=>{setTimeout(()=>window.print(),300);}<\/script>' : ''}
</body></html>`;
}

// ──── VEHÍCULOS ────

async function registrarEntrada(data) {
  const vehiculo = await Models.ParqVehiculo.create({
    placa: data.placa.toUpperCase().trim(),
    id_tipo_vehiculo: data.id_tipo_vehiculo,
    id_negocio: data.id_negocio,
    id_tarifa: data.id_tarifa || null,
    id_usuario_entrada: data.id_usuario,
    observaciones: data.observaciones || null,
    estado: 'A',
  });

  // Obtener tarifa para embed en factura
  let tarifa = null;
  if (data.id_tarifa) {
    tarifa = await Models.ParqTarifa.findOne({ where: { id_tarifa: data.id_tarifa }, attributes: ['tipo_cobro', 'valor'] });
  }

  const numero = await getNumeroFactura(data.id_negocio);
  const factura = await Models.ParqFactura.create({
    id_negocio:       data.id_negocio,
    numero_factura:   numero,
    id_vehiculo:      vehiculo.id_vehiculo,
    placa:            vehiculo.placa,
    id_tipo_vehiculo: data.id_tipo_vehiculo,
    id_tarifa:        data.id_tarifa || null,
    tipo_cobro:       tarifa?.tipo_cobro || null,
    valor_unitario:   tarifa ? Number(tarifa.valor) : 0,
    estado:           'A',
    fecha_entrada:    vehiculo.fecha_entrada,
  });

  // Re-fetch con asociaciones para el recibo
  const vehiculoConDatos = await Models.ParqVehiculo.findOne({
    where: { id_vehiculo: vehiculo.id_vehiculo },
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
      { model: Models.ParqTarifa,       as: 'tarifa',       attributes: ['tipo_cobro', 'valor'] },
    ],
  });

  return { ...vehiculoConDatos.toJSON(), id_factura: factura.id_factura, numero_factura: factura.numero_factura };
}

async function registrarSalida(idVehiculo, idNegocio, idUsuario, valorCobrado) {
  const vehiculo = await Models.ParqVehiculo.findOne({
    where: { id_vehiculo: idVehiculo, id_negocio: idNegocio, estado: 'A' },
  });
  if (!vehiculo) return null;

  const fechaSalida = new Date();
  vehiculo.fecha_salida      = fechaSalida;
  vehiculo.id_usuario_salida = idUsuario;
  vehiculo.valor_cobrado     = valorCobrado;
  vehiculo.estado            = 'S';
  await vehiculo.save();

  // Cerrar factura
  await Models.ParqFactura.update(
    { valor_total: valorCobrado, estado: 'C', fecha_cierre: fechaSalida },
    { where: { id_vehiculo: idVehiculo, id_negocio: idNegocio, estado: 'A' } }
  );

  // Retornar con número de factura para el recibo
  const factura = await Models.ParqFactura.findOne({
    where: { id_vehiculo: idVehiculo, id_negocio: idNegocio, estado: 'C' },
    order: [['fecha_cierre', 'DESC']],
  });

  // Re-fetch con asociaciones para el recibo
  const vehiculoConDatos = await Models.ParqVehiculo.findOne({
    where: { id_vehiculo: idVehiculo },
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
      { model: Models.ParqTarifa,       as: 'tarifa',       attributes: ['tipo_cobro', 'valor'] },
    ],
  });

  return { ...vehiculoConDatos.toJSON(), id_factura: factura?.id_factura, numero_factura: factura?.numero_factura };
}

async function getVehiculoActivoPorPlaca(placa, idNegocio) {
  return Models.ParqVehiculo.findOne({
    where: { placa: placa.toUpperCase().trim(), id_negocio: idNegocio, estado: 'A' },
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
      { model: Models.ParqTarifa,       as: 'tarifa',       attributes: ['tipo_cobro', 'valor'] },
    ],
  });
}

async function getFactura(idFactura, idNegocio) {
  return Models.ParqFactura.findOne({
    where: { id_factura: idFactura, id_negocio: idNegocio },
  });
}

async function getFacturaDeVehiculo(idVehiculo, idNegocio) {
  return Models.ParqFactura.findOne({
    where: { id_vehiculo: idVehiculo, id_negocio: idNegocio },
    order: [['fecha_creacion', 'DESC']],
  });
}

async function calcularCostoActual(idVehiculo, idNegocio) {
  const vehiculo = await Models.ParqVehiculo.findOne({
    where: { id_vehiculo: idVehiculo, id_negocio: idNegocio, estado: 'A' },
    include: [{ model: Models.ParqTarifa, as: 'tarifa', attributes: ['tipo_cobro', 'valor'] }],
  });
  if (!vehiculo) return null;
  const costo = calcularCosto(vehiculo.fecha_entrada, vehiculo.tarifa);
  return { id_vehiculo: idVehiculo, costo, tarifa: vehiculo.tarifa };
}

async function getFacturaHtml(idFactura, idNegocio, conSalida = false) {
  const factura = await Models.ParqFactura.findOne({ where: { id_factura: idFactura, id_negocio: idNegocio } });
  if (!factura) return null;
  const config = await Models.ParqConfiguracion.findOne({ where: { id_negocio: idNegocio } });
  return generarHtmlRecibo({
    factura: factura.toJSON(),
    config:  config?.toJSON(),
    fechaSalida: conSalida ? factura.fecha_cierre : null,
    total:       conSalida ? factura.valor_total   : null,
  });
}

async function getVehiculosActuales(idNegocio, { page = 1, limit = 20, placa } = {}) {
  const where = { id_negocio: idNegocio, estado: 'A' };
  if (placa) where.placa = { [Op.iLike]: `%${placa}%` };

  const offset = (page - 1) * limit;
  const { rows, count } = await Models.ParqVehiculo.findAndCountAll({
    where,
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
      { model: Models.ParqTarifa, as: 'tarifa', attributes: ['tipo_cobro', 'valor'] },
    ],
    order: [['fecha_entrada', 'DESC']],
    limit,
    offset,
    attributes: ['id_vehiculo', 'placa', 'fecha_entrada', 'observaciones', 'id_tipo_vehiculo', 'id_tarifa'],
  });

  return { vehiculos: rows, total: count, page, totalPages: Math.ceil(count / limit) };
}

async function getHistorialVehiculos(idNegocio, { page = 1, limit = 20, placa, desde, hasta } = {}) {
  const where = { id_negocio: idNegocio, estado: { [Op.in]: ['S', 'A'] } };
  if (placa) where.placa = { [Op.iLike]: `%${placa}%` };
  if (desde || hasta) {
    where.fecha_entrada = {};
    if (desde) where.fecha_entrada[Op.gte] = new Date(desde);
    if (hasta) where.fecha_entrada[Op.lte] = new Date(hasta);
  }

  const offset = (page - 1) * limit;
  const { rows, count } = await Models.ParqVehiculo.findAndCountAll({
    where,
    include: [
      { model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] },
    ],
    order: [['fecha_entrada', 'DESC']],
    limit,
    offset,
  });

  return { vehiculos: rows, total: count, page, totalPages: Math.ceil(count / limit) };
}

// ──── TARIFAS ────

async function getTarifas(idNegocio) {
  return Models.ParqTarifa.findAll({
    where: { id_negocio: idNegocio, estado: 'A' },
    include: [{ model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] }],
    order: [['id_tipo_vehiculo', 'ASC'], ['tipo_cobro', 'ASC']],
  });
}

async function createTarifa(data) {
  // Validar que no exista ya una tarifa activa para este tipo de vehículo + tipo de cobro + negocio
  const existe = await Models.ParqTarifa.findOne({
    where: {
      id_tipo_vehiculo: data.id_tipo_vehiculo,
      tipo_cobro: data.tipo_cobro,
      id_negocio: data.id_negocio,
      estado: 'A'
    }
  });
  
  if (existe) {
    const err = new Error('Ya existe una tarifa para este tipo de vehículo con el mismo tipo de cobro en este negocio');
    err.statusCode = 409; // Conflict
    throw err;
  }
  
  return Models.ParqTarifa.create(data);
}

async function updateTarifa(idTarifa, idNegocio, data) {
  const tarifa = await Models.ParqTarifa.findOne({
    where: { id_tarifa: idTarifa, id_negocio: idNegocio },
  });
  if (!tarifa) return null;
  
  // Si se está cambiando el tipo de vehículo o tipo de cobro, validar que no exista duplicado
  if (data.id_tipo_vehiculo || data.tipo_cobro) {
    const idTipoVehiculo = data.id_tipo_vehiculo || tarifa.id_tipo_vehiculo;
    const tipoCobro = data.tipo_cobro || tarifa.tipo_cobro;
    
    const existe = await Models.ParqTarifa.findOne({
      where: {
        id_tipo_vehiculo: idTipoVehiculo,
        tipo_cobro: tipoCobro,
        id_negocio: idNegocio,
        estado: 'A',
        id_tarifa: { [Op.ne]: idTarifa } // Excluir la tarifa que se está editando
      }
    });
    
    if (existe) {
      const err = new Error('Ya existe una tarifa para este tipo de vehículo con el mismo tipo de cobro en este negocio');
      err.statusCode = 409; // Conflict
      throw err;
    }
  }
  
  return tarifa.update(data);
}

async function deleteTarifa(idTarifa, idNegocio) {
  return Models.ParqTarifa.update(
    { estado: 'I' },
    { where: { id_tarifa: idTarifa, id_negocio: idNegocio } }
  );
}

// ──── TIPOS DE VEHÍCULO ────

async function getTiposVehiculo(idNegocio) {
  return Models.ParqTipoVehiculo.findAll({
    where: { id_negocio: idNegocio, estado: 'A' },
    order: [['nombre', 'ASC']],
  });
}

async function createTipoVehiculo(data) {
  return Models.ParqTipoVehiculo.create(data);
}

async function updateTipoVehiculo(id, idNegocio, data) {
  const tipo = await Models.ParqTipoVehiculo.findOne({
    where: { id_tipo_vehiculo: id, id_negocio: idNegocio },
  });
  if (!tipo) return null;
  return tipo.update(data);
}

// ──── CAPACIDAD ────

async function getCapacidad(idNegocio) {
  return Models.ParqCapacidad.findAll({
    where: { id_negocio: idNegocio, estado: 'A' },
    include: [{ model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] }],
  });
}

async function upsertCapacidad(idNegocio, idTipoVehiculo, espaciosTotal) {
  const [record] = await Models.ParqCapacidad.upsert({
    id_negocio: idNegocio,
    id_tipo_vehiculo: idTipoVehiculo,
    espacios_total: espaciosTotal,
    estado: 'A',
  }, {
    conflictFields: ['id_negocio', 'id_tipo_vehiculo'],
    returning: true,
  });
  return record;
}

// ──── CONFIGURACIÓN ────

async function getConfiguracion(idNegocio) {
  return Models.ParqConfiguracion.findOne({
    where: { id_negocio: idNegocio },
  });
}

async function upsertConfiguracion(idNegocio, data) {
  const existing = await Models.ParqConfiguracion.findOne({ where: { id_negocio: idNegocio } });
  if (existing) {
    return existing.update({ ...data, fecha_actualizacion: new Date() });
  }
  return Models.ParqConfiguracion.create({ ...data, id_negocio: idNegocio });
}

// ──── ABONADOS ────

async function getAbonados(idNegocio) {
  return Models.ParqAbonado.findAll({
    where: { id_negocio: idNegocio, estado: 'A' },
    include: [{ model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] }],
    order: [['nombre', 'ASC']],
  });
}

async function createAbonado(data) {
  return Models.ParqAbonado.create(data);
}

async function updateAbonado(id, idNegocio, data) {
  const abonado = await Models.ParqAbonado.findOne({
    where: { id_abonado: id, id_negocio: idNegocio },
  });
  if (!abonado) return null;
  return abonado.update(data);
}

// ──── CAJA ────

async function abrirCaja(idNegocio, idUsuario, montoApertura) {
  // Verificar que no haya una caja abierta
  const cajaAbierta = await Models.ParqCaja.findOne({
    where: { id_negocio: idNegocio, estado: 'A' },
  });
  if (cajaAbierta) return { error: 'Ya existe una caja abierta' };

  return Models.ParqCaja.create({
    id_negocio: idNegocio,
    id_usuario: idUsuario,
    monto_apertura: montoApertura,
    estado: 'A',
  });
}

async function cerrarCaja(idCaja, idNegocio, observaciones) {
  const caja = await Models.ParqCaja.findOne({
    where: { id_caja: idCaja, id_negocio: idNegocio, estado: 'A' },
    include: [{ model: Models.ParqMovimientoCaja, as: 'movimientos' }],
  });
  if (!caja) return null;

  const ingresos = caja.movimientos
    .filter(m => m.tipo === 'INGRESO')
    .reduce((sum, m) => sum + Number(m.monto), 0);
  const egresos = caja.movimientos
    .filter(m => m.tipo === 'EGRESO')
    .reduce((sum, m) => sum + Number(m.monto), 0);

  const montoCierre = Number(caja.monto_apertura) + ingresos - egresos;

  caja.monto_cierre = montoCierre;
  caja.fecha_cierre = new Date();
  caja.estado = 'C';
  caja.observaciones = observaciones || null;
  await caja.save();
  return caja;
}

async function getCajaAbierta(idNegocio) {
  return Models.ParqCaja.findOne({
    where: { id_negocio: idNegocio, estado: 'A' },
    include: [
      { model: Models.GenerUsuario, as: 'usuario', attributes: ['primer_nombre', 'primer_apellido'] },
    ],
  });
}

async function getMovimientosCaja(idCaja) {
  return Models.ParqMovimientoCaja.findAll({
    where: { id_caja: idCaja },
    include: [
      { model: Models.GenerUsuario, as: 'usuario', attributes: ['primer_nombre', 'primer_apellido'] },
    ],
    order: [['fecha', 'DESC']],
  });
}

async function registrarMovimientoCaja(data) {
  return Models.ParqMovimientoCaja.create(data);
}

module.exports = {
  // Vehículos
  registrarEntrada, registrarSalida, getVehiculosActuales, getHistorialVehiculos,
  getVehiculoActivoPorPlaca,
  // Facturas
  getFactura, getFacturaDeVehiculo, calcularCostoActual, getFacturaHtml,
  // Tarifas
  getTarifas, createTarifa, updateTarifa, deleteTarifa,
  // Tipos vehículo
  getTiposVehiculo, createTipoVehiculo, updateTipoVehiculo,
  // Capacidad
  getCapacidad, upsertCapacidad,
  // Configuración
  getConfiguracion, upsertConfiguracion,
  // Abonados
  getAbonados, createAbonado, updateAbonado,
  // Caja
  abrirCaja, cerrarCaja, getCajaAbierta, getMovimientosCaja, registrarMovimientoCaja,
};
