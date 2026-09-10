module.exports = (sequelize, DataTypes) => {
    const GenerTipoNegocio = sequelize.define('GenerTipoNegocio', {
        id_tipo_negocio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(100), allowNull: false, unique: true },
        descripcion: { type: DataTypes.STRING(255) },
        icono: { type: DataTypes.STRING(50), allowNull: true },
        color_hex: { type: DataTypes.STRING(20), allowNull: true },
        /**
         * Qué módulo atiende a este oficio. Auto-referencia: RESTAURANTE se apunta a sí
         * mismo, HELADERIA apunta a RESTAURANTE, BARBERIA apunta a RESERVA.
         *
         * `null` significa «hoy no lo podemos atender» y saca al tipo de todo lo que se
         * ofrece. Ver migrations/migrate_rubros_negocio.js.
         */
        id_tipo_modulo: { type: DataTypes.INTEGER, allowNull: true },
        /** Orden en que se le enseñan al cliente. No es alfabético a propósito. */
        orden: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 999 },
        estado: { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
        fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        fecha_actualizacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_tipo_negocio',
        schema: 'general',
        timestamps: false
    });

    GenerTipoNegocio.associate = (models) => {
        GenerTipoNegocio.hasMany(models.GenerNegocio, {
            foreignKey: 'id_tipo_negocio',
            as: 'negocios'
        });
        GenerTipoNegocio.hasMany(models.GenerRol, {
            foreignKey: 'id_tipo_negocio',
            as: 'roles'
        });
        GenerTipoNegocio.hasMany(models.GenerNivel, {
            foreignKey: 'id_tipo_negocio',
            as: 'niveles'
        });
        // El módulo que atiende a este oficio, y a la inversa los oficios que atiende.
        GenerTipoNegocio.belongsTo(models.GenerTipoNegocio, {
            foreignKey: 'id_tipo_modulo',
            as: 'modulo'
        });
        GenerTipoNegocio.hasMany(models.GenerTipoNegocio, {
            foreignKey: 'id_tipo_modulo',
            as: 'rubros'
        });
    };

    return GenerTipoNegocio;
};
