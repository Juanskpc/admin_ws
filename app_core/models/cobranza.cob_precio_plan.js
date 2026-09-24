/**
 * Precio de un plan en una moneda y un ciclo concretos.
 *
 * `gener_plan.precio` es un solo número en COP; con un cliente en Chile deja de alcanzar.
 * Los precios se fijan A MANO por moneda — nunca se convierten con la tasa del día, porque un
 * precio que se mueve cada mes con el dólar es una factura impredecible.
 *
 * ⚠️ `precio` es DECIMAL y llega como **string** en runtime: coercer con `Number()`.
 */
module.exports = (sequelize, DataTypes) => {
    const CobPrecioPlan = sequelize.define(
        'CobPrecioPlan',
        {
            id_precio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            moneda: { type: DataTypes.CHAR(3), allowNull: false },
            ciclo: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'mensual' },
            precio: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
            estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
            /** Aplicativo al que aplica el precio; NULL = por defecto. Ver migrate_cobranza_precio_aplicativo.js. */
            id_tipo_modulo: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: 'cob_precio_plan',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    CobPrecioPlan.associate = (models) => {
        CobPrecioPlan.belongsTo(models.GenerPlan, { foreignKey: 'id_plan' });
    };

    return CobPrecioPlan;
};
