module.exports = (sequelize, DataTypes) => {
  const ReservaHold = sequelize.define('ReservaHold', {
    id_hold:           { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    codigo:            { type: DataTypes.UUID, allowNull: false, defaultValue: DataTypes.UUIDV4 },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false },
    id_profesional:    { type: DataTypes.INTEGER, allowNull: false },
    fecha_hora_inicio: { type: DataTypes.DATE, allowNull: false },
    fecha_hora_fin:    { type: DataTypes.DATE, allowNull: false },
    expira_en:         { type: DataTypes.DATE, allowNull: false },
    estado:            { type: DataTypes.STRING(20), defaultValue: 'activo' },
    id_cita:           DataTypes.INTEGER,
    // Sequelize descarta en silencio los atributos no declarados: si esta línea falta, el
    // `create()` guardaría el hold SIN los servicios y confirmar no sabría qué reservar.
    id_servicios:      { type: DataTypes.ARRAY(DataTypes.INTEGER), defaultValue: [] },
    /** Cabina apartada junto con el hueco, si los servicios la necesitan. */
    id_recurso:        { type: DataTypes.INTEGER, allowNull: true },
    /**
     * Variante elegida por servicio: `{ "<id_servicio>": <id_variante> }`.
     *
     * Es lo único del pedido que cambia **cuánto tiempo** hay que apartar (una coloración de
     * pelo largo dura el doble), así que se guarda aquí y se relee al confirmar. Lo demás —la
     * mascota, el nombre— son datos de la cita y viajan al confirmarla.
     */
    variantes:         { type: DataTypes.JSONB, allowNull: true },
    creado_en:         { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_hold', schema: 'reserva', timestamps: false,
  });

  ReservaHold.associate = (models) => {
    ReservaHold.belongsTo(models.GenerNegocio,       { foreignKey: 'id_negocio',     as: 'negocio' });
    ReservaHold.belongsTo(models.ReservaProfesional, { foreignKey: 'id_profesional', as: 'profesional' });
    ReservaHold.belongsTo(models.ReservaCita,        { foreignKey: 'id_cita',        as: 'cita' });
  };

  return ReservaHold;
};
