/** Una foto adicional de un servicio (trabajos de ejemplo: tatuajes, transformaciones…). */
module.exports = (sequelize, DataTypes) => {
  const ReservaServicioImagen = sequelize.define('ReservaServicioImagen', {
    id_imagen:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_servicio:    { type: DataTypes.INTEGER, allowNull: false },
    url:            { type: DataTypes.STRING(500), allowNull: false },
    descripcion:    DataTypes.STRING(200),
    orden:          { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_servicio_imagen', schema: 'reserva', timestamps: false,
  });

  ReservaServicioImagen.associate = (models) => {
    ReservaServicioImagen.belongsTo(models.ReservaServicio, { foreignKey: 'id_servicio', as: 'servicio' });
    models.ReservaServicio.hasMany(ReservaServicioImagen, { foreignKey: 'id_servicio', as: 'galeria' });
  };

  return ReservaServicioImagen;
};
