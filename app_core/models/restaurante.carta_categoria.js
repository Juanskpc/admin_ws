module.exports = (sequelize, DataTypes) => {
    const CartaCategoria = sequelize.define('CartaCategoria', {
        id_categoria:   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
        nombre:         { type: DataTypes.STRING(100), allowNull: false },
        descripcion:    { type: DataTypes.STRING(255) },
        icono:          { type: DataTypes.STRING(50) },
        orden:          { type: DataTypes.INTEGER, defaultValue: 0 },
        estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'carta_categoria',
        schema: 'restaurante',
        timestamps: false,
    });

    CartaCategoria.associate = (models) => {
        CartaCategoria.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
        CartaCategoria.hasMany(models.CartaProducto, { foreignKey: 'id_categoria', as: 'productos' });
    };

    return CartaCategoria;
};
