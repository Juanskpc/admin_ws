module.exports = (sequelize, DataTypes) => {
  /**
   * Comuna o corregimiento al que el negocio hace domicilios, con el precio de la zona. Sus
   * barrios/veredas (`rest_barrio_domicilio`) usan este valor salvo que tengan uno propio. Ver
   * migrate_restaurante_zonas_domicilio.js.
   */
  const RestZonaDomicilio = sequelize.define('RestZonaDomicilio', {
    id_zona_domicilio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    // La zona del catálogo de la ciudad (`general.gener_geo_zona`); NULL = creada a mano.
    id_geo_zona:    { type: DataTypes.INTEGER, allowNull: true },
    tipo:           { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'COMUNA' },
    nombre:         { type: DataTypes.STRING(100), allowNull: false },
    // NULL = sin precio de zona: sus barrios solo se ofrecen si tienen el suyo.
    valor:          { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    orden:          { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:         { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_zona_domicilio', schema: 'restaurante', timestamps: false,
  });

  RestZonaDomicilio.associate = (models) => {
    RestZonaDomicilio.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestZonaDomicilio.hasMany(models.RestBarrioDomicilio, { foreignKey: 'id_zona_domicilio', as: 'barrios' });
  };

  return RestZonaDomicilio;
};
