/** Precio por noche de un tipo de unidad en un rango de fechas (temporada alta, puentes). */
module.exports = (sequelize, DataTypes) => {
  const ReservaTarifaTemporada = sequelize.define('ReservaTarifaTemporada', {
    id_tarifa:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_unidad_tipo: { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(80), allowNull: false },
    /** Noches a las que aplica, ambas inclusive. */
    desde:          { type: DataTypes.DATEONLY, allowNull: false },
    hasta:          { type: DataTypes.DATEONLY, allowNull: false },
    precio_noche:   { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    min_noches:     { type: DataTypes.SMALLINT, allowNull: true },
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_tarifa_temporada', schema: 'reserva', timestamps: false,
  });

  return ReservaTarifaTemporada;
};
