/**
 * Evento crudo recibido de una pasarela, guardado ANTES de interpretarlo.
 *
 * El `UNIQUE (pasarela, id_evento_externo)` **es** la idempotencia: el segundo INSERT del mismo
 * evento choca contra la base, no contra un `if` que alguien puede olvidar. Hace falta porque
 * la entrega es «al menos una vez» — la pasarela reintenta si no recibe 200 rápido.
 *
 * Un evento con firma inválida se guarda igual (`firma_valida = false`) y no se procesa: una
 * ráfaga de estos es la señal de que alguien está probando la puerta.
 */
module.exports = (sequelize, DataTypes) => {
    const CobEventoWebhook = sequelize.define(
        'CobEventoWebhook',
        {
            id_evento: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            pasarela: { type: DataTypes.STRING(20), allowNull: false },
            id_evento_externo: { type: DataTypes.STRING(160), allowNull: false },
            tipo: DataTypes.STRING(60),

            firma_valida: { type: DataTypes.BOOLEAN, defaultValue: false },

            payload: DataTypes.JSONB,
            recibido_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
            procesado_en: DataTypes.DATE,
            error: DataTypes.TEXT,
        },
        {
            tableName: 'cob_evento_webhook',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    return CobEventoWebhook;
};
