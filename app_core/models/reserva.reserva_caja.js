module.exports = (sequelize, DataTypes) => {
  const ReservaCaja = sequelize.define('ReservaCaja', {
    id_caja:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:      { type: DataTypes.INTEGER, allowNull: false },
    id_usuario:      { type: DataTypes.INTEGER, allowNull: false },
    monto_apertura:  { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    monto_cierre:    DataTypes.DECIMAL(12, 2),
    monto_reportado: DataTypes.DECIMAL(12, 2),
    diferencia:      DataTypes.DECIMAL(12, 2),
    fecha_apertura:  { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    fecha_cierre:    DataTypes.DATE,
    estado:          { type: DataTypes.CHAR(1), defaultValue: 'A' }, // A=Abierta, C=Cerrada
    observaciones:   DataTypes.TEXT,
  }, {
    tableName: 'reserva_caja', schema: 'reserva', timestamps: false,
  });

  ReservaCaja.associate = (models) => {
    ReservaCaja.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaCaja.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
    ReservaCaja.hasMany(models.ReservaMovimientoCaja, { foreignKey: 'id_caja', as: 'movimientos' });
  };

  return ReservaCaja;
};
