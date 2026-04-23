module.exports = (sequelize, DataTypes) => {
  const GymPlan = sequelize.define('GymPlan', {
    id_plan:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(120), allowNull: false },
    descripcion:    DataTypes.TEXT,
    precio:         { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    duracion_meses: { type: DataTypes.INTEGER, allowNull: false },
    beneficios:     DataTypes.TEXT,
    estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'gym_plan', schema: 'gym', timestamps: false,
  });

  GymPlan.associate = (models) => {
    GymPlan.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    GymPlan.hasMany(models.GymMembresia, { foreignKey: 'id_plan', as: 'membresias' });
  };

  return GymPlan;
};
