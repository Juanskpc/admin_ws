module.exports = (sequelize, DataTypes) => {
  const ReservaServicio = sequelize.define('ReservaServicio', {
    id_servicio:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(150), allowNull: false },
    descripcion:         DataTypes.TEXT,
    duracion_min:        { type: DataTypes.INTEGER, allowNull: false },
    precio:              { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    color_hex:           { type: DataTypes.CHAR(7), defaultValue: '#3b82f6' },
    imagen_url:          DataTypes.STRING(500),
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_servicio', schema: 'reserva', timestamps: false,
  });

  ReservaServicio.associate = (models) => {
    ReservaServicio.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaServicio.belongsToMany(models.ReservaProfesional, {
      through: models.ReservaProfesionalServicio,
      foreignKey: 'id_servicio',
      otherKey: 'id_profesional',
      as: 'profesionales',
    });
    ReservaServicio.hasMany(models.ReservaCitaServicio, { foreignKey: 'id_servicio', as: 'citasIncluyen' });
  };

  return ReservaServicio;
};
