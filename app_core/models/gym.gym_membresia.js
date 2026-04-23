module.exports = (sequelize, DataTypes) => {
  const GymMembresia = sequelize.define('GymMembresia', {
    id_membresia:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_miembro:      { type: DataTypes.INTEGER, allowNull: false },
    id_plan:         { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:      { type: DataTypes.INTEGER, allowNull: false },
    fecha_inicio:    { type: DataTypes.DATEONLY, allowNull: false },
    fecha_fin:       { type: DataTypes.DATEONLY, allowNull: false },
    precio_pagado:   { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    estado:          { type: DataTypes.STRING(20), defaultValue: 'ACTIVA' },
    pausada_desde:   DataTypes.DATEONLY,
    pausada_hasta:   DataTypes.DATEONLY,
    fecha_creacion:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'gym_membresia', schema: 'gym', timestamps: false,
  });

  GymMembresia.associate = (models) => {
    GymMembresia.belongsTo(models.GymMiembro,   { foreignKey: 'id_miembro', as: 'miembro' });
    GymMembresia.belongsTo(models.GymPlan,      { foreignKey: 'id_plan',    as: 'plan' });
    GymMembresia.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    GymMembresia.hasMany(models.GymPago,        { foreignKey: 'id_membresia', as: 'pagos' });
  };

  return GymMembresia;
};
