/** Una cabina, sala o equipo concreto. Atiende una cita a la vez. */
module.exports = (sequelize, DataTypes) => {
  const ReservaRecurso = sequelize.define('ReservaRecurso', {
    id_recurso:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    id_tipo_recurso:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(80), allowNull: false },
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_recurso', schema: 'reserva', timestamps: false,
  });

  ReservaRecurso.associate = (models) => {
    ReservaRecurso.belongsTo(models.ReservaTipoRecurso, { foreignKey: 'id_tipo_recurso', as: 'tipo' });
  };

  return ReservaRecurso;
};
