module.exports = (sequelize, DataTypes) => {
    const GenerPlan = sequelize.define('GenerPlan', {
        id_plan: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(150), allowNull: false, unique: true },
        descripcion: DataTypes.TEXT,
        precio: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        moneda: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_plan',
        schema: 'general',
        timestamps: false
    });

    GenerPlan.associate = (models) => {
        GenerPlan.hasMany(models.GenerNegocioPlan, { foreignKey: 'id_plan' });
    };

    return GenerPlan;
};
