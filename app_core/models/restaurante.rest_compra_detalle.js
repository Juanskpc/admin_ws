module.exports = (sequelize, DataTypes) => {
  /**
   * Un renglón de la factura de compra.
   *
   * `descripcion` se guarda SIEMPRE, aunque el renglón esté ligado a un insumo: tiene que
   * seguir leyéndose dentro de un año aunque el insumo se haya renombrado o borrado.
   *
   * `stock_sumado` es lo que de verdad entró al inventario, en la unidad del ingrediente, y
   * es lo que se resta al anular. Vale 0 cuando el renglón no toca el inventario.
   */
  const RestCompraDetalle = sequelize.define('RestCompraDetalle', {
    id_detalle:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_compra:           { type: DataTypes.INTEGER, allowNull: false },
    id_proveedor_insumo: DataTypes.INTEGER,
    id_ingrediente:      DataTypes.INTEGER,
    descripcion:         { type: DataTypes.STRING(160), allowNull: false },
    cantidad:            { type: DataTypes.DECIMAL(12, 3), allowNull: false },
    unidad:              { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'UN' },
    precio_unitario:     { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    descuento:           { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    total:               { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    stock_sumado:        { type: DataTypes.DECIMAL(12, 3), allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'rest_compra_detalle', schema: 'restaurante', timestamps: false,
  });

  RestCompraDetalle.associate = (models) => {
    RestCompraDetalle.belongsTo(models.RestCompra, { foreignKey: 'id_compra', as: 'compra' });
    RestCompraDetalle.belongsTo(models.RestProveedorInsumo, {
      foreignKey: 'id_proveedor_insumo', as: 'insumo',
    });
    RestCompraDetalle.belongsTo(models.CartaIngrediente, {
      foreignKey: 'id_ingrediente', as: 'ingrediente',
    });
  };

  return RestCompraDetalle;
};
