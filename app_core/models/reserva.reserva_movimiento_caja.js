module.exports = (sequelize, DataTypes) => {
  const ReservaMovimientoCaja = sequelize.define('ReservaMovimientoCaja', {
    id_movimiento:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_caja:        { type: DataTypes.INTEGER, allowNull: false },
    tipo:           { type: DataTypes.STRING(10), allowNull: false }, // INGRESO | EGRESO
    monto:          { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    concepto:       DataTypes.STRING(255),
    id_cita:        DataTypes.INTEGER,
    // Quién PRESTÓ el servicio, no quién cobró. Es lo que permite liquidar al final del día
    // sin reconstruirlo desde la cita, que puede haber cambiado de profesional.
    id_profesional: DataTypes.INTEGER,
    id_metodo_pago: DataTypes.INTEGER,
    id_usuario:     { type: DataTypes.INTEGER, allowNull: false },
    fecha:          { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_movimiento_caja', schema: 'reserva', timestamps: false,
  });

  ReservaMovimientoCaja.associate = (models) => {
    ReservaMovimientoCaja.belongsTo(models.ReservaCaja,        { foreignKey: 'id_caja',        as: 'caja' });
    ReservaMovimientoCaja.belongsTo(models.ReservaCita,        { foreignKey: 'id_cita',        as: 'cita' });
    ReservaMovimientoCaja.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
    ReservaMovimientoCaja.belongsTo(models.ReservaMetodoPago,  { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
    ReservaMovimientoCaja.belongsTo(models.GenerUsuario,       { foreignKey: 'id_usuario',     as: 'usuario' });
  };

  return ReservaMovimientoCaja;
};
