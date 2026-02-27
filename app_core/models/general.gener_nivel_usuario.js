module.exports = (sequelize, DataTypes) => {
    const GenerNivelUsuario = sequelize.define('GenerNivelUsuario', {
        id_nivel_usuario: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        fecha: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_nivel_usuario',
        schema: 'general',
        timestamps: false
    });

    GenerNivelUsuario.associate = (models) => {
        GenerNivelUsuario.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario' });
        GenerNivelUsuario.belongsTo(models.GenerNivel, { foreignKey: 'id_nivel' });
    };

    return GenerNivelUsuario;
};
