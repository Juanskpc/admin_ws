module.exports = (sequelize, DataTypes) => {
  const RestMovimientoCaja = sequelize.define('RestMovimientoCaja', {
    id_movimiento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_caja:       { type: DataTypes.INTEGER, allowNull: false },
    tipo:          { type: DataTypes.STRING(10), allowNull: false }, // INGRESO | EGRESO
    monto:         { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    concepto:      DataTypes.STRING(255),
    id_orden:      DataTypes.INTEGER,
    id_usuario:    { type: DataTypes.INTEGER, allowNull: false },
    fecha:         { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_movimiento_caja', schema: 'restaurante', timestamps: false,
  });

  RestMovimientoCaja.associate = (models) => {
    RestMovimientoCaja.belongsTo(models.RestCaja,     { foreignKey: 'id_caja',    as: 'caja' });
    RestMovimientoCaja.belongsTo(models.PedidOrden,   { foreignKey: 'id_orden',   as: 'orden' });
    RestMovimientoCaja.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
  };

  return RestMovimientoCaja;
};
