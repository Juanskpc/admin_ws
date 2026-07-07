module.exports = (sequelize, DataTypes) => {
  const RestPagoOrden = sequelize.define('RestPagoOrden', {
    id_pago:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_orden:       { type: DataTypes.INTEGER, allowNull: false },
    id_metodo_pago: { type: DataTypes.INTEGER, allowNull: false },
    valor:          { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    fecha:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_pago_orden', schema: 'restaurante', timestamps: false,
  });

  RestPagoOrden.associate = (models) => {
    RestPagoOrden.belongsTo(models.PedidOrden, { foreignKey: 'id_orden', as: 'orden' });
    RestPagoOrden.belongsTo(models.RestMetodoPago, { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
    // Detalle de pagos de la orden (multipago). Para pago simple queda vacío.
    models.PedidOrden.hasMany(RestPagoOrden, { foreignKey: 'id_orden', as: 'pagos' });
  };

  return RestPagoOrden;
};
