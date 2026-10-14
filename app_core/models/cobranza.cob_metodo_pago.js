/**
 * Medio de pago tokenizado de un negocio.
 *
 * Aquí NUNCA entra un número de tarjeta: solo el token que devuelve la pasarela y lo justo
 * para que el cliente reconozca su medio en pantalla («Visa ···4242»). Eso mantiene el alcance
 * PCI en SAQ-A.
 *
 * Se llena cuando un negocio activa el pago automático en «Mis pagos» (opcional, desde 2026-10-14).
 */
module.exports = (sequelize, DataTypes) => {
    const CobMetodoPago = sequelize.define(
        'CobMetodoPago',
        {
            id_metodo_pago: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            pasarela: { type: DataTypes.STRING(20), allowNull: false },

            // Puntero opaco: solo sirve con nuestras llaves privadas.
            token_externo: { type: DataTypes.STRING(255), allowNull: false },

            tipo: DataTypes.STRING(20),
            marca: DataTypes.STRING(30),
            ultimos4: DataTypes.CHAR(4),
            mes_exp: DataTypes.SMALLINT,
            anio_exp: DataTypes.SMALLINT,

            estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
            creado_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },

            // La constancia de quién autorizó el débito automático, cuándo y desde dónde: si un
            // cliente desconoce un cargo ante su banco, es la prueba de que lo pidió.
            autorizado_por: DataTypes.INTEGER,
            autorizado_en: DataTypes.DATE,
            ip_autorizacion: DataTypes.STRING(64),
        },
        {
            tableName: 'cob_metodo_pago',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    CobMetodoPago.associate = (models) => {
        CobMetodoPago.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio' });
        CobMetodoPago.belongsTo(models.CobPasarela, { foreignKey: 'pasarela', targetKey: 'codigo' });
    };

    return CobMetodoPago;
};
