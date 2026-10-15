/**
 * Qué adiciones (toppings, extras…) ofrece cada producto. `id_adicion` es otro producto de la
 * carta con `es_adicion = true`. Ver `migrations/migrate_restaurante_adiciones.js`.
 */
module.exports = (sequelize, DataTypes) => {
    const CartaProductoAdicion = sequelize.define('CartaProductoAdicion', {
        id_producto_adicion: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_producto:         { type: DataTypes.INTEGER, allowNull: false },
        id_adicion:          { type: DataTypes.INTEGER, allowNull: false },
        orden:               { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
        estado:              { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
        fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'carta_producto_adicion',
        schema: 'restaurante',
        timestamps: false,
    });

    CartaProductoAdicion.associate = (models) => {
        CartaProductoAdicion.belongsTo(models.CartaProducto, { foreignKey: 'id_producto', as: 'producto' });
        CartaProductoAdicion.belongsTo(models.CartaProducto, { foreignKey: 'id_adicion', as: 'adicion' });
    };

    return CartaProductoAdicion;
};
