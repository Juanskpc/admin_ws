module.exports = (sequelize, DataTypes) => {
    const GenerRolNivel = sequelize.define('GenerRolNivel', {
        id_rol_nivel: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_rol: { type: DataTypes.INTEGER, allowNull: false },
        id_nivel: { type: DataTypes.INTEGER, allowNull: false },
        puede_ver: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        puede_crear: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        puede_editar: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        puede_eliminar: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        estado: {
            type: DataTypes.CHAR(1),
            allowNull: false,
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] }
        },
        fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        fecha_actualizacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_rol_nivel',
        schema: 'general',
        timestamps: false,
        indexes: [
            {
                unique: true,
                fields: ['id_rol', 'id_nivel'],
                name: 'uq_rol_nivel'
            }
        ]
    });

    GenerRolNivel.associate = (models) => {
        GenerRolNivel.belongsTo(models.GenerRol, {
            foreignKey: 'id_rol',
            as: 'rol'
        });
        GenerRolNivel.belongsTo(models.GenerNivel, {
            foreignKey: 'id_nivel',
            as: 'nivel'
        });
    };

    return GenerRolNivel;
};
