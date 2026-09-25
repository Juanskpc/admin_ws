module.exports = (sequelize, DataTypes) => {
    const RestMesa = sequelize.define('RestMesa', {
        id_mesa:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
        nombre:         { type: DataTypes.STRING(100), allowNull: false },
        numero:         { type: DataTypes.INTEGER, allowNull: false },
        capacidad:      { type: DataTypes.INTEGER, defaultValue: 4 },
        // La seccion es una ENTIDAD (`rest_mesa_seccion`): NULL = sin seccion. La columna de texto
        // `seccion` de la primera version sigue en la base (el codigo anterior la lee) pero ya no se usa.
        id_seccion:     { type: DataTypes.INTEGER, allowNull: true },
        estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
        estado_servicio:{ type: DataTypes.STRING(20), defaultValue: 'DISPONIBLE' },
        fecha_inicio_servicio: { type: DataTypes.DATE, allowNull: true },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'rest_mesa',
        schema: 'restaurante',
        timestamps: false,
    });

    RestMesa.associate = (models) => {
        RestMesa.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
        RestMesa.hasMany(models.PedidOrden, { foreignKey: 'id_mesa', as: 'ordenes' });
        RestMesa.belongsTo(models.RestMesaSeccion, { foreignKey: 'id_seccion', as: 'seccionRef' });
    };

    return RestMesa;
};
