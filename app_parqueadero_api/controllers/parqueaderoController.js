const { validationResult } = require('express-validator');
const ParqService = require('../services/parqueaderoService');
const Respuesta = require('../../app_core/helpers/respuesta');

// ──── VEHÍCULOS ────

async function registrarEntrada(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());

    const { placa, id_tipo_vehiculo, id_negocio, id_tarifa, observaciones } = req.body;
    const vehiculo = await ParqService.registrarEntrada({
      placa, id_tipo_vehiculo, id_negocio, id_tarifa, observaciones,
      id_usuario: req.usuario.id_usuario,
    });
    return Respuesta.success(res, 'Entrada registrada', vehiculo, 201);
  } catch (err) {
    console.error('Error en registrarEntrada:', err);
    return Respuesta.error(res, 'Error al registrar la entrada');
  }
}

async function registrarSalida(req, res) {
  try {
    const { id } = req.params;
    const { valor_cobrado } = req.body;
    const idNegocio = parseInt(req.body.id_negocio || req.query.id_negocio, 10);
    const vehiculo = await ParqService.registrarSalida(
      parseInt(id, 10), idNegocio, req.usuario.id_usuario, valor_cobrado
    );
    if (!vehiculo) return Respuesta.error(res, 'Vehículo no encontrado o ya salió', 404);
    return Respuesta.success(res, 'Salida registrada', vehiculo);
  } catch (err) {
    console.error('Error en registrarSalida:', err);
    return Respuesta.error(res, 'Error al registrar la salida');
  }
}

async function buscarVehiculo(req, res) {
  try {
    const placa    = String(req.query.placa    || '').toUpperCase().trim();
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!placa || !idNegocio) return Respuesta.error(res, 'placa e id_negocio requeridos', 400);
    const vehiculo = await ParqService.getVehiculoActivoPorPlaca(placa, idNegocio);
    if (!vehiculo) return Respuesta.error(res, 'No hay un vehículo activo con esa placa', 404);
    return Respuesta.success(res, 'Vehículo encontrado', vehiculo);
  } catch (err) {
    console.error('Error en buscarVehiculo:', err);
    return Respuesta.error(res, 'Error al buscar vehículo');
  }
}

async function getFactura(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const factura = await ParqService.getFactura(parseInt(id, 10), idNegocio);
    if (!factura) return Respuesta.error(res, 'Factura no encontrada', 404);
    return Respuesta.success(res, 'Factura obtenida', factura);
  } catch (err) {
    console.error('Error en getFactura:', err);
    return Respuesta.error(res, 'Error al obtener la factura');
  }
}

async function getFacturaPdf(req, res) {
  try {
    const { id } = req.params;
    const idNegocio  = parseInt(req.query.id_negocio, 10);
    const conSalida  = req.query.con_salida === 'true';
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const html = await ParqService.getFacturaHtml(parseInt(id, 10), idNegocio, conSalida);
    if (!html) return Respuesta.error(res, 'Factura no encontrada', 404);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (err) {
    console.error('Error en getFacturaPdf:', err);
    return Respuesta.error(res, 'Error al generar el recibo');
  }
}

async function calcularCosto(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const result = await ParqService.calcularCostoActual(parseInt(id, 10), idNegocio);
    if (!result) return Respuesta.error(res, 'Vehículo no encontrado', 404);
    return Respuesta.success(res, 'Costo calculado', result);
  } catch (err) {
    console.error('Error en calcularCosto:', err);
    return Respuesta.error(res, 'Error al calcular el costo');
  }
}

async function getVehiculosActuales(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const { page, limit, placa } = req.query;
    const result = await ParqService.getVehiculosActuales(idNegocio, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      placa,
    });
    return Respuesta.success(res, 'Vehículos actuales', result);
  } catch (err) {
    console.error('Error en getVehiculosActuales:', err);
    return Respuesta.error(res, 'Error al obtener los vehículos');
  }
}

async function getHistorialVehiculos(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const { page, limit, placa, desde, hasta } = req.query;
    const result = await ParqService.getHistorialVehiculos(idNegocio, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      placa, desde, hasta,
    });
    return Respuesta.success(res, 'Historial de vehículos', result);
  } catch (err) {
    console.error('Error en getHistorialVehiculos:', err);
    return Respuesta.error(res, 'Error al obtener el historial');
  }
}

// ──── TARIFAS ────

async function getTarifas(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const tarifas = await ParqService.getTarifas(idNegocio);
    return Respuesta.success(res, 'Tarifas obtenidas', tarifas);
  } catch (err) {
    console.error('Error en getTarifas:', err);
    return Respuesta.error(res, 'Error al obtener tarifas');
  }
}

async function createTarifa(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    const tarifa = await ParqService.createTarifa(req.body);
    return Respuesta.success(res, 'Tarifa creada', tarifa, 201);
  } catch (err) {
    console.error('Error en createTarifa:', err);
    if (err.statusCode === 409) {
      return Respuesta.error(res, err.message, 409);
    }
    return Respuesta.error(res, 'Error al crear la tarifa');
  }
}

async function updateTarifa(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.body.id_negocio, 10);
    const tarifa = await ParqService.updateTarifa(parseInt(id, 10), idNegocio, req.body);
    if (!tarifa) return Respuesta.error(res, 'Tarifa no encontrada', 404);
    return Respuesta.success(res, 'Tarifa actualizada', tarifa);
  } catch (err) {
    console.error('Error en updateTarifa:', err);
    return Respuesta.error(res, 'Error al actualizar la tarifa');
  }
}

async function deleteTarifa(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.query.id_negocio, 10);
    await ParqService.deleteTarifa(parseInt(id, 10), idNegocio);
    return Respuesta.success(res, 'Tarifa eliminada');
  } catch (err) {
    console.error('Error en deleteTarifa:', err);
    return Respuesta.error(res, 'Error al eliminar la tarifa');
  }
}

// ──── TIPOS DE VEHÍCULO ────

async function getTiposVehiculo(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const tipos = await ParqService.getTiposVehiculo(idNegocio);
    return Respuesta.success(res, 'Tipos de vehículo obtenidos', tipos);
  } catch (err) {
    console.error('Error en getTiposVehiculo:', err);
    return Respuesta.error(res, 'Error al obtener tipos de vehículo');
  }
}

async function createTipoVehiculo(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    const tipo = await ParqService.createTipoVehiculo(req.body);
    return Respuesta.success(res, 'Tipo de vehículo creado', tipo, 201);
  } catch (err) {
    console.error('Error en createTipoVehiculo:', err);
    return Respuesta.error(res, 'Error al crear tipo de vehículo');
  }
}

async function updateTipoVehiculo(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.body.id_negocio, 10);
    const tipo = await ParqService.updateTipoVehiculo(parseInt(id, 10), idNegocio, req.body);
    if (!tipo) return Respuesta.error(res, 'Tipo de vehículo no encontrado', 404);
    return Respuesta.success(res, 'Tipo de vehículo actualizado', tipo);
  } catch (err) {
    console.error('Error en updateTipoVehiculo:', err);
    return Respuesta.error(res, 'Error al actualizar tipo de vehículo');
  }
}

// ──── CAPACIDAD ────

async function getCapacidad(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const capacidad = await ParqService.getCapacidad(idNegocio);
    return Respuesta.success(res, 'Capacidad obtenida', capacidad);
  } catch (err) {
    console.error('Error en getCapacidad:', err);
    return Respuesta.error(res, 'Error al obtener la capacidad');
  }
}

async function upsertCapacidad(req, res) {
  try {
    const { id_negocio, id_tipo_vehiculo, espacios_total } = req.body;
    const record = await ParqService.upsertCapacidad(id_negocio, id_tipo_vehiculo, espacios_total);
    return Respuesta.success(res, 'Capacidad actualizada', record);
  } catch (err) {
    console.error('Error en upsertCapacidad:', err);
    return Respuesta.error(res, 'Error al actualizar la capacidad');
  }
}

// ──── CONFIGURACIÓN ────

async function getConfiguracion(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const config = await ParqService.getConfiguracion(idNegocio);
    return Respuesta.success(res, 'Configuración obtenida', config);
  } catch (err) {
    console.error('Error en getConfiguracion:', err);
    return Respuesta.error(res, 'Error al obtener la configuración');
  }
}

async function upsertConfiguracion(req, res) {
  try {
    const { id_negocio, ...data } = req.body;
    const config = await ParqService.upsertConfiguracion(id_negocio, data);
    return Respuesta.success(res, 'Configuración guardada', config);
  } catch (err) {
    console.error('Error en upsertConfiguracion:', err);
    return Respuesta.error(res, 'Error al guardar la configuración');
  }
}

// ──── ABONADOS ────

async function getAbonados(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const abonados = await ParqService.getAbonados(idNegocio);
    return Respuesta.success(res, 'Abonados obtenidos', abonados);
  } catch (err) {
    console.error('Error en getAbonados:', err);
    return Respuesta.error(res, 'Error al obtener abonados');
  }
}

async function createAbonado(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    const abonado = await ParqService.createAbonado(req.body);
    return Respuesta.success(res, 'Abonado creado', abonado, 201);
  } catch (err) {
    console.error('Error en createAbonado:', err);
    return Respuesta.error(res, 'Error al crear el abonado');
  }
}

async function updateAbonado(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.body.id_negocio, 10);
    const abonado = await ParqService.updateAbonado(parseInt(id, 10), idNegocio, req.body);
    if (!abonado) return Respuesta.error(res, 'Abonado no encontrado', 404);
    return Respuesta.success(res, 'Abonado actualizado', abonado);
  } catch (err) {
    console.error('Error en updateAbonado:', err);
    return Respuesta.error(res, 'Error al actualizar el abonado');
  }
}

// ──── CAJA ────

async function abrirCaja(req, res) {
  try {
    const { id_negocio, monto_apertura } = req.body;
    const result = await ParqService.abrirCaja(id_negocio, req.usuario.id_usuario, monto_apertura || 0);
    if (result.error) return Respuesta.error(res, result.error, 400);
    return Respuesta.success(res, 'Caja abierta', result, 201);
  } catch (err) {
    console.error('Error en abrirCaja:', err);
    return Respuesta.error(res, 'Error al abrir la caja');
  }
}

async function cerrarCaja(req, res) {
  try {
    const { id } = req.params;
    const idNegocio = parseInt(req.body.id_negocio, 10);
    const caja = await ParqService.cerrarCaja(parseInt(id, 10), idNegocio, req.body.observaciones);
    if (!caja) return Respuesta.error(res, 'Caja no encontrada o ya cerrada', 404);
    return Respuesta.success(res, 'Caja cerrada', caja);
  } catch (err) {
    console.error('Error en cerrarCaja:', err);
    return Respuesta.error(res, 'Error al cerrar la caja');
  }
}

async function getCajaAbierta(req, res) {
  try {
    const idNegocio = parseInt(req.query.id_negocio, 10);
    if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
    const caja = await ParqService.getCajaAbierta(idNegocio);
    return Respuesta.success(res, caja ? 'Caja abierta encontrada' : 'No hay caja abierta', caja);
  } catch (err) {
    console.error('Error en getCajaAbierta:', err);
    return Respuesta.error(res, 'Error al buscar caja abierta');
  }
}

async function getMovimientosCaja(req, res) {
  try {
    const { id } = req.params;
    const movimientos = await ParqService.getMovimientosCaja(parseInt(id, 10));
    return Respuesta.success(res, 'Movimientos obtenidos', movimientos);
  } catch (err) {
    console.error('Error en getMovimientosCaja:', err);
    return Respuesta.error(res, 'Error al obtener movimientos');
  }
}

async function registrarMovimientoCaja(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    const mov = await ParqService.registrarMovimientoCaja({
      ...req.body,
      id_usuario: req.usuario.id_usuario,
    });
    return Respuesta.success(res, 'Movimiento registrado', mov, 201);
  } catch (err) {
    console.error('Error en registrarMovimientoCaja:', err);
    return Respuesta.error(res, 'Error al registrar el movimiento');
  }
}

module.exports = {
  registrarEntrada, registrarSalida, buscarVehiculo,
  getVehiculosActuales, getHistorialVehiculos,
  getTarifas, createTarifa, updateTarifa, deleteTarifa,
  getTiposVehiculo, createTipoVehiculo, updateTipoVehiculo,
  getCapacidad, upsertCapacidad,
  getConfiguracion, upsertConfiguracion,
  getAbonados, createAbonado, updateAbonado,
  abrirCaja, cerrarCaja, getCajaAbierta, getMovimientosCaja, registrarMovimientoCaja,
  getFactura, getFacturaPdf, calcularCosto,
};
