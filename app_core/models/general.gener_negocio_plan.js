module.exports = (sequelize, DataTypes) => {
    const GenerNegocioPlan = sequelize.define('GenerNegocioPlan', {
        id_negocio_plan: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        fecha_inicio: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        fecha_fin: DataTypes.DATE,
        estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
        auto_renovacion: { type: DataTypes.BOOLEAN, defaultValue: true }
    }, {
        tableName: 'gener_negocio_plan',
        schema: 'general',
        timestamps: false
    });

    GenerNegocioPlan.associate = (models) => {
        GenerNegocioPlan.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio' });
        GenerNegocioPlan.belongsTo(models.GenerPlan, { foreignKey: 'id_plan' });
    };

    return GenerNegocioPlan;
};
