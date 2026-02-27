module.exports = (sequelize, DataTypes) => {
    const GenerRol = sequelize.define('GenerRol', {
        id_rol: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        descripcion: { type: DataTypes.STRING(255), allowNull: false },
        estado: {
            type: DataTypes.CHAR(1),
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] }
        }
    }, {
        tableName: 'gener_rol',
        schema: 'general',
        timestamps: false
    });

    GenerRol.associate = (models) => {
        GenerRol.hasMany(models.GenerUsuarioRol, {
            foreignKey: 'id_rol',
            as: 'usuariosRol'
        });
    };

    return GenerRol;
};
