module.exports = (sequelize, DataTypes) => {
  const GymVenta = sequelize.define('GymVenta', {
    id_venta:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    id_miembro:       DataTypes.INTEGER,
    id_usuario_cobro: DataTypes.INTEGER,
    total:            { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    metodo:           { type: DataTypes.STRING(20), defaultValue: 'EFECTIVO' },
    estado:           { type: DataTypes.STRING(20), defaultValue: 'PAGADA' },
    fecha_venta:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'gym_venta', schema: 'gym', timestamps: false,
  });

  GymVenta.associate = (models) => {
    GymVenta.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    GymVenta.belongsTo(models.GymMiembro,   { foreignKey: 'id_miembro', as: 'miembro' });
    GymVenta.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario_cobro', as: 'usuarioCobro' });
    GymVenta.hasMany(models.GymVentaDetalle, { foreignKey: 'id_venta', as: 'detalles' });
  };

  return GymVenta;
};
