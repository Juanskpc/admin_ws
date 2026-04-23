module.exports = (sequelize, DataTypes) => {
  const GymProducto = sequelize.define('GymProducto', {
    id_producto:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:         { type: DataTypes.INTEGER, allowNull: false },
    nombre:             { type: DataTypes.STRING(160), allowNull: false },
    sku:                DataTypes.STRING(60),
    descripcion:        DataTypes.TEXT,
    categoria:          DataTypes.STRING(80),
    precio:             { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    costo:              DataTypes.DECIMAL(12, 2),
    stock_actual:       { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    stock_minimo:       { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    foto_url:           DataTypes.STRING(500),
    estado:             { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:{ type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'gym_producto', schema: 'gym', timestamps: false,
  });

  GymProducto.associate = (models) => {
    GymProducto.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return GymProducto;
};
