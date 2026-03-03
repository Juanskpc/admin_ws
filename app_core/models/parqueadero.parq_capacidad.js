module.exports = (sequelize, DataTypes) => {
  const ParqCapacidad = sequelize.define('ParqCapacidad', {
    id_capacidad:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    id_tipo_vehiculo: { type: DataTypes.INTEGER, allowNull: false },
    espacios_total:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    estado:           { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_capacidad', schema: 'parqueadero', timestamps: false,
  });

  ParqCapacidad.associate = (models) => {
    ParqCapacidad.belongsTo(models.GenerNegocio,      { foreignKey: 'id_negocio',       as: 'negocio' });
    ParqCapacidad.belongsTo(models.ParqTipoVehiculo,   { foreignKey: 'id_tipo_vehiculo', as: 'tipoVehiculo' });
  };

  return ParqCapacidad;
};
