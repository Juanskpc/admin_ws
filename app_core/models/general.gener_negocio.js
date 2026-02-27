module.exports = (sequelize, DataTypes) => {
    const GenerNegocio = sequelize.define('GenerNegocio', {
        id_negocio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(255), allowNull: false },
        nit: { type: DataTypes.STRING(50), unique: true },
        email_contacto: DataTypes.STRING,
        telefono: DataTypes.STRING,
        estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
        fecha_registro: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_negocio',
        schema: 'general',
        timestamps: false
    });

    GenerNegocio.associate = (models) => {
        GenerNegocio.hasMany(models.GenerNegocioPlan, {
            foreignKey: 'id_negocio'
        });
        GenerNegocio.hasMany(models.GenerNegocioUsuario, {
            foreignKey: 'id_negocio',
            as: 'usuarios'
        });
        GenerNegocio.hasMany(models.GenerUsuarioRol, {
            foreignKey: 'id_negocio'
        });
    };

    return GenerNegocio;
};
