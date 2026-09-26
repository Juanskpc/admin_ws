/**
 * Noches en que una unidad no se puede vender: mantenimiento (manual) o reservada en otra
 * plataforma (importada por iCal). Rango `[fecha_desde, fecha_hasta)`, como una estancia.
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaBloqueoUnidad = sequelize.define('ReservaBloqueoUnidad', {
    id_bloqueo:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_unidad:      { type: DataTypes.INTEGER, allowNull: false },
    fecha_desde:    { type: DataTypes.DATEONLY, allowNull: false },
    fecha_hasta:    { type: DataTypes.DATEONLY, allowNull: false },
    motivo:         DataTypes.STRING(255),
    origen:         { type: DataTypes.STRING(10), defaultValue: 'manual' },
    id_calendario:  DataTypes.INTEGER,
    uid_externo:    DataTypes.STRING(255),
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_bloqueo_unidad', schema: 'reserva', timestamps: false,
  });

  ReservaBloqueoUnidad.associate = (models) => {
    ReservaBloqueoUnidad.belongsTo(models.ReservaUnidad, { foreignKey: 'id_unidad', as: 'unidad' });
    ReservaBloqueoUnidad.belongsTo(models.ReservaCalendarioExterno, { foreignKey: 'id_calendario', as: 'calendario' });
  };

  return ReservaBloqueoUnidad;
};
