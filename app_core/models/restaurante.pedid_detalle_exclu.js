module.exports = (sequelize, DataTypes) => {
    const PedidDetalleExclu = sequelize.define('PedidDetalleExclu', {
        id_detalle_exclu: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_detalle:       { type: DataTypes.INTEGER, allowNull: false },
        id_ingrediente:   { type: DataTypes.INTEGER, allowNull: false },
    }, {
        tableName: 'pedid_detalle_exclu',
        schema: 'restaurante',
        timestamps: false,
    });

    PedidDetalleExclu.associate = (models) => {
        PedidDetalleExclu.belongsTo(models.PedidDetalle, { foreignKey: 'id_detalle', as: 'detalle' });
        PedidDetalleExclu.belongsTo(models.CartaIngrediente, { foreignKey: 'id_ingrediente', as: 'ingrediente' });
    };

    return PedidDetalleExclu;
};
