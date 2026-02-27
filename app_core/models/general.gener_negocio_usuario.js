module.exports = (sequelize, DataTypes) => {
    const GenerNegocioUsuario = sequelize.define('GenerNegocioUsuario', {
        id_negocio_usuario: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        id_usuario: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        id_negocio: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        estado: {
            type: DataTypes.CHAR(1),
            defaultValue: 'A'
        },
        fecha_creacion: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'gener_negocio_usuario',
        schema: 'general',
        timestamps: false
    });

    GenerNegocioUsuario.associate = (models) => {
        GenerNegocioUsuario.belongsTo(models.GenerUsuario, {
            foreignKey: 'id_usuario',
            as: 'usuario'
        });
        GenerNegocioUsuario.belongsTo(models.GenerNegocio, {
            foreignKey: 'id_negocio',
            as: 'negocio'
        });
    };

    return GenerNegocioUsuario;
};