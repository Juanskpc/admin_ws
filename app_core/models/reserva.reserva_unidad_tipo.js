/**
 * Tipo de unidad que se reserva por noches: «Habitación doble», «Cabaña 4 personas», «Canil
 * mediano». Lleva la tarifa; las unidades concretas (la 101, la 102) viven en `reserva_unidad`.
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaUnidadTipo = sequelize.define('ReservaUnidadTipo', {
    id_unidad_tipo:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:           { type: DataTypes.INTEGER, allowNull: false },
    nombre:               { type: DataTypes.STRING(100), allowNull: false },
    descripcion:          DataTypes.TEXT,
    ocupacion_base:       { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 2 },
    capacidad_max:        { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 2 },
    tarifa_base:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    tarifa_fin_semana:    { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    tarifa_persona_extra: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    min_noches:           { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    comodidades:          { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    imagen_url:           DataTypes.STRING(500),
    orden:                { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:               { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_unidad_tipo', schema: 'reserva', timestamps: false,
  });

  ReservaUnidadTipo.associate = (models) => {
    ReservaUnidadTipo.hasMany(models.ReservaUnidad, { foreignKey: 'id_unidad_tipo', as: 'unidades' });
    ReservaUnidadTipo.hasMany(models.ReservaTarifaTemporada, { foreignKey: 'id_unidad_tipo', as: 'temporadas' });
  };

  return ReservaUnidadTipo;
};
