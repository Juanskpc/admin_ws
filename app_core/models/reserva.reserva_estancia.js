/**
 * Una estancia: noches sobre una unidad (alojamiento, hotel de mascotas).
 *
 * `fecha_entrada` / `fecha_salida` son `DATE` y el rango es `[entrada, salida)`: quien entra el
 * 10 y sale el 12 ocupa las noches del 10 y del 11. La base impide que dos estancias vivas de la
 * misma unidad se pisen (`ex_reserva_estancia_sin_sobrecupo`).
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaEstancia = sequelize.define('ReservaEstancia', {
    id_estancia:                  { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:                   { type: DataTypes.INTEGER, allowNull: false },
    id_unidad:                    { type: DataTypes.INTEGER, allowNull: false },
    id_unidad_tipo:               { type: DataTypes.INTEGER, allowNull: false },
    fecha_entrada:                { type: DataTypes.DATEONLY, allowNull: false },
    fecha_salida:                 { type: DataTypes.DATEONLY, allowNull: false },
    estado:                       { type: DataTypes.STRING(20), defaultValue: 'pendiente' },
    huespedes:                    { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    cliente_nombre:               { type: DataTypes.STRING(150), allowNull: false },
    cliente_telefono:             DataTypes.STRING(30),
    cliente_email:                DataTypes.STRING(120),
    cliente_documento:            DataTypes.STRING(30),
    id_persona_negocio:           { type: DataTypes.UUID, allowNull: true },
    id_mascota:                   { type: DataTypes.UUID, allowNull: true },
    notas:                        DataTypes.TEXT,
    codigo_publico:               { type: DataTypes.STRING(36), allowNull: false },
    /** `[{ fecha: 'YYYY-MM-DD', precio }]`: el precio de cada noche congelado al reservar. */
    detalle_noches:               { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    monto_total:                  { type: DataTypes.DECIMAL(14, 2), defaultValue: 0 },
    monto_abono:                  { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    requiere_pago:                { type: DataTypes.BOOLEAN, defaultValue: false },
    pago_estado:                  { type: DataTypes.STRING(25), defaultValue: 'no_aplica' },
    comprobante_pago_url:         DataTypes.STRING(500),
    pago_validado_por_id_usuario: DataTypes.INTEGER,
    pago_validado_en:             DataTypes.DATE,
    pago_rechazo_motivo:          DataTypes.TEXT,
    checkin_en:                   DataTypes.DATE,
    checkout_en:                  DataTypes.DATE,
    cancelado_por:                DataTypes.STRING(20),
    cancelado_motivo:             DataTypes.TEXT,
    origen:                       { type: DataTypes.STRING(20), defaultValue: 'directo' },
    creado_por_id_usuario:        DataTypes.INTEGER,
    fecha_creacion:               { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion:          { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_estancia', schema: 'reserva', timestamps: false,
  });

  ReservaEstancia.associate = (models) => {
    ReservaEstancia.belongsTo(models.GenerNegocio,      { foreignKey: 'id_negocio',     as: 'negocio' });
    ReservaEstancia.belongsTo(models.ReservaUnidad,     { foreignKey: 'id_unidad',      as: 'unidad' });
    ReservaEstancia.belongsTo(models.ReservaUnidadTipo, { foreignKey: 'id_unidad_tipo', as: 'tipo' });
    ReservaEstancia.belongsTo(models.ReservaMascota,    { foreignKey: 'id_mascota',     as: 'mascota' });
    ReservaEstancia.hasMany(models.ReservaEstanciaCargo, { foreignKey: 'id_estancia',   as: 'cargos' });
    ReservaEstancia.hasMany(models.ReservaMovimientoCaja, { foreignKey: 'id_estancia',  as: 'movimientos' });
  };

  return ReservaEstancia;
};
