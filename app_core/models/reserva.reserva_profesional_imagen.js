/** Una foto del portafolio de un profesional (trabajos de un tatuador, cortes de un estilista). */
module.exports = (sequelize, DataTypes) => {
  const ReservaProfesionalImagen = sequelize.define('ReservaProfesionalImagen', {
    id_imagen:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    id_profesional: { type: DataTypes.INTEGER, allowNull: false },
    url:            { type: DataTypes.STRING(500), allowNull: false },
    descripcion:    DataTypes.STRING(200),
    orden:          { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_profesional_imagen', schema: 'reserva', timestamps: false,
  });

  ReservaProfesionalImagen.associate = (models) => {
    ReservaProfesionalImagen.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
    models.ReservaProfesional.hasMany(ReservaProfesionalImagen, { foreignKey: 'id_profesional', as: 'portafolio' });
  };

  return ReservaProfesionalImagen;
};
