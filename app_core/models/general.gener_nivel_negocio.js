module.exports = (sequelize, DataTypes) => {
    const GenerNivelNegocio = sequelize.define('GenerNivelNegocio', {
        id_nivel_negocio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio: { type: DataTypes.INTEGER, allowNull: false },
        id_rol: { type: DataTypes.INTEGER, allowNull: false },
        id_nivel: { type: DataTypes.INTEGER, allowNull: false },
        puede_ver: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        estado: {
            type: DataTypes.CHAR(1),
            allowNull: false,
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] },
        },
        fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        fecha_actualizacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'gener_nivel_negocio',
        schema: 'general',
        timestamps: false,
        indexes: [
            {
                unique: true,
                fields: ['id_negocio', 'id_rol', 'id_nivel'],
                name: 'uq_nivel_negocio',
            },
        ],
    });

    GenerNivelNegocio.associate = (models) => {
        GenerNivelNegocio.belongsTo(models.GenerNegocio, {
            foreignKey: 'id_negocio',
            as: 'negocio',
        });

        GenerNivelNegocio.belongsTo(models.GenerRol, {
            foreignKey: 'id_rol',
            as: 'rol',
        });

        GenerNivelNegocio.belongsTo(models.GenerNivel, {
            foreignKey: 'id_nivel',
            as: 'nivel',
        });
    };

    return GenerNivelNegocio;
};