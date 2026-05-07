module.exports = (sequelize, DataTypes) => {
  const ReservaBloqueo = sequelize.define('ReservaBloqueo', {
    id_bloqueo:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_profesional: DataTypes.INTEGER,
    fecha_inicio:   { type: DataTypes.DATE, allowNull: false },
    fecha_fin:      { type: DataTypes.DATE, allowNull: false },
    motivo:         DataTypes.STRING(200),
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_bloqueo', schema: 'reserva', timestamps: false,
  });

  ReservaBloqueo.associate = (models) => {
    ReservaBloqueo.belongsTo(models.GenerNegocio,       { foreignKey: 'id_negocio',     as: 'negocio' });
    ReservaBloqueo.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
  };

  return ReservaBloqueo;
};
