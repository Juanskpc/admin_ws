module.exports = (sequelize, DataTypes) => {
    const CartaProductoIngred = sequelize.define('CartaProductoIngred', {
        id_producto_ingred: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_producto:        { type: DataTypes.INTEGER, allowNull: false },
        id_ingrediente:     { type: DataTypes.INTEGER, allowNull: false },
        porcion:            { type: DataTypes.DECIMAL(10, 3), defaultValue: 0 },
        unidad_medida:      { type: DataTypes.STRING(20), defaultValue: 'g' },
        es_removible:       { type: DataTypes.BOOLEAN, defaultValue: true },
        estado:             { type: DataTypes.CHAR(1), defaultValue: 'A' },
    }, {
        tableName: 'carta_producto_ingred',
        schema: 'restaurante',
        timestamps: false,
    });

    CartaProductoIngred.associate = (models) => {
        CartaProductoIngred.belongsTo(models.CartaProducto, { foreignKey: 'id_producto', as: 'producto' });
        CartaProductoIngred.belongsTo(models.CartaIngrediente, { foreignKey: 'id_ingrediente', as: 'ingrediente' });
    };

    return CartaProductoIngred;
};
