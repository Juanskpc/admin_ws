module.exports = (sequelize, DataTypes) => {
  const ParqTipoVehiculo = sequelize.define('ParqTipoVehiculo', {
    id_tipo_vehiculo: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre:           { type: DataTypes.STRING(100), allowNull: false },
    descripcion:      DataTypes.STRING(255),
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    estado:           { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_tipo_vehiculo', schema: 'parqueadero', timestamps: false,
  });

  ParqTipoVehiculo.associate = (models) => {
    ParqTipoVehiculo.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ParqTipoVehiculo.hasMany(models.ParqTarifa,     { foreignKey: 'id_tipo_vehiculo', as: 'tarifas' });
    ParqTipoVehiculo.hasMany(models.ParqVehiculo,    { foreignKey: 'id_tipo_vehiculo', as: 'vehiculos' });
    ParqTipoVehiculo.hasMany(models.ParqCapacidad,   { foreignKey: 'id_tipo_vehiculo', as: 'capacidades' });
  };

  return ParqTipoVehiculo;
};
