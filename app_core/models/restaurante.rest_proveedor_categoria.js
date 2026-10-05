module.exports = (sequelize, DataTypes) => {
  /** Ficha ↔ categorías del catálogo estándar. Tabla puente sin valor propio. */
  const RestProveedorCategoria = sequelize.define('RestProveedorCategoria', {
    id_proveedor:      { type: DataTypes.INTEGER, primaryKey: true },
    id_categoria_prov: { type: DataTypes.INTEGER, primaryKey: true },
  }, {
    tableName: 'rest_proveedor_categoria', schema: 'restaurante', timestamps: false,
  });

  return RestProveedorCategoria;
};
