module.exports = (sequelize, DataTypes) => {
  /**
   * Barrio al que el negocio hace domicilios, con su precio. Ver
   * migrate_restaurante_barrios_domicilio.js.
   */
  const RestBarrioDomicilio = sequelize.define('RestBarrioDomicilio', {
    id_barrio:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(100), allowNull: false },
    valor:          { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    estado:         { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_barrio_domicilio', schema: 'restaurante', timestamps: false,
  });

  RestBarrioDomicilio.associate = (models) => {
    RestBarrioDomicilio.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return RestBarrioDomicilio;
};
