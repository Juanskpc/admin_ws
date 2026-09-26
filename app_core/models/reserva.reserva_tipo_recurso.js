/**
 * Clase de recurso físico que un servicio necesita además del profesional: «Cabina», «Sala de
 * masajes», «Equipo de láser». Las unidades concretas viven en `reserva_recurso`.
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaTipoRecurso = sequelize.define('ReservaTipoRecurso', {
    id_tipo_recurso:     { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(80), allowNull: false },
    descripcion:         DataTypes.STRING(255),
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_tipo_recurso', schema: 'reserva', timestamps: false,
  });

  ReservaTipoRecurso.associate = (models) => {
    ReservaTipoRecurso.hasMany(models.ReservaRecurso, { foreignKey: 'id_tipo_recurso', as: 'recursos' });
  };

  return ReservaTipoRecurso;
};
