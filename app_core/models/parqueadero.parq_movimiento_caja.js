module.exports = (sequelize, DataTypes) => {
  const ParqMovimientoCaja = sequelize.define('ParqMovimientoCaja', {
    id_movimiento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_caja:       { type: DataTypes.INTEGER, allowNull: false },
    tipo:          { type: DataTypes.STRING(10), allowNull: false }, // INGRESO | EGRESO
    monto:         { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    concepto:      DataTypes.STRING(255),
    id_vehiculo:   DataTypes.INTEGER,
    id_usuario:    { type: DataTypes.INTEGER, allowNull: false },
    fecha:         { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_movimiento_caja', schema: 'parqueadero', timestamps: false,
  });

  ParqMovimientoCaja.associate = (models) => {
    ParqMovimientoCaja.belongsTo(models.ParqCaja,     { foreignKey: 'id_caja',     as: 'caja' });
    ParqMovimientoCaja.belongsTo(models.ParqVehiculo,  { foreignKey: 'id_vehiculo', as: 'vehiculo' });
    ParqMovimientoCaja.belongsTo(models.GenerUsuario,  { foreignKey: 'id_usuario',  as: 'usuario' });
  };

  return ParqMovimientoCaja;
};
