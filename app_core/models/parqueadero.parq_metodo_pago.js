module.exports = (sequelize, DataTypes) => {
  const ParqMetodoPago = sequelize.define('ParqMetodoPago', {
    id_metodo_pago: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre:         { type: DataTypes.STRING(100), allowNull: false },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_metodo_pago', schema: 'parqueadero', timestamps: false,
  });

  ParqMetodoPago.associate = (models) => {
    ParqMetodoPago.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return ParqMetodoPago;
};
