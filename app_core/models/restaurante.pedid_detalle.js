module.exports = (sequelize, DataTypes) => {
    const PedidDetalle = sequelize.define('PedidDetalle', {
        id_detalle:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_orden:        { type: DataTypes.INTEGER, allowNull: false },
        id_producto:     { type: DataTypes.INTEGER, allowNull: false },
        cantidad:        { type: DataTypes.INTEGER, defaultValue: 1 },
        precio_unitario: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
        subtotal:        { type: DataTypes.DECIMAL(12, 2), allowNull: false },
        nota:            { type: DataTypes.TEXT },
        estado:          { type: DataTypes.STRING(20), defaultValue: 'PENDIENTE' },
        fecha_creacion:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'pedid_detalle',
        schema: 'restaurante',
        timestamps: false,
    });

    PedidDetalle.associate = (models) => {
        PedidDetalle.belongsTo(models.PedidOrden, { foreignKey: 'id_orden', as: 'orden' });
        PedidDetalle.belongsTo(models.CartaProducto, { foreignKey: 'id_producto', as: 'producto' });
        PedidDetalle.hasMany(models.PedidDetalleExclu, { foreignKey: 'id_detalle', as: 'exclusiones' });
    };

    return PedidDetalle;
};
