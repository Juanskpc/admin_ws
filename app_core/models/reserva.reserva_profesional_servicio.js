module.exports = (sequelize, DataTypes) => {
  const ReservaProfesionalServicio = sequelize.define('ReservaProfesionalServicio', {
    id_profesional: { type: DataTypes.INTEGER, primaryKey: true },
    id_servicio:    { type: DataTypes.INTEGER, primaryKey: true },
  }, {
    tableName: 'reserva_profesional_servicio', schema: 'reserva', timestamps: false,
  });

  return ReservaProfesionalServicio;
};
