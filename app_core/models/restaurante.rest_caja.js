module.exports = (sequelize, DataTypes) => {
  const RestCaja = sequelize.define('RestCaja', {
    id_caja:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    id_usuario:       { type: DataTypes.INTEGER, allowNull: false },
    // Rubro al que pertenece el turno. La migración lo rellenó para todo lo que ya existía,
    // así que nunca es nulo; el negocio de una sola caja lo tiene todo apuntando ahí.
    id_punto_caja:    { type: DataTypes.INTEGER, allowNull: false },
    monto_apertura:   { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    monto_cierre:     DataTypes.DECIMAL(12, 2),
    monto_reportado:  DataTypes.DECIMAL(12, 2),
    diferencia:       DataTypes.DECIMAL(12, 2),
    fecha_apertura:   { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    fecha_cierre:     DataTypes.DATE,
    estado:           { type: DataTypes.CHAR(1), defaultValue: 'A' }, // A=Abierta, C=Cerrada
    observaciones:    DataTypes.TEXT,
  }, {
    tableName: 'rest_caja', schema: 'restaurante', timestamps: false,
  });

  RestCaja.associate = (models) => {
    RestCaja.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestCaja.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
    RestCaja.belongsTo(models.RestPuntoCaja, { foreignKey: 'id_punto_caja', as: 'punto' });
    RestCaja.hasMany(models.RestMovimientoCaja, { foreignKey: 'id_caja', as: 'movimientos' });
  };

  return RestCaja;
};
