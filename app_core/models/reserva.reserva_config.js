module.exports = (sequelize, DataTypes) => {
  const ReservaConfig = sequelize.define('ReservaConfig', {
    id_negocio:                { type: DataTypes.INTEGER, primaryKey: true },
    anticipacion_min_horas:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    buffer_limpieza_min:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    ventana_cancelacion_horas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4 },
    paso_slot_min:             { type: DataTypes.INTEGER, allowNull: false, defaultValue: 15 },
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
    fecha_creacion:            { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_config', schema: 'reserva', timestamps: false,
  });

  ReservaConfig.associate = (models) => {
    ReservaConfig.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return ReservaConfig;
};
