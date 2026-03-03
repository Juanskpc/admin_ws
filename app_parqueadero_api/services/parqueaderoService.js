const Models = require('../../app_core/models/conection');
const { Op } = require('sequelize');

// ──── VEHÍCULOS ────

async function registrarEntrada(data) {
  return Models.ParqVehiculo.create({
    placa: data.placa.toUpperCase().trim(),
    id_tipo_vehiculo: data.id_tipo_vehiculo,
    id_negocio: data.id_negocio,
    id_tarifa: data.id_tarifa || null,
    id_usuario_entrada: data.id_usuario,
    observaciones: data.observaciones || null,
    estado: 'A',
  });
}

async function registrarSalida(idVehiculo, idNegocio, idUsuario, valorCobrado) {
  const vehiculo = await Models.ParqVehiculo.findOne({
    where: { id_vehiculo: idVehiculo, id_negocio: idNegocio, estado: 'A' },
  });
  if (!vehiculo) return null;

  vehiculo.fecha_salida = new Date();
  vehiculo.id_usuario_salida = idUsuario;
  vehiculo.valor_cobrado = valorCobrado;
  vehiculo.estado = 'S';
  await vehiculo.save();
  return vehiculo;
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
  return Models.ParqTarifa.create(data);
}

async function updateTarifa(idTarifa, idNegocio, data) {
  const tarifa = await Models.ParqTarifa.findOne({
    where: { id_tarifa: idTarifa, id_negocio: idNegocio },
  });
  if (!tarifa) return null;
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
