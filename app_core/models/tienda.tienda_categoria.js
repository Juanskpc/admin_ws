module.exports = (sequelize, DataTypes) => {
  const TiendaCategoria = sequelize.define('TiendaCategoria', {
    id_categoria:   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(120), allowNull: false },
    descripcion:    DataTypes.TEXT,
    icono:          DataTypes.STRING(20),
    orden:          { type: DataTypes.INTEGER, defaultValue: 0 },
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tienda_categoria', schema: 'tienda', timestamps: false,
  });

  TiendaCategoria.associate = (models) => {
    TiendaCategoria.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    TiendaCategoria.hasMany(models.TiendaProducto, { foreignKey: 'id_categoria', as: 'productos' });
  };

  return TiendaCategoria;
};
