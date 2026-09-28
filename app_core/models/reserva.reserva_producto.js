module.exports = (sequelize, DataTypes) => {
  const ReservaProducto = sequelize.define('ReservaProducto', {
    id_producto:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:   { type: DataTypes.INTEGER, allowNull: false },
    id_categoria: { type: DataTypes.INTEGER, allowNull: true },
    nombre:       { type: DataTypes.STRING(150), allowNull: false },
    descripcion:  DataTypes.TEXT,
    precio:       { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    imagen_url:   DataTypes.STRING(500),
    /** Apagado por defecto: la mayoría de negocios no va a mantener un inventario al día. */
    controla_stock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    stock_actual:   { type: DataTypes.DECIMAL(14, 3), allowNull: false, defaultValue: 0 },
    /** Se ve en el portal público. `false` = solo se vende de mostrador. */
    publico_activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    estado:       { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_producto', schema: 'reserva', timestamps: false,
  });

  ReservaProducto.associate = (models) => {
    ReservaProducto.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaProducto.belongsTo(models.ReservaProductoCategoria, { foreignKey: 'id_categoria', as: 'categoria' });
  };

  return ReservaProducto;
};
