module.exports = (sequelize, DataTypes) => {
    const GenerTipoNivel = sequelize.define('GenerTipoNivel', {
        id_tipo_nivel: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        descripcion: { type: DataTypes.STRING(255) },
        orden: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        estado: { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_tipo_nivel',
        schema: 'general',
        timestamps: false
    });

    GenerTipoNivel.associate = (models) => {
        GenerTipoNivel.hasMany(models.GenerNivel, {
            foreignKey: 'id_tipo_nivel',
            as: 'niveles'
        });
    };

    return GenerTipoNivel;
};
