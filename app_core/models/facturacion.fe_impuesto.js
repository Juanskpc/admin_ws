/**
 * Catálogo de impuestos (FE-1). La lista de valores válidos, no lo que cobra cada negocio:
 * la tarifa que aplica un producto se guarda en la tabla del producto, y quien la decide es el
 * contador del cliente. Ver docs/facturacion-electronica.md §5.6.
 */
module.exports = (sequelize, DataTypes) => {
    const FeImpuesto = sequelize.define(
        'FeImpuesto',
        {
            id_impuesto: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            // Código del tributo según la DIAN: 01 IVA, 04 INC, ZZ no causa.
            codigo: { type: DataTypes.STRING(4), allowNull: false },
            nombre: { type: DataTypes.STRING(60), allowNull: false },
            tarifa: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
            descripcion: DataTypes.TEXT,
            estado: { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
        },
        {
            tableName: 'fe_impuesto',
            schema: 'facturacion',
            timestamps: false,
        }
    );

    return FeImpuesto;
};
