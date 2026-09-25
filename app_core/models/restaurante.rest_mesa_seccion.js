module.exports = (sequelize, DataTypes) => {
    /**
     * Una seccion del salon («Piso 1», «Terraza»…): se crea una vez y las mesas se le asignan.
     * Reemplaza al texto libre `rest_mesa.seccion`. Ver migrate_mesa_secciones.js.
     */
    const RestMesaSeccion = sequelize.define('RestMesaSeccion', {
        id_seccion:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
        nombre:         { type: DataTypes.STRING(60), allowNull: false },
        orden:          { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        estado:         { type: DataTypes.CHAR(1), defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'rest_mesa_seccion',
        schema: 'restaurante',
        timestamps: false,
    });

    RestMesaSeccion.associate = (models) => {
        RestMesaSeccion.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
        RestMesaSeccion.hasMany(models.RestMesa, { foreignKey: 'id_seccion', as: 'mesas' });
    };

    return RestMesaSeccion;
};
