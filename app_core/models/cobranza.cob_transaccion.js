/**
 * Un intento de cobro contra una pasarela. Los fallidos también — sobre todo los fallidos:
 * el día que un cliente jure que pagó, esto es lo único que puede darle la razón o quitársela.
 *
 * `payload` guarda la respuesta cruda YA LIMPIA por el adaptador: sin PAN, sin CVV, sin llaves.
 */
module.exports = (sequelize, DataTypes) => {
    const CobTransaccion = sequelize.define(
        'CobTransaccion',
        {
            id_transaccion: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            pasarela: { type: DataTypes.STRING(20), allowNull: false },

            // El id EN la pasarela: lo que se le dice a su soporte.
            id_externo: DataTypes.STRING(120),
            estado: { type: DataTypes.STRING(20), allowNull: false },
            codigo_respuesta: DataTypes.STRING(40),
            mensaje: DataTypes.TEXT,

            payload: DataTypes.JSONB,
            creado_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        },
        {
            tableName: 'cob_transaccion',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    CobTransaccion.associate = (models) => {
        CobTransaccion.belongsTo(models.CobFactura, { foreignKey: 'id_factura' });
    };

    return CobTransaccion;
};
