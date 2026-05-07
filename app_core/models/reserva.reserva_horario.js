module.exports = (sequelize, DataTypes) => {
  const ReservaHorario = sequelize.define('ReservaHorario', {
    id_horario:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_profesional: DataTypes.INTEGER,
    dia_semana:     { type: DataTypes.SMALLINT, allowNull: false }, // 0=Dom..6=Sab
    hora_inicio:    { type: DataTypes.TIME, allowNull: false },
    hora_fin:       { type: DataTypes.TIME, allowNull: false },
  }, {
    tableName: 'reserva_horario', schema: 'reserva', timestamps: false,
  });

  ReservaHorario.associate = (models) => {
    ReservaHorario.belongsTo(models.GenerNegocio,       { foreignKey: 'id_negocio',     as: 'negocio' });
    ReservaHorario.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
  };

  return ReservaHorario;
};
