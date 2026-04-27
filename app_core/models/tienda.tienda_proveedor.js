module.exports = (sequelize, DataTypes) => {
  const TiendaProveedor = sequelize.define('TiendaProveedor', {
    id_proveedor:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(160), allowNull: false },
    nit_rut:             DataTypes.STRING(40),
    email:               DataTypes.STRING(160),
    telefono:            DataTypes.STRING(40),
    direccion:           DataTypes.STRING(255),
    contacto:            DataTypes.STRING(120),
    notas:               DataTypes.TEXT,
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tienda_proveedor', schema: 'tienda', timestamps: false,
  });

  TiendaProveedor.associate = (models) => {
    TiendaProveedor.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    TiendaProveedor.hasMany(models.TiendaProducto, { foreignKey: 'id_proveedor', as: 'productos' });
  };

  return TiendaProveedor;
};
