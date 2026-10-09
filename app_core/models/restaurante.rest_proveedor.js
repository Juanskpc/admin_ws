module.exports = (sequelize, DataTypes) => {
  /**
   * La ficha de un proveedor de insumos.
   *
   * **No pertenece a un negocio**: pertenece al mundo. El mismo distribuidor de pollo le vende
   * a tres restaurantes del barrio, y el directorio compartido existe justamente para que el
   * cuarto lo encuentre. Lo que SÍ es de cada negocio —notas, calificación, precios
   * negociados, compras— vive en `RestProveedorNegocio` y `RestProveedorInsumo`.
   *
   * `id_negocio_origen` dice quién la creó y es **dato interno**: el directorio no lo expone
   * nunca. Saber qué restaurante registró a un proveedor es saber a quién le compra la
   * competencia.
   */
  const RestProveedor = sequelize.define('RestProveedor', {
    id_proveedor:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio_origen:   { type: DataTypes.INTEGER, allowNull: false },

    nombre_comercial:    { type: DataTypes.STRING(160), allowNull: false },
    nombre_legal:        DataTypes.STRING(160),
    identificacion:      DataTypes.STRING(40),
    descripcion:         DataTypes.TEXT,
    logo_url:            DataTypes.STRING(255),

    persona_contacto:    DataTypes.STRING(120),
    telefono:            DataTypes.STRING(40),
    whatsapp:            DataTypes.STRING(40),
    email:               DataTypes.STRING(160),
    sitio_web:           DataTypes.STRING(200),
    redes:               { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

    direccion:           DataTypes.STRING(200),
    ciudad:              DataTypes.STRING(100),
    region:              DataTypes.STRING(100),
    pais:                { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'Colombia' },
    zonas_cobertura:     { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    /** ENTREGA · RECOGIDA · AMBOS */
    tipo_atencion:       { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'AMBOS' },

    pedido_minimo:       { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    /** Array de enteros 0..6 (0 = domingo), mismo criterio que `rest_horario`. */
    dias_entrega:        { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    tiempo_entrega_hrs:  DataTypes.INTEGER,
    metodos_pago:        DataTypes.STRING(200),
    precios_mayoristas:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    observaciones:       DataTypes.TEXT,

    /** PRIVADO · DIRECTORIO_BASICO · DIRECTORIO_SIN_PRECIOS · DIRECTORIO */
    visibilidad:         { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'PRIVADO' },

    estado:              { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    id_usuario_creacion: DataTypes.INTEGER,
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_proveedor', schema: 'restaurante', timestamps: false,
  });

  RestProveedor.associate = (models) => {
    RestProveedor.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio_origen', as: 'negocioOrigen' });
    RestProveedor.hasMany(models.RestProveedorNegocio, { foreignKey: 'id_proveedor', as: 'vinculos' });
    RestProveedor.hasMany(models.RestProveedorInsumo, { foreignKey: 'id_proveedor', as: 'insumos' });
    RestProveedor.hasMany(models.RestCompra, { foreignKey: 'id_proveedor', as: 'compras' });
    RestProveedor.belongsToMany(models.RestProveedorCategoriaCat, {
      through: models.RestProveedorCategoria,
      foreignKey: 'id_proveedor',
      otherKey: 'id_categoria_prov',
      as: 'categorias',
    });
  };

  return RestProveedor;
};
