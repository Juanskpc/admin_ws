module.exports = (sequelize, DataTypes) => {
  const TiendaMovimiento = sequelize.define('TiendaMovimiento', {
    id_movimiento:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    tipo:             { type: DataTypes.STRING(20), allowNull: false },
    referencia:       DataTypes.STRING(80),
    observacion:      DataTypes.TEXT,
    id_usuario:       DataTypes.INTEGER,
    total_items:      { type: DataTypes.INTEGER, defaultValue: 0 },
    estado:           { type: DataTypes.STRING(20), defaultValue: 'CONFIRMADO' },
    fecha_movimiento: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tienda_movimiento', schema: 'tienda', timestamps: false,
  });

  TiendaMovimiento.associate = (models) => {
    TiendaMovimiento.belongsTo(models.GenerNegocio,  { foreignKey: 'id_negocio',  as: 'negocio' });
    TiendaMovimiento.belongsTo(models.GenerUsuario,  { foreignKey: 'id_usuario',  as: 'usuario' });
    TiendaMovimiento.hasMany(models.TiendaMovDetalle, { foreignKey: 'id_movimiento', as: 'detalles' });
  };

  return TiendaMovimiento;
};
