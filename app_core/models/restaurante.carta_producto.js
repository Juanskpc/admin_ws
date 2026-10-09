module.exports = (sequelize, DataTypes) => {
    const CartaProducto = sequelize.define('CartaProducto', {
        id_producto:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
        id_categoria:   { type: DataTypes.INTEGER, allowNull: false },
        nombre:         { type: DataTypes.STRING(150), allowNull: false },
        descripcion:    { type: DataTypes.STRING(500) },
        precio:         { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        imagen_url:     { type: DataTypes.STRING(500) },
        icono:          { type: DataTypes.STRING(50) },
        es_popular:     { type: DataTypes.BOOLEAN, defaultValue: false },
        disponible:     { type: DataTypes.BOOLEAN, defaultValue: true },
        visible:        { type: DataTypes.BOOLEAN, defaultValue: true },
        estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
        // Empaque que el asistente suma en pedidos para llevar / domicilio (ver empaqueService).
        id_producto_empaque: { type: DataTypes.INTEGER, allowNull: true },
        cantidad_empaque:    { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
        // Datos fiscales (FE-1). Todos opcionales: NULL = el impuesto por defecto del negocio.
        codigo_impuesto:    { type: DataTypes.STRING(4), allowNull: true },
        tarifa_impuesto:    { type: DataTypes.DECIMAL(5, 2), allowNull: true },
        unidad_medida_dian: { type: DataTypes.STRING(10), allowNull: true },
        codigo_producto:    { type: DataTypes.STRING(50), allowNull: true },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'carta_producto',
        schema: 'restaurante',
        timestamps: false,
    });

    CartaProducto.associate = (models) => {
        CartaProducto.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
        CartaProducto.belongsTo(models.CartaCategoria, { foreignKey: 'id_categoria', as: 'categoria' });
        CartaProducto.hasMany(models.CartaProductoIngred, { foreignKey: 'id_producto', as: 'ingredientes' });
    };

    return CartaProducto;
};
