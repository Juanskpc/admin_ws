module.exports = (sequelize, DataTypes) => {
    const PedidOrden = sequelize.define('PedidOrden', {
        id_orden:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
        id_usuario:     { type: DataTypes.INTEGER, allowNull: false },
        numero_orden:   { type: DataTypes.STRING(20), allowNull: false },
        id_mesa:        { type: DataTypes.INTEGER, allowNull: true },
        mesa:           { type: DataTypes.STRING(50) },
        nota:           { type: DataTypes.TEXT },
        subtotal:       { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        impuesto:       { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        total:          { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        estado:         { type: DataTypes.STRING(20), defaultValue: 'ABIERTA' },
        estado_cocina:  { type: DataTypes.STRING(20), allowNull: true },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        fecha_cierre:   { type: DataTypes.DATE },
        id_caja:        { type: DataTypes.INTEGER, allowNull: true },
        id_metodo_pago: { type: DataTypes.INTEGER, allowNull: true },
        tipo_pedido:    { type: DataTypes.STRING(20), defaultValue: 'MESA' },
        contacto_nombre:     DataTypes.STRING(160),
        contacto_telefono:   DataTypes.STRING(40),
        direccion_domicilio: DataTypes.STRING(500),
        nota_domicilio:      DataTypes.TEXT,
        id_domiciliario:     { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'pedid_orden',
        schema: 'restaurante',
        timestamps: false,
    });

    PedidOrden.associate = (models) => {
        PedidOrden.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
        PedidOrden.belongsTo(models.GenerUsuario,  { foreignKey: 'id_usuario', as: 'usuario' });
        PedidOrden.belongsTo(models.RestMesa,      { foreignKey: 'id_mesa', as: 'mesaRef' });
        PedidOrden.belongsTo(models.RestCaja,      { foreignKey: 'id_caja', as: 'caja' });
        PedidOrden.belongsTo(models.RestMetodoPago, { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
        PedidOrden.belongsTo(models.GenerUsuario,  { foreignKey: 'id_domiciliario', as: 'domiciliario' });
        PedidOrden.hasMany(models.PedidDetalle,    { foreignKey: 'id_orden', as: 'detalles' });
    };

    return PedidOrden;
};
