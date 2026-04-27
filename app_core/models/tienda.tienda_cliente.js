module.exports = (sequelize, DataTypes) => {
  const TiendaCliente = sequelize.define('TiendaCliente', {
    id_cliente:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(160), allowNull: false },
    tipo_doc:            DataTypes.STRING(20),
    num_doc:             DataTypes.STRING(40),
    email:               DataTypes.STRING(160),
    telefono:            DataTypes.STRING(40),
    direccion:           DataTypes.STRING(255),
    notas:               DataTypes.TEXT,
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tienda_cliente', schema: 'tienda', timestamps: false,
  });

  TiendaCliente.associate = (models) => {
    TiendaCliente.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    TiendaCliente.hasMany(models.TiendaVenta, { foreignKey: 'id_cliente', as: 'ventas' });
  };

  return TiendaCliente;
};
