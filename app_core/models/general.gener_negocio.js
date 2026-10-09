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
        url_tiktok: DataTypes.STRING,
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
        /**
         * ¿El POS mira el stock de insumos al facturar? Es un opt-OUT: nace ENCENDIDO, al
         * contrario que los `permite_*`, porque apagarlo retira una comprobación que hoy
         * corre en todos los negocios. Apagado, el pedido ni consulta ni descuenta
         * inventario — ver `consumirIngredientesPorItems` en pedidoService.
         */
        controla_inventario: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        /**
         * ¿El asistente de WhatsApp deja de ofrecer lo que no tiene insumos? Decisión aparte de
         * `controla_inventario`: cualquiera de las cuatro combinaciones vale. Nace ENCENDIDO,
         * igual que el control de caja — ver `cartaService.asistenteMiraStock`.
         */
        asistente_mira_stock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        /**
         * ¿Pedidos lista los productos con su icono, o solo con el nombre? Opt-OUT como
         * `controla_inventario`: nace ENCENDIDO porque los iconos son lo que todos los
         * negocios ven hoy, y lo que se activa aquí es quitarlos.
         */
        muestra_iconos_productos: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        /**
         * Opt-in: ¿el propio personal del negocio (mesero, cajero, administrador) puede
         * elegirse como domiciliario? Encendido, `listarDomiciliarios` lista a todo el
         * personal activo del negocio en vez de solo a quien tenga el rol DOMICILIARIO.
         */
        permite_domicilio_personal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        /**
         * De qué forma de pago sale el pago al domiciliario (el EGRESO que deja
         * `valor_domicilio` al cobrar). NULL = sale de la misma con la que pagó el
         * cliente, que es el comportamiento anterior a esta columna.
         *
         * El caso real: el cliente paga 27.000 por transferencia (20.000 + 7.000 de
         * domicilio) y el negocio le entrega al domiciliario 7.000 EN EFECTIVO. Sin
         * esto, el turno restaba esos 7.000 de «Transferencia» y el cajón cuadraba
         * de más. Ver `migrate:restaurante-metodo-pago-domicilio`.
         */
        id_metodo_pago_domicilio: { type: DataTypes.INTEGER, allowNull: true },
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
        /**
         * Identidad del negocio en su propia URL: `<slug>.escalapp.cloud`. Único (sin distinguir
         * mayúsculas, ver el índice de `migrate_negocio_slug.js`), generado solo al crear el
         * negocio o desde `PUT /reserva/marca/slug` — nunca se regenera solo porque `nombre`
         * cambió, para no romper un enlace que el negocio ya compartió.
         */
        slug: DataTypes.STRING(63),
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
