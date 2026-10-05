module.exports = (sequelize, DataTypes) => {
  /**
   * Una compra hecha a un proveedor: la factura de la mercancía que entró.
   *
   * No es un movimiento de caja y no pretende serlo: la caja del restaurante lleva el turno
   * del cajero y lo que se vende, no lo que el dueño le paga al distribuidor de pollo. Lo que
   * sí hace es **entrar al inventario**: un renglón ligado a un `carta_ingrediente` suma
   * stock, que es la entrada de mercancía que al inventario le faltaba.
   *
   * Anular no borra (`estado = 'N'`): revierte exactamente el stock que sumó —guardado
   * renglón a renglón en `stock_sumado`— y deja el rastro.
   */
  const RestCompra = sequelize.define('RestCompra', {
    id_compra:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false },
    id_proveedor:      { type: DataTypes.INTEGER, allowNull: false },
    /** La fecha de la FACTURA, no la de hoy. Hora de pared de Bogotá. */
    fecha:             { type: DataTypes.DATEONLY, allowNull: false },
    referencia:        DataTypes.STRING(60),
    subtotal:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    descuento:         { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    impuesto:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    total:             { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    id_metodo_pago:    DataTypes.INTEGER,
    observaciones:     DataTypes.TEXT,
    adjunto_url:       DataTypes.STRING(255),
    afecta_inventario: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    /** A: registrada · N: anulada (nunca se borra) */
    estado:            { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    motivo_anulacion:  DataTypes.STRING(200),
    id_usuario:        { type: DataTypes.INTEGER, allowNull: false },
    fecha_creacion:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_anulacion:   DataTypes.DATE,
  }, {
    tableName: 'rest_compra', schema: 'restaurante', timestamps: false,
  });

  RestCompra.associate = (models) => {
    RestCompra.belongsTo(models.RestProveedor, { foreignKey: 'id_proveedor', as: 'proveedor' });
    RestCompra.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestCompra.belongsTo(models.RestMetodoPago, { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
    RestCompra.hasMany(models.RestCompraDetalle, { foreignKey: 'id_compra', as: 'detalles' });
  };

  return RestCompra;
};
