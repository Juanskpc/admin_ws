module.exports = (sequelize, DataTypes) => {
  const RestMetodoPago = sequelize.define('RestMetodoPago', {
    id_metodo_pago: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(80), allowNull: false },
    // A dónde se paga: el Nequi, la cuenta del banco, «se paga al domiciliario».
    // Texto libre porque cada negocio lo dice a su manera; lo lee el asistente para
    // decírselo al cliente al preguntarle cómo paga.
    datos_pago:     { type: DataTypes.STRING(200), allowNull: true },
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
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
