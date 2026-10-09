module.exports = (sequelize, DataTypes) => {
  /**
   * Histórico de precios de un insumo de proveedor. **Append-only**: una fila por cambio, y
   * nunca se actualiza ni se borra — lo que vale de un histórico es que no se pueda reescribir.
   *
   * `origen = 'COMPRA'` es el que vale más: ese precio salió de una factura, no de lo que
   * alguien recordaba.
   */
  const RestProveedorPrecio = sequelize.define('RestProveedorPrecio', {
    id_precio:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_proveedor_insumo: { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    precio:              { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    moneda:              { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'COP' },
    /** MANUAL · COMPRA */
    origen:              { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MANUAL' },
    id_compra:           DataTypes.INTEGER,
    id_usuario:          DataTypes.INTEGER,
    fecha:               { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_proveedor_precio', schema: 'restaurante', timestamps: false,
  });

  RestProveedorPrecio.associate = (models) => {
    RestProveedorPrecio.belongsTo(models.RestProveedorInsumo, {
      foreignKey: 'id_proveedor_insumo', as: 'insumo',
    });
  };

  return RestProveedorPrecio;
};
