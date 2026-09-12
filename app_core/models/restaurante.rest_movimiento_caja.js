module.exports = (sequelize, DataTypes) => {
  const RestMovimientoCaja = sequelize.define('RestMovimientoCaja', {
    id_movimiento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_caja:       { type: DataTypes.INTEGER, allowNull: false },
    tipo:          { type: DataTypes.STRING(10), allowNull: false }, // INGRESO | EGRESO
    monto:         { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    concepto:      DataTypes.STRING(255),
    id_orden:      DataTypes.INTEGER,
    id_usuario:    { type: DataTypes.INTEGER, allowNull: false },
    // Con qué se pagó, cuando el movimiento NO cuelga de un pedido (un abono a la cuenta de
    // un cliente, por ejemplo). Sin esto, esos ingresos caían en el arqueo como «Manual /
    // Sin orden» y el cajero no sabía si esa plata estaba en el cajón o llegó por transferencia.
    id_metodo_pago: { type: DataTypes.INTEGER, allowNull: true },
    // Movimiento que esta fila reversa. Non-null ⟹ la fila ES una anulación.
    // Nada se borra: el original queda visible y el neto se corrige sumando.
    id_movimiento_anula: { type: DataTypes.INTEGER, allowNull: true },
    fecha:         { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_movimiento_caja', schema: 'restaurante', timestamps: false,
  });

  RestMovimientoCaja.associate = (models) => {
    RestMovimientoCaja.belongsTo(models.RestCaja,     { foreignKey: 'id_caja',    as: 'caja' });
    RestMovimientoCaja.belongsTo(models.PedidOrden,   { foreignKey: 'id_orden',   as: 'orden' });
    RestMovimientoCaja.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
    // Solo viene poblada en los movimientos manuales (y los abonos a cuenta): cuando
    // hay pedido detrás, la forma de pago la manda la orden o su desglose de multipago.
    RestMovimientoCaja.belongsTo(models.RestMetodoPago, { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
  };

  return RestMovimientoCaja;
};
