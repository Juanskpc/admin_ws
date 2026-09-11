module.exports = (sequelize, DataTypes) => {
    const GenerNegocio = sequelize.define('GenerNegocio', {
        id_negocio: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        nombre: { type: DataTypes.STRING(255), allowNull: false },
        nit: { type: DataTypes.STRING(50), unique: true },
        email_contacto: DataTypes.STRING,
        telefono: DataTypes.STRING,
        direccion: DataTypes.STRING,
        // ISO 3166-1 alfa-2. Decide cómo se normaliza el teléfono de sus clientes.
        // Ver migrations/migrate_pais_negocio.js y app_core/helpers/telefono.js.
        pais: { type: DataTypes.CHAR(2), defaultValue: 'CO' },
        url_whatsapp: DataTypes.STRING,
        url_facebook: DataTypes.STRING,
        url_instagram: DataTypes.STRING,
        // El MODULO sobre el que opera el negocio. De aqui cuelgan roles y permisos, asi
        // que no puede ser el oficio del cliente: para eso esta `id_rubro`.
        id_tipo_negocio: { type: DataTypes.INTEGER },
        /** Que oficio dijo ser el cliente (heladeria, barberia...). Solo para hablar con el. */
        id_rubro: { type: DataTypes.INTEGER, allowNull: true },
        id_paleta: { type: DataTypes.INTEGER, allowNull: true },
        permite_multipago: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        /** Opt-in: habilita cobrar el valor del domicilio y pagarlo al domiciliario desde caja. */
        permite_pago_domicilio: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        /** Opt-in: habilita registrar un descuento sobre el pedido en el POS. */
        permite_descuento: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        /** Opt-in: al enviar un pedido, pregunta si se cobra ahora o se envía sin cobrar. */
        pregunta_cobro_envio: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        // ¿El negocio maneja tiqueteras y fiado? Opt-in: nace apagado, y mientras lo esté el
        // módulo de Clientes no existe para él — ni menú, ni forma de pago, ni API.
        permite_cuentas_cliente: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        /** Logo del negocio. Ruta relativa servida desde /uploads. */
        logo_url: DataTypes.STRING(500),
        /** Imagen ancha de cabecera del portal público (16:5). */
        banner_url: DataTypes.STRING(500),
        /**
         * Colores propios del negocio: `{ primario, acento }`.
         *
         * Manda sobre `id_paleta`. Al elegir una paleta predefinida se copian aquí sus valores,
         * de modo que el resto del sistema lee siempre de un único sitio.
         */
        colores: DataTypes.JSONB,
        estado: { type: DataTypes.CHAR(1), defaultValue: 'A' },
        fecha_registro: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_negocio',
        schema: 'general',
        timestamps: false
    });

    GenerNegocio.associate = (models) => {
        // El MODULO sobre el que corre.
        GenerNegocio.belongsTo(models.GenerTipoNegocio, {
            foreignKey: 'id_tipo_negocio',
            as: 'tipoNegocio'
        });
        // El OFICIO que dijo ser el cliente. Puede coincidir con el modulo o no.
        GenerNegocio.belongsTo(models.GenerTipoNegocio, {
            foreignKey: 'id_rubro',
            as: 'rubro'
        });
        GenerNegocio.hasMany(models.GenerNegocioPlan, {
            foreignKey: 'id_negocio'
        });
        GenerNegocio.hasMany(models.GenerNegocioUsuario, {
            foreignKey: 'id_negocio',
            as: 'usuarios'
        });
        GenerNegocio.hasMany(models.GenerUsuarioRol, {
            foreignKey: 'id_negocio'
        });
        GenerNegocio.hasMany(models.GenerNivelNegocio, {
            foreignKey: 'id_negocio',
            as: 'nivelesNegocio'
        });
        GenerNegocio.belongsTo(models.GenerPaletaColor, {
            foreignKey: 'id_paleta',
            as: 'paletaColor'
        });
    };

    return GenerNegocio;
};
