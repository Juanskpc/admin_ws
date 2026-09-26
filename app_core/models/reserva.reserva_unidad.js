/** Una unidad concreta: la habitación 101, la Cabaña Roble, el canil 3. */
module.exports = (sequelize, DataTypes) => {
  const ReservaUnidad = sequelize.define('ReservaUnidad', {
    id_unidad:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    id_unidad_tipo:      { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(60), allowNull: false },
    notas:               DataTypes.STRING(255),
    /** Secreto del calendario exportado (iCal). No se expone en listados públicos. */
    ical_token:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4 },
    orden:               { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_unidad', schema: 'reserva', timestamps: false,
  });

  ReservaUnidad.associate = (models) => {
    ReservaUnidad.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaUnidad.belongsTo(models.ReservaUnidadTipo, { foreignKey: 'id_unidad_tipo', as: 'tipo' });
    ReservaUnidad.hasMany(models.ReservaEstancia, { foreignKey: 'id_unidad', as: 'estancias' });
    ReservaUnidad.hasMany(models.ReservaCalendarioExterno, { foreignKey: 'id_unidad', as: 'calendarios' });
  };

  return ReservaUnidad;
};
