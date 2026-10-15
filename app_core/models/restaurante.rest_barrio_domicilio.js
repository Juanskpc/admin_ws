module.exports = (sequelize, DataTypes) => {
  /**
   * Barrio al que el negocio hace domicilios, con su precio. Ver
   * migrate_restaurante_barrios_domicilio.js.
   */
  const RestBarrioDomicilio = sequelize.define('RestBarrioDomicilio', {
    id_barrio:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(100), allowNull: false },
    // NULL = el de su zona (`rest_zona_domicilio.valor`). Ver migrate_restaurante_zonas_domicilio.js.
    valor:          { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    id_zona_domicilio: { type: DataTypes.INTEGER, allowNull: true },
    // El lugar del catálogo de la ciudad del que salió; NULL = escrito a mano.
    id_geo_lugar:   { type: DataTypes.INTEGER, allowNull: true },
    tipo:           { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'BARRIO' },
    estado:         { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_barrio_domicilio', schema: 'restaurante', timestamps: false,
  });

  RestBarrioDomicilio.associate = (models) => {
    RestBarrioDomicilio.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestBarrioDomicilio.belongsTo(models.RestZonaDomicilio, { foreignKey: 'id_zona_domicilio', as: 'zona' });
  };

  return RestBarrioDomicilio;
};
