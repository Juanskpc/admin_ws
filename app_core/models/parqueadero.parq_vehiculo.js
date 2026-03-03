module.exports = (sequelize, DataTypes) => {
  const ParqVehiculo = sequelize.define('ParqVehiculo', {
    id_vehiculo:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    placa:             { type: DataTypes.STRING(20), allowNull: false },
    id_tipo_vehiculo:  { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false },
    fecha_entrada:     { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    fecha_salida:      DataTypes.DATE,
    id_tarifa:         DataTypes.INTEGER,
    valor_cobrado:     DataTypes.DECIMAL(12, 2),
    id_usuario_entrada: DataTypes.INTEGER,
    id_usuario_salida:  DataTypes.INTEGER,
    observaciones:     DataTypes.TEXT,
    estado:            { type: DataTypes.CHAR(1), defaultValue: 'A' }, // A=Dentro, S=Salió, X=Anulado
    fecha_creacion:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_vehiculo', schema: 'parqueadero', timestamps: false,
  });

  ParqVehiculo.associate = (models) => {
    ParqVehiculo.belongsTo(models.ParqTipoVehiculo, { foreignKey: 'id_tipo_vehiculo', as: 'tipoVehiculo' });
    ParqVehiculo.belongsTo(models.GenerNegocio,      { foreignKey: 'id_negocio',       as: 'negocio' });
    ParqVehiculo.belongsTo(models.ParqTarifa,         { foreignKey: 'id_tarifa',        as: 'tarifa' });
    ParqVehiculo.belongsTo(models.GenerUsuario,       { foreignKey: 'id_usuario_entrada', as: 'usuarioEntrada' });
    ParqVehiculo.belongsTo(models.GenerUsuario,       { foreignKey: 'id_usuario_salida',  as: 'usuarioSalida' });
  };

  return ParqVehiculo;
};
