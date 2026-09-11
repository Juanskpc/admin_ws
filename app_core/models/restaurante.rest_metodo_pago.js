module.exports = (sequelize, DataTypes) => {
  const RestMetodoPago = sequelize.define('RestMetodoPago', {
    id_metodo_pago: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(80), allowNull: false },
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
    // Marca la forma de pago «Cuenta / Tiquetera». No es una etiqueta: es lo que le dice al
    // cobro que ese dinero NO entra al cajón hoy y que hay que descontarlo de la cuenta del
    // cliente. Hay como mucho una por negocio y la siembra migrate:restaurante-cuentas.
    es_cuenta:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_metodo_pago', schema: 'restaurante', timestamps: false,
  });

  RestMetodoPago.associate = (models) => {
    RestMetodoPago.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestMetodoPago.hasMany(models.PedidOrden, { foreignKey: 'id_metodo_pago', as: 'ordenes' });
  };

  return RestMetodoPago;
};
