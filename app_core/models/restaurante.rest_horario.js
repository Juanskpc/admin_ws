module.exports = (sequelize, DataTypes) => {
  /**
   * Horario semanal, del negocio (id_usuario NULL) o de un domiciliario (id_usuario con valor).
   * Misma forma que reserva.reserva_horario, tabla propia por ADR-005 (independencia de
   * verticales): ver migrate_restaurante_horario.js.
   */
  const RestHorario = sequelize.define('RestHorario', {
    id_horario:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:  { type: DataTypes.INTEGER, allowNull: false },
    id_usuario:  { type: DataTypes.INTEGER, allowNull: true },
    dia_semana:  { type: DataTypes.SMALLINT, allowNull: false }, // 0=Dom..6=Sáb
    hora_inicio: { type: DataTypes.TIME, allowNull: false },
    hora_fin:    { type: DataTypes.TIME, allowNull: false },
  }, {
    tableName: 'rest_horario', schema: 'restaurante', timestamps: false,
  });

  RestHorario.associate = (models) => {
    RestHorario.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestHorario.belongsTo(models.GenerUsuario,  { foreignKey: 'id_usuario', as: 'usuario' });
  };

  return RestHorario;
};
