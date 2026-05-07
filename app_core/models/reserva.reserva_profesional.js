module.exports = (sequelize, DataTypes) => {
  const ReservaProfesional = sequelize.define('ReservaProfesional', {
    id_profesional:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    id_usuario:          DataTypes.INTEGER,
    nombre:              { type: DataTypes.STRING(150), allowNull: false },
    especialidad:        DataTypes.STRING(150),
    telefono:            DataTypes.STRING(30),
    email:               DataTypes.STRING(120),
    foto_url:            DataTypes.STRING(500),
    color_hex:           { type: DataTypes.CHAR(7), defaultValue: '#10b981' },
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_profesional', schema: 'reserva', timestamps: false,
  });

  ReservaProfesional.associate = (models) => {
    ReservaProfesional.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaProfesional.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
    ReservaProfesional.belongsToMany(models.ReservaServicio, {
      through: models.ReservaProfesionalServicio,
      foreignKey: 'id_profesional',
      otherKey: 'id_servicio',
      as: 'servicios',
    });
    ReservaProfesional.hasMany(models.ReservaHorario,  { foreignKey: 'id_profesional', as: 'horarios' });
    ReservaProfesional.hasMany(models.ReservaBloqueo,  { foreignKey: 'id_profesional', as: 'bloqueos' });
    ReservaProfesional.hasMany(models.ReservaCita,     { foreignKey: 'id_profesional', as: 'citas' });
  };

  return ReservaProfesional;
};
