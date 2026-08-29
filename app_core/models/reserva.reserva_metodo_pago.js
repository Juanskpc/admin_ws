module.exports = (sequelize, DataTypes) => {
  const ReservaMetodoPago = sequelize.define('ReservaMetodoPago', {
    id_metodo_pago: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(80), allowNull: false },
    orden:          { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_metodo_pago', schema: 'reserva', timestamps: false,
  });

  ReservaMetodoPago.associate = (models) => {
    ReservaMetodoPago.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return ReservaMetodoPago;
};
