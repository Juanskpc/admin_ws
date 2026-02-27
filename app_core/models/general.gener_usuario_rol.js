module.exports = (sequelize, DataTypes) => {
    const GenerUsuarioRol = sequelize.define('GenerUsuarioRol', {
        id_usuario_rol: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        id_usuario: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        id_rol: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        id_negocio: {
            type: DataTypes.INTEGER,
            allowNull: true // NULL = rol global (ej: Super Admin de la plataforma)
        },
        estado: {
            type: DataTypes.CHAR(1),
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] }
        },
        fecha_creacion: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'gener_usuario_rol',
        schema: 'general',
        timestamps: false,
        indexes: [
            {
                unique: true,
                fields: ['id_usuario', 'id_rol', 'id_negocio'],
                name: 'uq_usuario_rol_negocio'
            }
        ]
    });

    GenerUsuarioRol.associate = (models) => {
        GenerUsuarioRol.belongsTo(models.GenerUsuario, {
            foreignKey: 'id_usuario',
            as: 'usuario'
        });
        GenerUsuarioRol.belongsTo(models.GenerRol, {
            foreignKey: 'id_rol',
            as: 'rol'
        });
        GenerUsuarioRol.belongsTo(models.GenerNegocio, {
            foreignKey: 'id_negocio',
            as: 'negocio'
        });
    };

    return GenerUsuarioRol;
};
