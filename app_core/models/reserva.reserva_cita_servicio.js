module.exports = (sequelize, DataTypes) => {
  const ReservaCitaServicio = sequelize.define('ReservaCitaServicio', {
    id_cita:               { type: DataTypes.INTEGER, primaryKey: true },
    id_servicio:           { type: DataTypes.INTEGER, primaryKey: true },
    precio_snapshot:       { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    duracion_snapshot_min: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    tableName: 'reserva_cita_servicio', schema: 'reserva', timestamps: false,
  });

  ReservaCitaServicio.associate = (models) => {
    ReservaCitaServicio.belongsTo(models.ReservaCita,     { foreignKey: 'id_cita',     as: 'cita' });
    ReservaCitaServicio.belongsTo(models.ReservaServicio, { foreignKey: 'id_servicio', as: 'servicio' });
  };

  return ReservaCitaServicio;
};
