/**
 * Un período de servicio cobrado (o por cobrar) a un negocio.
 *
 * ## `referencia` es la llave de idempotencia
 *
 * `EA-<id_negocio>-<AAAAMM>`, UNIQUE en la base. Es la única garantía real de que un cron que
 * corre dos veces —o que muere después de cobrar y antes de marcar— no cobre dos veces el mismo
 * mes. Un `serial` no protege de nada.
 *
 * ## Cuatro números, no uno
 *
 *   total → lo que facturamos
 *   comision_pasarela → lo que se queda la pasarela
 *   retencion_declarada → lo que retiene el cliente empresa
 *   neto_recibido → lo que de verdad llegó al banco
 *
 * La diferencia entre el primero y el último es exactamente lo que descuadra la conciliación
 * (`docs/obligaciones-escalapp.md` §3). Guardarla como números es lo que convierte «no me
 * cuadra el banco» en un dato.
 *
 * ⚠️ Los DECIMAL llegan como **string** en runtime: coercer con `Number()`.
 */
module.exports = (sequelize, DataTypes) => {
    const CobFactura = sequelize.define(
        'CobFactura',
        {
            id_factura: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

            referencia: { type: DataTypes.STRING(40), allowNull: false, unique: true },

            /**
             * El plan que cobra esta factura. Al pagarla, es el plan que queda en el negocio.
             * Sin esta columna, un cobro emitido por el Plan Avanzado se aplicaría contra el plan
             * que tuviera la suscripción el día del pago, que puede ser otro.
             */
            id_plan: DataTypes.INTEGER,

            periodo_inicio: { type: DataTypes.DATEONLY, allowNull: false },
            periodo_fin: { type: DataTypes.DATEONLY, allowNull: false },

            moneda: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'COP' },
            subtotal: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
            impuestos: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
            total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },

            // pendiente → pagada | fallida | anulada
            estado: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'pendiente' },
            pasarela: { type: DataTypes.STRING(20), allowNull: false },

            fecha_pago: DataTypes.DATE,
            comision_pasarela: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
            retencion_declarada: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
            neto_recibido: DataTypes.DECIMAL(12, 2),

            medio_pago_texto: DataTypes.STRING(120),

            // Factura electrónica NUESTRA. Se llena a mano hasta que exista la habilitación DIAN.
            numero_factura: DataTypes.STRING(40),
            cufe: DataTypes.STRING(120),

            nota: DataTypes.TEXT,
            creado_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
            actualizado_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        },
        {
            tableName: 'cob_factura',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    CobFactura.associate = (models) => {
        CobFactura.belongsTo(models.CobSuscripcion, { foreignKey: 'id_suscripcion' });
        CobFactura.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio' });
        CobFactura.hasMany(models.CobTransaccion, { foreignKey: 'id_factura' });
    };

    return CobFactura;
};
