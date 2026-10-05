module.exports = (sequelize, DataTypes) => {
  /**
   * La relación PRIVADA entre un negocio y un proveedor.
   *
   * Aquí vive todo lo que no puede salir del negocio: sus notas, su calificación, las
   * condiciones que él negoció y si lo tiene archivado. Un negocio sin fila aquí no tiene al
   * proveedor en «Mis proveedores», aunque lo vea en el directorio compartido.
   *
   * Archivar escribe `estado_interno = 'ARCHIVADO'` y **no toca a los demás negocios**: esa es
   * la razón de que esta tabla exista separada de la ficha.
   */
  const RestProveedorNegocio = sequelize.define('RestProveedorNegocio', {
    id_proveedor_negocio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_proveedor:         { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:           { type: DataTypes.INTEGER, allowNull: false },
    /** true para el negocio que creó la ficha: es el único que puede editarla. */
    es_propietario:       { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** ACTIVO · ARCHIVADO */
    estado_interno:       { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ACTIVO' },
    notas:                DataTypes.TEXT,
    condiciones:          DataTypes.TEXT,
    calificacion:         DataTypes.SMALLINT,
    fecha_vinculacion:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_proveedor_negocio', schema: 'restaurante', timestamps: false,
  });

  RestProveedorNegocio.associate = (models) => {
    RestProveedorNegocio.belongsTo(models.RestProveedor, { foreignKey: 'id_proveedor', as: 'proveedor' });
    RestProveedorNegocio.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return RestProveedorNegocio;
};
