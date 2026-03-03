module.exports = (sequelize, DataTypes) => {
  const ParqAbonado = sequelize.define('ParqAbonado', {
    id_abonado:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre:            { type: DataTypes.STRING(200), allowNull: false },
    documento:         DataTypes.STRING(50),
    telefono:          DataTypes.STRING(50),
    placa:             { type: DataTypes.STRING(20), allowNull: false },
    id_tipo_vehiculo:  { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false },
    fecha_inicio:      { type: DataTypes.DATEONLY, allowNull: false },
    fecha_fin:         { type: DataTypes.DATEONLY, allowNull: false },
    valor_mensualidad: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    estado:            { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_abonado', schema: 'parqueadero', timestamps: false,
  });

  ParqAbonado.associate = (models) => {
    ParqAbonado.belongsTo(models.ParqTipoVehiculo, { foreignKey: 'id_tipo_vehiculo', as: 'tipoVehiculo' });
    ParqAbonado.belongsTo(models.GenerNegocio,      { foreignKey: 'id_negocio',       as: 'negocio' });
  };

  return ParqAbonado;
};
