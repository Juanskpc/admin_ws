module.exports = (sequelize, DataTypes) => {
  const ReservaHold = sequelize.define('ReservaHold', {
    id_hold:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    codigo:            { type: DataTypes.UUID, allowNull: false, defaultValue: DataTypes.UUIDV4 },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false },
    id_profesional:    { type: DataTypes.INTEGER, allowNull: false },
    fecha_hora_inicio: { type: DataTypes.DATE, allowNull: false },
    fecha_hora_fin:    { type: DataTypes.DATE, allowNull: false },
    expira_en:         { type: DataTypes.DATE, allowNull: false },
    estado:            { type: DataTypes.STRING(20), defaultValue: 'activo' },
    id_cita:           DataTypes.INTEGER,
    // Sequelize descarta en silencio los atributos no declarados: si esta línea falta, el
    // `create()` guardaría el hold SIN los servicios y confirmar no sabría qué reservar.
    id_servicios:      { type: DataTypes.ARRAY(DataTypes.INTEGER), defaultValue: [] },
    creado_en:         { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_hold', schema: 'reserva', timestamps: false,
  });

  ReservaHold.associate = (models) => {
    ReservaHold.belongsTo(models.GenerNegocio,       { foreignKey: 'id_negocio',     as: 'negocio' });
    ReservaHold.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
    ReservaHold.belongsTo(models.ReservaCita,        { foreignKey: 'id_cita',        as: 'cita' });
  };

  return ReservaHold;
};
