module.exports = (sequelize, DataTypes) => {
  const ReservaConfig = sequelize.define('ReservaConfig', {
    id_negocio:                { type: DataTypes.INTEGER, primaryKey: true },
    anticipacion_min_horas:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    buffer_limpieza_min:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    ventana_cancelacion_horas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },
    paso_slot_min:             { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
    cobro_adelantado:          { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    instrucciones_pago:        DataTypes.TEXT,
    fecha_creacion:            { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_config', schema: 'reserva', timestamps: false,
  });

  ReservaConfig.associate = (models) => {
    ReservaConfig.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return ReservaConfig;
};
