/**
 * Catálogo de formas de cobrar la mensualidad: `manual`, `dlocal`, `wompi`.
 *
 * Es tabla y no ENUM para poder apagar una pasarela sin desplegar. Ver
 * `docs/cobro-mensualidades.md` §3.4.
 */
module.exports = (sequelize, DataTypes) => {
    const CobPasarela = sequelize.define(
        'CobPasarela',
        {
            codigo: { type: DataTypes.STRING(20), primaryKey: true },
            nombre: { type: DataTypes.STRING(80), allowNull: false },
            descripcion: DataTypes.TEXT,

            // Filtran el selector del inquilino: ISO de país y de moneda.
            paises: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: [] },
            monedas: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: [] },

            // ¿Puede cobrar sola contra un token? 'manual' no: por eso el cron la ignora.
            soporta_recurrente: { type: DataTypes.BOOLEAN, defaultValue: false },

            estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
            orden: { type: DataTypes.SMALLINT, defaultValue: 0 },
        },
        {
            tableName: 'cob_pasarela',
            schema: 'cobranza',
            timestamps: false,
        }
    );

    return CobPasarela;
};
