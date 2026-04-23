module.exports = (sequelize, DataTypes) => {
  const GymVentaDetalle = sequelize.define('GymVentaDetalle', {
    id_detalle:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_venta:        { type: DataTypes.INTEGER, allowNull: false },
    id_producto:     { type: DataTypes.INTEGER, allowNull: false },
    cantidad:        { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    precio_unitario: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    subtotal:        { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  }, {
    tableName: 'gym_venta_detalle', schema: 'gym', timestamps: false,
  });

  GymVentaDetalle.associate = (models) => {
    GymVentaDetalle.belongsTo(models.GymVenta,    { foreignKey: 'id_venta',    as: 'venta' });
    GymVentaDetalle.belongsTo(models.GymProducto, { foreignKey: 'id_producto', as: 'producto' });
  };

  return GymVentaDetalle;
};
