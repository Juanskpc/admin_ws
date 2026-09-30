module.exports = (sequelize, DataTypes) => {
  const ReservaConfig = sequelize.define('ReservaConfig', {
    id_negocio:                { type: DataTypes.INTEGER, primaryKey: true },
    /**
     * Anticipación mínima para reservar, en MINUTOS (2026-09-29). Por defecto 15: un negocio
     * nuevo ofrece horas hasta un cuarto de hora antes. Antes era en horas (mínimo 1 h), y la
     * agenda de «ya mismo» nunca aparecía.
     */
    anticipacion_min_minutos:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
    /**
     * Hasta cuánto antes de la cita puede cancelar el cliente, en MINUTOS. Por defecto 60.
     */
    ventana_cancelacion_min:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    /**
     * ⚠️ Columnas viejas, en horas. Ya no las lee nadie: se mantienen sincronizadas (ver el hook
     * de abajo) solo para que volver al backend anterior no deje a los negocios con otras reglas.
     */
    anticipacion_min_horas:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    ventana_cancelacion_horas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    /** «Tiempo de limpieza» entre dos citas, en minutos. 0 por defecto desde 2026-09-29. */
    buffer_limpieza_min:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // 30 desde 2026-09-29: un negocio nuevo nace ofreciendo horas cada media hora (pedido del
    // negocio). Los que ya existen conservan lo que tengan.
    paso_slot_min:             { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    cobro_adelantado:          { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    instrucciones_pago:        DataTypes.TEXT,
    /**
     * Si el profesional cobra, cada servicio queda ligado a quien lo prestó y la caja liquida
     * por persona al cerrar el día. Si no, el dinero solo se agrupa por forma de pago.
     */
    permite_cobro_profesional: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** Permite saldar una cita con varias formas de pago a la vez. */
    permite_multipago:         { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** Con esto activo, no se puede completar una cita sin un turno de caja abierto. */
    exige_caja_abierta:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** Texto de presentación del negocio en su página pública. */
    descripcion_publica:       DataTypes.TEXT,
    /** Publica o esconde la página pública. Por defecto publicada. */
    publico_activo:            { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    /**
     * Qué opciones de su perfil encendió o apagó el negocio: `{ deposito: true, ficha: false }`.
     * Una clave ausente toma el valor por defecto del perfil. Ver app_reserva_api/perfiles.
     */
    funciones:                 { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    /** Abono para reservar desde el portal, en % del total. 0 = sin abono (cobro de siempre). */
    deposito_pct:              { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    deposito_reembolsable:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    /** Estancias: hora de entrada y salida del negocio (las noches no llevan hora). */
    hora_checkin:              { type: DataTypes.TIME, allowNull: false, defaultValue: '15:00' },
    hora_checkout:             { type: DataTypes.TIME, allowNull: false, defaultValue: '12:00' },
    /**
     * % de comisión sobre lo vendido en productos, si el negocio decide pagarla. 0 = sin
     * comisión (el valor por defecto): no todo negocio quiere que el profesional gane por
     * vender, y encenderlo es una decisión suya, no de fábrica.
     */
    comision_productos_pct:    { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    fecha_creacion:            { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_config', schema: 'reserva', timestamps: false,
  });

  /**
   * Los minutos mandan; las horas son un espejo (redondeado hacia arriba, para que el backend
   * viejo nunca sea MÁS permisivo que el nuevo). Si alguien escribe todavía en horas —un script
   * antiguo—, se traduce a minutos para que la regla no se quede con el valor de antes.
   */
  ReservaConfig.addHook('beforeSave', 'espejoHoras', (cfg) => {
    const pares = [
      ['anticipacion_min_minutos', 'anticipacion_min_horas'],
      ['ventana_cancelacion_min', 'ventana_cancelacion_horas'],
    ];
    for (const [minutos, horas] of pares) {
      if (cfg.isNewRecord || cfg.changed(minutos)) {
        cfg.set(horas, Math.ceil(Number(cfg.get(minutos) || 0) / 60));
      } else if (cfg.changed(horas)) {
        cfg.set(minutos, Number(cfg.get(horas) || 0) * 60);
      }
    }
  });

  ReservaConfig.associate = (models) => {
    ReservaConfig.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return ReservaConfig;
};
