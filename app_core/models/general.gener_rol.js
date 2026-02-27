module.exports = (sequelize, DataTypes) => {
    const GenerRol = sequelize.define('GenerRol', {
        id_rol: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        descripcion: { type: DataTypes.STRING(255), allowNull: false },
        id_tipo_negocio: { type: DataTypes.INTEGER, allowNull: true },
        estado: {
            type: DataTypes.CHAR(1),
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] }
        },
        fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        fecha_actualizacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_rol',
        schema: 'general',
        timestamps: false
    });

    GenerRol.associate = (models) => {
        GenerRol.belongsTo(models.GenerTipoNegocio, {
            foreignKey: 'id_tipo_negocio',
            as: 'tipoNegocio'
        });
        GenerRol.hasMany(models.GenerUsuarioRol, {
            foreignKey: 'id_rol',
            as: 'usuariosRol'
        });
        GenerRol.hasMany(models.GenerRolNivel, {
            foreignKey: 'id_rol',
            as: 'permisos'
        });
    };

    return GenerRol;
};
