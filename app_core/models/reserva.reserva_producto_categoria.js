module.exports = (sequelize, DataTypes) => {
  const ReservaProductoCategoria = sequelize.define('ReservaProductoCategoria', {
    id_categoria: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:   { type: DataTypes.INTEGER, allowNull: false },
    nombre:       { type: DataTypes.STRING(120), allowNull: false },
    descripcion:  DataTypes.TEXT,
    /** Posición en el portal público, como en `reserva_categoria`. */
    orden:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    estado:       { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_producto_categoria', schema: 'reserva', timestamps: false,
  });

  ReservaProductoCategoria.associate = (models) => {
    ReservaProductoCategoria.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaProductoCategoria.hasMany(models.ReservaProducto, { foreignKey: 'id_categoria', as: 'productos' });
  };

  return ReservaProductoCategoria;
};
