module.exports = (sequelize, DataTypes) => {
    const CartaIngrediente = sequelize.define('CartaIngrediente', {
        id_ingrediente: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
        nombre:         { type: DataTypes.STRING(100), allowNull: false },
        unidad_medida:  { type: DataTypes.STRING(20), defaultValue: 'g' },
        stock_actual:   { type: DataTypes.DECIMAL(12, 3), defaultValue: 0 },
        stock_minimo:   { type: DataTypes.DECIMAL(12, 3), defaultValue: 0 },
        stock_maximo:   { type: DataTypes.DECIMAL(12, 3), defaultValue: 0 },
        estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'carta_ingrediente',
        schema: 'restaurante',
        timestamps: false,
    });

    CartaIngrediente.associate = (models) => {
        CartaIngrediente.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
        CartaIngrediente.hasMany(models.CartaProductoIngred, { foreignKey: 'id_ingrediente', as: 'productosIngred' });
    };

    return CartaIngrediente;
};
