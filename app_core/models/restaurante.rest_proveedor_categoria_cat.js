module.exports = (sequelize, DataTypes) => {
  /**
   * Catálogo ESTÁNDAR de categorías de proveedor. Del sistema, no del negocio: sin
   * `id_negocio`, y nadie lo amplía desde la aplicación.
   *
   * Si cada restaurante escribiera las suyas («carnicos», «CARNES», «carne y pollo»), el
   * directorio compartido dejaría de poder filtrarse y el comparador no encontraría nada.
   * Se amplía con una migración, que es donde se decide qué significa cada categoría.
   */
  const RestProveedorCategoriaCat = sequelize.define('RestProveedorCategoriaCat', {
    id_categoria_prov: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    codigo:            { type: DataTypes.STRING(40), allowNull: false },
    nombre:            { type: DataTypes.STRING(80), allowNull: false },
    icono:             DataTypes.STRING(40),
    orden:             { type: DataTypes.INTEGER, allowNull: false, defaultValue: 500 },
    estado:            { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_proveedor_categoria_cat', schema: 'restaurante', timestamps: false,
  });

  RestProveedorCategoriaCat.associate = (models) => {
    RestProveedorCategoriaCat.belongsToMany(models.RestProveedor, {
      through: models.RestProveedorCategoria,
      foreignKey: 'id_categoria_prov',
      otherKey: 'id_proveedor',
      as: 'proveedores',
    });
  };

  return RestProveedorCategoriaCat;
};
