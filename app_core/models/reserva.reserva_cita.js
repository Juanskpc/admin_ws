module.exports = (sequelize, DataTypes) => {
  const ReservaCita = sequelize.define('ReservaCita', {
    id_cita:                       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:                    { type: DataTypes.INTEGER, allowNull: false },
    id_profesional:                { type: DataTypes.INTEGER, allowNull: false },
    fecha_hora_inicio:             { type: DataTypes.DATE,    allowNull: false },
    fecha_hora_fin:                { type: DataTypes.DATE,    allowNull: false },
    estado:                        { type: DataTypes.STRING(20), defaultValue: 'pendiente' },
    cliente_nombre:                { type: DataTypes.STRING(150), allowNull: false },
    cliente_telefono:              DataTypes.STRING(30),
    cliente_email:                 DataTypes.STRING(120),
    notas:                         DataTypes.TEXT,
    codigo_publico:                { type: DataTypes.UUID, allowNull: false, defaultValue: DataTypes.UUIDV4 },
    creado_por_id_usuario:         DataTypes.INTEGER,
    cancelado_por:                 DataTypes.STRING(20),  // 'cliente' | 'negocio'
    cancelado_motivo:              DataTypes.TEXT,
    requiere_pago:                 { type: DataTypes.BOOLEAN, defaultValue: false },
    monto_total:                   { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    comprobante_pago_url:          DataTypes.STRING(500),
    pago_estado:                   { type: DataTypes.STRING(25), defaultValue: 'no_aplica' },
    pago_validado_por_id_usuario:  DataTypes.INTEGER,
    pago_validado_en:              DataTypes.DATE,
    pago_rechazo_motivo:           DataTypes.TEXT,
    fecha_creacion:                { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:           { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_cita', schema: 'reserva', timestamps: false,
  });

  ReservaCita.associate = (models) => {
    ReservaCita.belongsTo(models.GenerNegocio,       { foreignKey: 'id_negocio',           as: 'negocio' });
    ReservaCita.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional',       as: 'profesional' });
    ReservaCita.belongsTo(models.GenerUsuario,       { foreignKey: 'creado_por_id_usuario', as: 'creadoPor' });
    ReservaCita.belongsTo(models.GenerUsuario,       { foreignKey: 'pago_validado_por_id_usuario', as: 'pagoValidadoPor' });
    ReservaCita.hasMany(models.ReservaCitaServicio,  { foreignKey: 'id_cita', as: 'servicios' });
    ReservaCita.belongsToMany(models.ReservaServicio, {
      through: models.ReservaCitaServicio,
      foreignKey: 'id_cita',
      otherKey: 'id_servicio',
      as: 'serviciosIncluidos',
    });
  };

  return ReservaCita;
};
