module.exports = (sequelize, DataTypes) => {
  const ReservaVentaProducto = sequelize.define('ReservaVentaProducto', {
    id_venta:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    /** Opcional: la venta puede colgar de una cita o ser independiente (mostrador o portal). */
    id_cita:        { type: DataTypes.INTEGER, allowNull: true },
    /** El cliente, cuando existe ficha (`platform.persona_negocio`). Puede faltar: venta anónima de mostrador. */
    id_persona_negocio: { type: DataTypes.UUID, allowNull: true },
    /** Quién vendió (para una comisión futura). Nunca obligatorio. */
    id_profesional: { type: DataTypes.INTEGER, allowNull: true },
    /** Quién la registró desde el panel. Nulo en una venta del portal (flujo público). */
    id_usuario:     { type: DataTypes.INTEGER, allowNull: true },
    canal:          { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MOSTRADOR' },   // MOSTRADOR | PORTAL
    entrega:        { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MOSTRADOR' },   // MOSTRADOR | RECOGER
    estado:         { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDIENTE' },   // PENDIENTE | COMPLETADA | CANCELADA
    total:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    /** Cuando no hay ficha de cliente (venta pública sin cuenta): lo que escribió en el portal. */
    cliente_nombre:   DataTypes.STRING(150),
    cliente_telefono: DataTypes.STRING(30),
    notas:          DataTypes.TEXT,
    /** Turno de caja en el que se asentó. Nulo mientras está PENDIENTE. */
    id_caja:        DataTypes.INTEGER,
    fecha_creacion:   { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    fecha_completada: DataTypes.DATE,
  }, {
    tableName: 'reserva_venta_producto', schema: 'reserva', timestamps: false,
  });

  ReservaVentaProducto.associate = (models) => {
    ReservaVentaProducto.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaVentaProducto.belongsTo(models.ReservaCita, { foreignKey: 'id_cita', as: 'cita' });
    ReservaVentaProducto.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
    ReservaVentaProducto.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
    ReservaVentaProducto.belongsTo(models.ReservaCaja, { foreignKey: 'id_caja', as: 'caja' });
    ReservaVentaProducto.hasMany(models.ReservaVentaProductoDetalle, { foreignKey: 'id_venta', as: 'detalle' });
  };

  return ReservaVentaProducto;
};
