module.exports = (sequelize, DataTypes) => {
  /**
   * Punto de caja = rubro de ingreso del negocio.
   *
   * No es «la caja registradora»: es de dónde sale la plata. Un restaurante con tienda
   * cobra dos cosas distintas y las cuadra por separado, y cada punto lleva sus propios
   * turnos (`rest_caja`) y su propio arqueo. El negocio que solo tiene uno nunca se entera
   * de que esto existe: se resuelve solo.
   */
  const RestPuntoCaja = sequelize.define('RestPuntoCaja', {
    id_punto_caja:  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(60), allowNull: false },
    descripcion:    DataTypes.STRING(160),
    orden:          { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:         { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' }, // A=Activa, I=Inactiva
    creado_en:      { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    actualizado_en: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_punto_caja', schema: 'restaurante', timestamps: false,
  });

  RestPuntoCaja.associate = (models) => {
    RestPuntoCaja.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestPuntoCaja.hasMany(models.RestCaja, { foreignKey: 'id_punto_caja', as: 'turnos' });
    RestPuntoCaja.hasMany(models.RestPuntoCajaUsuario, { foreignKey: 'id_punto_caja', as: 'asignaciones' });
  };

  return RestPuntoCaja;
};
