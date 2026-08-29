module.exports = (sequelize, DataTypes) => {
  const ReservaPagoCita = sequelize.define('ReservaPagoCita', {
    id_pago:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_cita:        { type: DataTypes.INTEGER, allowNull: false },
    id_metodo_pago: { type: DataTypes.INTEGER, allowNull: false },
    valor:          { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    fecha:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_pago_cita', schema: 'reserva', timestamps: false,
  });

  ReservaPagoCita.associate = (models) => {
    ReservaPagoCita.belongsTo(models.ReservaCita,       { foreignKey: 'id_cita',        as: 'cita' });
    ReservaPagoCita.belongsTo(models.ReservaMetodoPago, { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
    // Desglose multipago de la cita. En pago simple queda vacío.
    models.ReservaCita.hasMany(ReservaPagoCita, { foreignKey: 'id_cita', as: 'pagos' });
  };

  return ReservaPagoCita;
};
