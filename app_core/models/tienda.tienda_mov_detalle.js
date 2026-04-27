module.exports = (sequelize, DataTypes) => {
  const TiendaMovDetalle = sequelize.define('TiendaMovDetalle', {
    id_detalle:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_movimiento:  { type: DataTypes.INTEGER, allowNull: false },
    id_producto:    { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    cantidad:       { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    costo_unitario: DataTypes.DECIMAL(14, 2),
    subtotal:       { type: DataTypes.DECIMAL(14, 2) },
  }, {
    tableName: 'tienda_mov_detalle', schema: 'tienda', timestamps: false,
  });

  TiendaMovDetalle.associate = (models) => {
    TiendaMovDetalle.belongsTo(models.TiendaMovimiento, { foreignKey: 'id_movimiento', as: 'movimiento' });
    TiendaMovDetalle.belongsTo(models.TiendaProducto,   { foreignKey: 'id_producto',   as: 'producto' });
  };

  return TiendaMovDetalle;
};
