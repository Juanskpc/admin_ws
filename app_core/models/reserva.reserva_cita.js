module.exports = (sequelize, DataTypes) => {
  const ReservaCita = sequelize.define('ReservaCita', {
    id_cita:                       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:                    { type: DataTypes.INTEGER, allowNull: false },
    id_profesional:                { type: DataTypes.INTEGER, allowNull: false },
    fecha_hora_inicio:             { type: DataTypes.DATE,    allowNull: false },
    fecha_hora_fin:                { type: DataTypes.DATE,    allowNull: false },
    estado:                        { type: DataTypes.STRING(20), defaultValue: 'pendiente' },
    cliente_nombre:                { type: DataTypes.STRING(150), allowNull: false },
    cliente_telefono:              DataTypes.STRING(30),
    // ISO 3166-1 alfa-2 del teléfono del cliente, si el portal público lo capturó (ver
    // app_core/dao/personaNegocioDao.js). NULL en citas creadas antes de esto o desde el panel:
    // ahí se sigue asumiendo el país del negocio.
    cliente_pais:                  DataTypes.STRING(2),
    cliente_email:                 DataTypes.STRING(120),
    notas:                         DataTypes.TEXT,
    // FK a platform.persona_negocio — el cliente del negocio, resuelto por teléfono.
    // SIEMPRE nullable (ADR-006): la cita existe aunque no se pueda identificar a nadie,
    // que es lo que pasa cuando el teléfono no es un móvil colombiano utilizable.
    id_persona_negocio:            { type: DataTypes.UUID, allowNull: true },
    // 8 caracteres Base32 Crockford para las citas nuevas (ver app_reserva_api/services/
    // codigoCita.js); las citas viejas conservan su UUID de 36 caracteres, que cabe igual
    // en VARCHAR(36). El servicio lo genera explícitamente al crear la cita — el DEFAULT de
    // la columna (reserva.fn_codigo_cita()) es solo el respaldo para inserciones por SQL crudo.
    codigo_publico:                { type: DataTypes.STRING(36), allowNull: false },
    creado_por_id_usuario:         DataTypes.INTEGER,
    cancelado_por:                 DataTypes.STRING(20),  // 'cliente' | 'negocio'
    cancelado_motivo:              DataTypes.TEXT,
    requiere_pago:                 { type: DataTypes.BOOLEAN, defaultValue: false },
    monto_total:                   { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    /**
     * Cómo se cerró la cita: SERVICIO (se cobra, entra a la caja) o ASESORIA (no mueve dinero;
     * queda en la caja como movimiento de 0). Ver `cobroService.completarYCobrar`.
     */
    tipo_cobro:                    { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'SERVICIO' },
    comprobante_pago_url:          DataTypes.STRING(500),
    pago_estado:                   { type: DataTypes.STRING(25), defaultValue: 'no_aplica' },
    pago_validado_por_id_usuario:  DataTypes.INTEGER,
    pago_validado_en:              DataTypes.DATE,
    pago_rechazo_motivo:           DataTypes.TEXT,
    // Cobro en mostrador. `id_metodo_pago` es el pago simple; si la cita se cobró con varias
    // formas queda NULL y el desglose vive en `reserva_pago_cita` (relación `pagos`).
    // `id_caja` deja constancia del turno en que se cobró: sin él, cuadrar una caja pasada
    // dependería de las fechas de la cita, que se mueven al reagendar.
    id_metodo_pago:                DataTypes.INTEGER,
    id_caja:                       DataTypes.INTEGER,
    /**
     * Tramos `[[desde_min, hasta_min], …]`, relativos al inicio, en los que el profesional
     * queda libre (tiempo de proceso). NULL = ocupa la cita entera, lo de siempre.
     */
    proceso_tramos:                { type: DataTypes.JSONB, allowNull: true },
    /**
     * Abono exigido para reservar (perfiles con depósito). NULL = sin abono: si hay cobro
     * adelantado es el de siempre, por el total.
     */
    monto_abono:                   { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    id_metodo_pago_abono:          { type: DataTypes.INTEGER, allowNull: true },
    /** Turno en que entró el abono a la caja. NULL con abono aprobado = aún por asentar. */
    id_caja_abono:                 { type: DataTypes.INTEGER, allowNull: true },
    id_mascota:                    { type: DataTypes.UUID, allowNull: true },
    /** Cabina o sala asignada, si alguno de sus servicios la necesita. */
    id_recurso:                    { type: DataTypes.INTEGER, allowNull: true },
    fecha_creacion:                { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:           { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_cita', schema: 'reserva', timestamps: false,
  });

  ReservaCita.associate = (models) => {
    ReservaCita.belongsTo(models.GenerNegocio,       { foreignKey: 'id_negocio',           as: 'negocio' });
    ReservaCita.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional',       as: 'profesional' });
    ReservaCita.belongsTo(models.GenerUsuario,       { foreignKey: 'creado_por_id_usuario', as: 'creadoPor' });
    ReservaCita.belongsTo(models.GenerUsuario,       { foreignKey: 'pago_validado_por_id_usuario', as: 'pagoValidadoPor' });
    ReservaCita.hasMany(models.ReservaCitaServicio,  { foreignKey: 'id_cita', as: 'servicios' });
    ReservaCita.belongsTo(models.ReservaMetodoPago,  { foreignKey: 'id_metodo_pago', as: 'metodoPago' });
    ReservaCita.belongsTo(models.ReservaCaja,        { foreignKey: 'id_caja', as: 'caja' });
    ReservaCita.belongsTo(models.ReservaMascota,     { foreignKey: 'id_mascota', as: 'mascota' });
    ReservaCita.belongsTo(models.ReservaRecurso,     { foreignKey: 'id_recurso', as: 'recurso' });
    ReservaCita.belongsTo(models.ReservaMetodoPago,  { foreignKey: 'id_metodo_pago_abono', as: 'metodoPagoAbono' });
    ReservaCita.belongsToMany(models.ReservaServicio, {
      through: models.ReservaCitaServicio,
      foreignKey: 'id_cita',
      otherKey: 'id_servicio',
      as: 'serviciosIncluidos',
    });
  };

  return ReservaCita;
};
