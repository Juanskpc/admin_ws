module.exports = (sequelize, DataTypes) => {
  const GymPago = sequelize.define('GymPago', {
    id_pago:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_membresia:     DataTypes.INTEGER,
    id_miembro:       { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    id_usuario_cobro: DataTypes.INTEGER,
    monto:            { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    metodo:           { type: DataTypes.STRING(20), allowNull: false },
    concepto:         DataTypes.STRING(255),
    estado:           { type: DataTypes.STRING(20), defaultValue: 'PAGADO' },
    fecha_pago:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'gym_pago', schema: 'gym', timestamps: false,
  });

  GymPago.associate = (models) => {
    GymPago.belongsTo(models.GymMembresia, { foreignKey: 'id_membresia', as: 'membresia' });
    GymPago.belongsTo(models.GymMiembro,   { foreignKey: 'id_miembro',   as: 'miembro' });
    GymPago.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio',   as: 'negocio' });
    GymPago.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario_cobro', as: 'usuarioCobro' });
  };

  return GymPago;
};
