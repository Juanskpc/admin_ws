/**
 * La relación de cobro con un negocio: cuánto nos paga, en qué moneda, por qué medio y cuándo.
 *
 * NO decide quién tiene acceso al sistema — eso lo sigue diciendo `general.gener_negocio_plan`
 * a través de `planHelper`, igual que siempre. Cuando entra un pago, esta suscripción **empuja**
 * la `fecha_fin` de aquel. Ver `docs/cobro-mensualidades.md` §3.1.
 *
 * `es_retenedor` no es un adorno: un cliente persona jurídica retiene en la fuente, así que
 * cobrarle el 100% por pasarela le crea un saldo a favor que nadie pidió
 * (`docs/obligaciones-escalapp.md` §3). Con `true`, el cobro automático no lo toca.
 */
module.exports = (sequelize, DataTypes) => {
    const CobSuscripcion = sequelize.define(
        'CobSuscripcion',
        {
            id_suscripcion: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

            ciclo: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'mensual' },
            moneda: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'COP' },
            pasarela: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual' },

            // trial → activa → en_gracia → suspendida → cancelada
            estado: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'activa' },

            // NULL = no se cobra sola. Todo lo manual vive así.
            proximo_cobro: DataTypes.DATEONLY,
            dia_cobro: DataTypes.SMALLINT,
            reintentos: { type: DataTypes.SMALLINT, defaultValue: 0 },

            es_retenedor: { type: DataTypes.BOOLEAN, defaultValue: false },

            /**
             * Plan que el cliente eligió y **todavía no ha pagado**. Manda sobre `id_plan` al
             * generar el cobro y se limpia cuando ese cobro se paga.
             *
             * No se toca `id_plan` directamente porque la generación automática lo sincroniza con
             * el plan vigente del negocio: el cambio se perdería al día siguiente y, mientras
             * tanto, el negocio figuraría en un plan que no ha pagado.
             */
            id_plan_solicitado: DataTypes.INTEGER,

            notas: DataTypes.TEXT,
            creado_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
            actualizado_en: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        },
        {
            tableName: 'cob_suscripcion',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    CobSuscripcion.associate = (models) => {
        CobSuscripcion.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio' });
        CobSuscripcion.belongsTo(models.GenerPlan, { foreignKey: 'id_plan' });
        CobSuscripcion.belongsTo(models.CobPasarela, { foreignKey: 'pasarela', targetKey: 'codigo' });
        CobSuscripcion.belongsTo(models.CobMetodoPago, { foreignKey: 'id_metodo_pago' });
        CobSuscripcion.hasMany(models.CobFactura, { foreignKey: 'id_suscripcion' });
    };

    return CobSuscripcion;
};
