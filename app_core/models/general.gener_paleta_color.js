// ============================================================
// Modelo Sequelize: general.gener_paleta_color
// Paletas de colores configurables para identidad visual de negocios.
//
// Cada paleta almacena sus tokens de color en JSONB.
// Los negocios eligen una paleta vía gener_negocio.id_paleta.
//
// Migración: node migrations/migrate_paleta_color.js
// ============================================================

module.exports = (sequelize, DataTypes) => {
    const GenerPaletaColor = sequelize.define('GenerPaletaColor', {
        id_paleta: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        nombre: {
            type: DataTypes.STRING(100),
            allowNull: false,
            unique: true,
        },
        descripcion: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
        /**
         * Tokens de color almacenados como JSONB.
         * Ejemplo: { "color-primary": "#1565c0", "color-bg": "#f5f5f5", ... }
         */
        colores: {
            type: DataTypes.JSONB,
            allowNull: false,
        },
        es_default: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
        },
        estado: {
            type: DataTypes.CHAR(1),
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] },
        },
        fecha_creacion: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    }, {
        tableName: 'gener_paleta_color',
        schema: 'general',
        timestamps: false,
    });

    GenerPaletaColor.associate = (models) => {
        GenerPaletaColor.hasMany(models.GenerNegocio, {
            foreignKey: 'id_paleta',
            as: 'negocios',
        });
    };

    return GenerPaletaColor;
};
