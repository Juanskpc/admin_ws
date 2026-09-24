module.exports = (sequelize, DataTypes) => {
    const GenerPlan = sequelize.define('GenerPlan', {
        id_plan: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(150), allowNull: false, unique: true },
        // Código estable: igual en todos los entornos y que no cambia si el plan se renombra
        // ('BASICO', 'AVANZADO'). Lo que el código busca; el nombre es solo una etiqueta comercial.
        codigo: DataTypes.STRING(40),
        descripcion: DataTypes.TEXT,
        precio: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
        moneda: { type: DataTypes.STRING(10), defaultValue: 'USD' },
        estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
        // Lo que trae el plan de serie (migrate:cobranza-complementos). NULL = sin límite; los
        // complementos suman encima. Ver app_core/helpers/limitesNegocio.js.
        usuarios_incluidos: DataTypes.SMALLINT,
        cajas_incluidas: DataTypes.SMALLINT,
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
