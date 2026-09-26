/**
 * Calendario iCal de otra plataforma (Airbnb, Booking) para una unidad. Se importa cada pocos
 * minutos y cada evento se convierte en un bloqueo de la unidad: así una noche vendida allí no
 * se vende otra vez aquí.
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaCalendarioExterno = sequelize.define('ReservaCalendarioExterno', {
    id_calendario:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:            { type: DataTypes.INTEGER, allowNull: false },
    id_unidad:             { type: DataTypes.INTEGER, allowNull: false },
    nombre:                { type: DataTypes.STRING(60), allowNull: false },
    url_ical:              { type: DataTypes.STRING(1000), allowNull: false },
    ultima_sincronizacion: DataTypes.DATE,
    ultimo_error:          DataTypes.TEXT,
    estado:                { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:        { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_calendario_externo', schema: 'reserva', timestamps: false,
  });

  ReservaCalendarioExterno.associate = (models) => {
    ReservaCalendarioExterno.belongsTo(models.ReservaUnidad, { foreignKey: 'id_unidad', as: 'unidad' });
  };

  return ReservaCalendarioExterno;
};
