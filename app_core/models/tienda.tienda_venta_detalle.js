module.exports = (sequelize, DataTypes) => {
  const TiendaVentaDetalle = sequelize.define('TiendaVentaDetalle', {
    id_detalle:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_venta:        { type: DataTypes.INTEGER, allowNull: false },
    id_producto:     { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:      { type: DataTypes.INTEGER, allowNull: false },
    cantidad:        { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    precio_unitario: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    descuento:       { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    subtotal:        { type: DataTypes.DECIMAL(14, 2) },
  }, {
    tableName: 'tienda_venta_detalle', schema: 'tienda', timestamps: false,
  });

  TiendaVentaDetalle.associate = (models) => {
    TiendaVentaDetalle.belongsTo(models.TiendaVenta,    { foreignKey: 'id_venta',    as: 'venta' });
    TiendaVentaDetalle.belongsTo(models.TiendaProducto, { foreignKey: 'id_producto', as: 'producto' });
  };

  return TiendaVentaDetalle;
};
