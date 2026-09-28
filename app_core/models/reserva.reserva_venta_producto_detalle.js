module.exports = (sequelize, DataTypes) => {
  const ReservaVentaProductoDetalle = sequelize.define('ReservaVentaProductoDetalle', {
    id_detalle:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_venta:        { type: DataTypes.INTEGER, allowNull: false },
    id_producto:     { type: DataTypes.INTEGER, allowNull: false },
    /** Congelados al vender: si el producto cambia de nombre o precio después, esta línea no se entera. */
    nombre_snapshot:  { type: DataTypes.STRING(150), allowNull: false },
    precio_snapshot:  { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    cantidad:         { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 1 },
    subtotal:         { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  }, {
    tableName: 'reserva_venta_producto_detalle', schema: 'reserva', timestamps: false,
  });

  ReservaVentaProductoDetalle.associate = (models) => {
    ReservaVentaProductoDetalle.belongsTo(models.ReservaVentaProducto, { foreignKey: 'id_venta', as: 'venta' });
    ReservaVentaProductoDetalle.belongsTo(models.ReservaProducto, { foreignKey: 'id_producto', as: 'producto' });
  };

  return ReservaVentaProductoDetalle;
};
