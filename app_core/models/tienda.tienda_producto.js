module.exports = (sequelize, DataTypes) => {
  const TiendaProducto = sequelize.define('TiendaProducto', {
    id_producto:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    id_categoria:        DataTypes.INTEGER,
    id_proveedor:        DataTypes.INTEGER,
    nombre:              { type: DataTypes.STRING(200), allowNull: false },
    descripcion:         DataTypes.TEXT,
    sku:                 DataTypes.STRING(80),
    codigo_barras:       DataTypes.STRING(80),
    precio_venta:        { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    precio_costo:        { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    stock_actual:        { type: DataTypes.DECIMAL(14, 3), defaultValue: 0 },
    stock_minimo:        { type: DataTypes.DECIMAL(14, 3), defaultValue: 0 },
    unidad_medida:       { type: DataTypes.STRING(30), defaultValue: 'und' },
    imagen_url:          DataTypes.STRING(500),
    ubicacion:           DataTypes.STRING(120),
    es_servicio:         { type: DataTypes.BOOLEAN, defaultValue: false },
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tienda_producto', schema: 'tienda', timestamps: false,
  });

  TiendaProducto.associate = (models) => {
    TiendaProducto.belongsTo(models.GenerNegocio,    { foreignKey: 'id_negocio',   as: 'negocio' });
    TiendaProducto.belongsTo(models.TiendaCategoria, { foreignKey: 'id_categoria', as: 'categoria' });
    TiendaProducto.belongsTo(models.TiendaProveedor, { foreignKey: 'id_proveedor', as: 'proveedor' });
  };

  return TiendaProducto;
};
