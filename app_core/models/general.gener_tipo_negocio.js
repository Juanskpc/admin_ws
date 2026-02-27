module.exports = (sequelize, DataTypes) => {
    const GenerTipoNegocio = sequelize.define('GenerTipoNegocio', {
        id_tipo_negocio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        descripcion: { type: DataTypes.STRING(255) },
        estado: { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        fecha_actualizacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_tipo_negocio',
        schema: 'general',
        timestamps: false
    });

    GenerTipoNegocio.associate = (models) => {
        GenerTipoNegocio.hasMany(models.GenerNegocio, {
            foreignKey: 'id_tipo_negocio',
            as: 'negocios'
        });
        GenerTipoNegocio.hasMany(models.GenerRol, {
            foreignKey: 'id_tipo_negocio',
            as: 'roles'
        });
    };

    return GenerTipoNegocio;
};
