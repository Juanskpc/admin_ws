module.exports = (sequelize, DataTypes) => {
  const ParqFactura = sequelize.define('ParqFactura', {
    id_factura:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:       { type: DataTypes.INTEGER, allowNull: false },
    numero_factura:   { type: DataTypes.STRING,  allowNull: false },
    id_vehiculo:      DataTypes.INTEGER,
    placa:            DataTypes.STRING(20),
    id_tipo_vehiculo: DataTypes.INTEGER,
    id_tarifa:        DataTypes.INTEGER,
    tipo_cobro:       DataTypes.STRING(10),
    valor_unitario:   { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    valor_total:      DataTypes.DECIMAL(12, 2),
    estado:           { type: DataTypes.CHAR(1), defaultValue: 'A' }, // A=Abierta C=Cerrada X=Anulada
    fecha_entrada:    DataTypes.DATE,
    fecha_cierre:     DataTypes.DATE,
    fecha_creacion:   { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    observaciones:    DataTypes.TEXT,
  }, {
    tableName: 'parq_factura',
    schema: 'parqueadero',
    timestamps: false,
  });

  ParqFactura.associate = (models) => {
    ParqFactura.belongsTo(models.ParqVehiculo, { foreignKey: 'id_vehiculo', as: 'vehiculo' });
  };

  return ParqFactura;
};
