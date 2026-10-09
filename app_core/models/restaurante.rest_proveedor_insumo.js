module.exports = (sequelize, DataTypes) => {
  /**
   * Un insumo que un proveedor vende, con su precio.
   *
   * La fila es **del negocio que la escribió** (`id_negocio`), no del proveedor: el precio es
   * una negociación, no un hecho del mundo. Dos restaurantes pueden tener su propia fila del
   * mismo insumo del mismo proveedor con precios distintos, y ninguno ve la del otro salvo
   * que se marque `publico` Y la ficha esté en visibilidad `DIRECTORIO`. Las dos condiciones,
   * nunca una sola.
   *
   * `id_ingrediente` lo ata al inventario del restaurante (`carta_ingrediente`). Es opcional,
   * y es lo que hace que una compra sume stock y que el comparador sepa que dos filas hablan
   * del mismo insumo.
   */
  const RestProveedorInsumo = sequelize.define('RestProveedorInsumo', {
    id_proveedor_insumo:   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_proveedor:          { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:            { type: DataTypes.INTEGER, allowNull: false },
    nombre:                { type: DataTypes.STRING(160), allowNull: false },
    id_categoria_prov:     DataTypes.INTEGER,
    id_ingrediente:        DataTypes.INTEGER,

    /** KG · G · L · ML · UN · CAJA · BULTO · PAQUETE · OTRA */
    unidad:                { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'UN' },
    presentacion:          DataTypes.STRING(80),
    /**
     * Cuántas unidades base trae la presentación: una caja de 12 → 12. Sin este número el
     * comparador no puede poner «caja» y «unidad» en la misma columna sin mentir, así que
     * cuando es NULL avisa en vez de normalizar a ciegas.
     */
    cantidad_presentacion: DataTypes.DECIMAL(12, 3),

    precio:                DataTypes.DECIMAL(12, 2),
    moneda:                { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'COP' },
    fecha_precio:          DataTypes.DATEONLY,
    publico:               { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    disponible:            { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    marca:                 DataTypes.STRING(80),
    codigo_proveedor:      DataTypes.STRING(60),
    notas:                 DataTypes.TEXT,
    estado:                { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion:        { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_proveedor_insumo', schema: 'restaurante', timestamps: false,
  });

  RestProveedorInsumo.associate = (models) => {
    RestProveedorInsumo.belongsTo(models.RestProveedor, { foreignKey: 'id_proveedor', as: 'proveedor' });
    RestProveedorInsumo.belongsTo(models.CartaIngrediente, { foreignKey: 'id_ingrediente', as: 'ingrediente' });
    RestProveedorInsumo.belongsTo(models.RestProveedorCategoriaCat, {
      foreignKey: 'id_categoria_prov', as: 'categoria',
    });
    RestProveedorInsumo.hasMany(models.RestProveedorPrecio, {
      foreignKey: 'id_proveedor_insumo', as: 'historicoPrecios',
    });
  };

  return RestProveedorInsumo;
};
