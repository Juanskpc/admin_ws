module.exports = (sequelize, DataTypes) => {
  const ParqTarifa = sequelize.define('ParqTarifa', {
    id_tarifa:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_tipo_vehiculo: { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    tipo_cobro:       { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'HORA' },
    valor:            { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    descripcion:      DataTypes.STRING(255),
    estado:           { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_tarifa', schema: 'parqueadero', timestamps: false,
  });

  ParqTarifa.associate = (models) => {
    ParqTarifa.belongsTo(models.ParqTipoVehiculo, { foreignKey: 'id_tipo_vehiculo', as: 'tipoVehiculo' });
    ParqTarifa.belongsTo(models.GenerNegocio,      { foreignKey: 'id_negocio',       as: 'negocio' });
  };

  return ParqTarifa;
};
