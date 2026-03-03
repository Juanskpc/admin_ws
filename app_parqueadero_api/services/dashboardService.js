const Models = require('../../app_core/models/conection');
const { Op, fn, col, literal } = require('sequelize');

/**
 * Verifica que el usuario tenga acceso a un negocio de tipo PARQUEADERO.
 */
async function verificarAccesoParqueadero(idUsuario) {
  const usuario = await Models.GenerUsuario.findOne({
    where: { id_usuario: idUsuario, estado: 'A' },
    attributes: ['id_usuario', 'primer_nombre', 'segundo_nombre', 'primer_apellido',
                 'segundo_apellido', 'email', 'num_identificacion'],
  });
  if (!usuario) return null;

  const negociosUsuario = await Models.GenerNegocioUsuario.findAll({
    where: { id_usuario: idUsuario, estado: 'A' },
    include: [{
      model: Models.GenerNegocio,
      as: 'negocio',
      where: { estado: 'A' },
      required: true,
      include: [
        { model: Models.GenerTipoNegocio, as: 'tipoNegocio', attributes: ['id_tipo_negocio', 'nombre'] },
        { model: Models.GenerPaletaColor, as: 'paletaColor', attributes: ['id_paleta', 'nombre', 'colores'] },
      ],
      attributes: ['id_negocio', 'nombre', 'id_tipo_negocio', 'id_paleta'],
    }],
  });

  // Filtrar solo negocios de tipo PARQUEADERO (id_tipo_negocio = 2)
  const negociosParqueadero = negociosUsuario.filter(
    nu => nu.negocio && nu.negocio.tipoNegocio && nu.negocio.tipoNegocio.nombre === 'PARQUEADERO'
  );
  if (negociosParqueadero.length === 0) return null;

  const idNegocios = negociosParqueadero.map(nu => nu.negocio.id_negocio);
  const rolesUsuario = await Models.GenerUsuarioRol.findAll({
    where: { id_usuario: idUsuario, estado: 'A', id_negocio: idNegocios },
    include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
  });

  const negocios = negociosParqueadero.map(nu => {
    const negocio = nu.negocio;
    const roles = rolesUsuario
      .filter(r => r.id_negocio === negocio.id_negocio)
      .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));
    return {
      id_negocio: negocio.id_negocio,
      nombre: negocio.nombre,
      tipo_negocio: negocio.tipoNegocio ? negocio.tipoNegocio.nombre : null,
      paleta: negocio.paletaColor || null,
      roles,
    };
  });

  const rolesGlobales = await Models.GenerUsuarioRol.findAll({
    where: { id_usuario: idUsuario, estado: 'A', id_negocio: null },
    include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
  });

  // Cargar permisos de nivel del parqueadero (id_tipo_negocio = 2, sin auth).
  // Usa la tabla gener_nivel_usuario para filtrar; si no hay asignación explícita
  // se concede acceso completo (fallback).
  const nivelesAsignados = await Models.GenerNivelUsuario.findAll({
    where: { id_usuario: idUsuario },
    include: [{
      model: Models.GenerNivel,
      as: 'GenerNivel',
      where: {
        id_tipo_negocio: 2,
        estado: 'A',
      },
      attributes: ['id_nivel', 'descripcion', 'id_nivel_padre', 'id_tipo_nivel', 'url', 'icono'],
    }],
  });

  let niveles;
  if (nivelesAsignados.length === 0) {
    // Sin asignación explícita → acceso completo al módulo por defecto
    const todosLosNiveles = await Models.GenerNivel.findAll({
      where: { id_tipo_negocio: 2, estado: 'A' },
      attributes: ['id_nivel', 'descripcion', 'id_nivel_padre', 'id_tipo_nivel', 'url', 'icono'],
      order: [['id_nivel', 'ASC']],
    });
    niveles = todosLosNiveles.map(n => n.get({ plain: true }));
  } else {
    niveles = nivelesAsignados.map(nu => nu.GenerNivel.get({ plain: true }));
  }

  return {
    usuario: {
      id_usuario: usuario.id_usuario,
      nombre_completo: `${usuario.primer_nombre} ${usuario.primer_apellido}`,
      primer_nombre: usuario.primer_nombre,
      primer_apellido: usuario.primer_apellido,
      email: usuario.email,
    },
    negocios,
    negocio: negocios[0] || null,
    roles: negocios[0]?.roles || [],
    roles_globales: rolesGlobales.map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion })),
    niveles,
  };
}

/**
 * Obtiene el resumen del dashboard del parqueadero.
 */
async function getResumenDashboard(idUsuario, idNegocio) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  // Vehículos actualmente en el parqueadero
  const vehiculosActuales = await Models.ParqVehiculo.count({
    where: { id_negocio: idNegocio, estado: 'A' },
  });

  // Capacidad total
  const capacidades = await Models.ParqCapacidad.findAll({
    where: { id_negocio: idNegocio, estado: 'A' },
  });
  const capacidadTotal = capacidades.reduce((sum, c) => sum + (c.espacios_total || 0), 0);

  // Ingresos del día
  const ingresosHoy = await Models.ParqVehiculo.sum('valor_cobrado', {
    where: {
      id_negocio: idNegocio,
      estado: 'S',
      fecha_salida: { [Op.gte]: hoy },
    },
  }) || 0;

  // Vehículos que salieron hoy
  const salidasHoy = await Models.ParqVehiculo.count({
    where: {
      id_negocio: idNegocio,
      estado: 'S',
      fecha_salida: { [Op.gte]: hoy },
    },
  });

  // Entradas hoy
  const entradasHoy = await Models.ParqVehiculo.count({
    where: {
      id_negocio: idNegocio,
      fecha_entrada: { [Op.gte]: hoy },
    },
  });

  // Últimos 5 vehículos que entraron
  const ultimosVehiculos = await Models.ParqVehiculo.findAll({
    where: { id_negocio: idNegocio, estado: 'A' },
    include: [{ model: Models.ParqTipoVehiculo, as: 'tipoVehiculo', attributes: ['nombre'] }],
    order: [['fecha_entrada', 'DESC']],
    limit: 5,
    attributes: ['id_vehiculo', 'placa', 'fecha_entrada'],
  });

  return {
    kpis: {
      vehiculos_actuales: vehiculosActuales,
      capacidad_total: capacidadTotal,
      ocupacion_porcentaje: capacidadTotal > 0 ? Math.round((vehiculosActuales / capacidadTotal) * 100) : 0,
      ingresos_hoy: Number(ingresosHoy),
      entradas_hoy: entradasHoy,
      salidas_hoy: salidasHoy,
    },
    ultimos_vehiculos: ultimosVehiculos.map(v => ({
      id_vehiculo: v.id_vehiculo,
      placa: v.placa,
      tipo: v.tipoVehiculo?.nombre || 'N/A',
      fecha_entrada: v.fecha_entrada,
    })),
  };
}

module.exports = { verificarAccesoParqueadero, getResumenDashboard };
