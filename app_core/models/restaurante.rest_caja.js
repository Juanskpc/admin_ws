module.exports = (sequelize, DataTypes) => {
  const RestCaja = sequelize.define('RestCaja', {
    id_caja:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    id_usuario:       { type: DataTypes.INTEGER, allowNull: false },
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
    RestCaja.hasMany(models.RestMovimientoCaja, { foreignKey: 'id_caja', as: 'movimientos' });
  };

  return RestCaja;
};
