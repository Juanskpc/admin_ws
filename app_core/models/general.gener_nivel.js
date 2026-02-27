module.exports = (sequelize, DataTypes) => {
    const GenerNivel = sequelize.define('GenerNivel', {
        id_nivel: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        descripcion: { type: DataTypes.STRING(255), allowNull: false },
        id_nivel_padre: { type: DataTypes.INTEGER },
        icono: DataTypes.STRING,
        estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
        id_tipo_nivel: DataTypes.INTEGER,
        id_tipo_negocio: DataTypes.INTEGER,
        url: DataTypes.STRING,
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_nivel',
        schema: 'general',
        timestamps: false
    });

    GenerNivel.associate = (models) => {
        GenerNivel.belongsTo(models.GenerNivel, {
            as: 'NivelPadre',
            foreignKey: 'id_nivel_padre'
        });

        GenerNivel.hasMany(models.GenerNivel, {
            as: 'SubNiveles',
            foreignKey: 'id_nivel_padre'
        });

        GenerNivel.belongsTo(models.GenerTipoNivel, {
            foreignKey: 'id_tipo_nivel',
            as: 'tipoNivel'
        });

        GenerNivel.belongsTo(models.GenerTipoNegocio, {
            foreignKey: 'id_tipo_negocio',
            as: 'tipoNegocio'
        });

        GenerNivel.hasMany(models.GenerNivelUsuario, {
            foreignKey: 'id_nivel'
        });
        GenerNivel.hasMany(models.GenerRolNivel, {
            foreignKey: 'id_nivel',
            as: 'rolesNivel'
        });
    };

    return GenerNivel;
};
