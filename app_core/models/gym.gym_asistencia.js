module.exports = (sequelize, DataTypes) => {
  const GymAsistencia = sequelize.define('GymAsistencia', {
    id_asistencia:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_miembro:       { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    fecha_entrada:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_salida:     DataTypes.DATE,
    metodo:           { type: DataTypes.STRING(20), defaultValue: 'MANUAL' },
    duracion_minutos: DataTypes.INTEGER,
  }, {
    tableName: 'gym_asistencia', schema: 'gym', timestamps: false,
  });

  GymAsistencia.associate = (models) => {
    GymAsistencia.belongsTo(models.GymMiembro,   { foreignKey: 'id_miembro', as: 'miembro' });
    GymAsistencia.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return GymAsistencia;
};
