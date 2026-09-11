module.exports = (sequelize, DataTypes) => {
  /**
   * El libro de la cuenta del cliente. Es la ÚNICA fuente del saldo.
   *
   * Los importes se guardan en positivo y el signo lo pone `tipo` (ABONO suma,
   * CARGO resta), igual que en `rest_movimiento_caja`. Un apunte mueve plata o
   * mueve tiquetes, nunca las dos cosas: son dos unidades del mismo libro, no
   * dos libros.
   *
   * Nada se borra: una corrección es otro apunte con `id_movimiento_anula`
   * apuntando al original, para que el histórico del cliente siga siendo
   * defendible delante de él.
   */
  const RestCuentaMovimiento = sequelize.define('RestCuentaMovimiento', {
    id_movimiento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_cuenta:     { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:    { type: DataTypes.INTEGER, allowNull: false },
    tipo:          { type: DataTypes.STRING(10), allowNull: false }, // ABONO | CARGO
    monto:         { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    tiquetes:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    /** De qué producto son los tiquetes. Obligatorio si `tiquetes > 0`. */
    id_producto:   { type: DataTypes.INTEGER, allowNull: true },
    /** El pedido que lo consumió. NULL en abonos. */
    id_orden:      { type: DataTypes.INTEGER, allowNull: true },
    /** El turno donde entró la plata. NULL en cargos. */
    id_caja:       { type: DataTypes.INTEGER, allowNull: true },
    /** El movimiento de caja que este apunte generó: con él se sabe con qué se pagó. */
    id_movimiento_caja: { type: DataTypes.INTEGER, allowNull: true },
    id_usuario:    { type: DataTypes.INTEGER, allowNull: false },
    concepto:      DataTypes.STRING(255),
    id_movimiento_anula: { type: DataTypes.INTEGER, allowNull: true },
    fecha:         { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_cuenta_movimiento', schema: 'restaurante', timestamps: false,
  });

  RestCuentaMovimiento.associate = (models) => {
    RestCuentaMovimiento.belongsTo(models.RestCuenta,     { foreignKey: 'id_cuenta',   as: 'cuenta' });
    RestCuentaMovimiento.belongsTo(models.PedidOrden,     { foreignKey: 'id_orden',    as: 'orden' });
    RestCuentaMovimiento.belongsTo(models.CartaProducto,  { foreignKey: 'id_producto', as: 'producto' });
    RestCuentaMovimiento.belongsTo(models.GenerUsuario,   { foreignKey: 'id_usuario',  as: 'usuario' });
  };

  return RestCuentaMovimiento;
};
