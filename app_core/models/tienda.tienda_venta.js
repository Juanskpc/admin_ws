module.exports = (sequelize, DataTypes) => {
  const TiendaVenta = sequelize.define('TiendaVenta', {
    id_venta:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_cliente:     DataTypes.INTEGER,
    id_usuario:     DataTypes.INTEGER,
    subtotal:       { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    descuento:      { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    total:          { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    metodo_pago:    { type: DataTypes.STRING(30), defaultValue: 'EFECTIVO' },
    estado:         { type: DataTypes.STRING(20), defaultValue: 'COMPLETADA' },
    notas:          DataTypes.TEXT,
    fecha_venta:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tienda_venta', schema: 'tienda', timestamps: false,
  });

  TiendaVenta.associate = (models) => {
    TiendaVenta.belongsTo(models.GenerNegocio,      { foreignKey: 'id_negocio', as: 'negocio' });
    TiendaVenta.belongsTo(models.TiendaCliente,     { foreignKey: 'id_cliente', as: 'cliente' });
    TiendaVenta.belongsTo(models.GenerUsuario,      { foreignKey: 'id_usuario', as: 'usuario' });
    TiendaVenta.hasMany(models.TiendaVentaDetalle,  { foreignKey: 'id_venta',   as: 'detalles' });
  };

  return TiendaVenta;
};
