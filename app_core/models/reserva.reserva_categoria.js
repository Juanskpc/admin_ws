module.exports = (sequelize, DataTypes) => {
  const ReservaCategoria = sequelize.define('ReservaCategoria', {
    id_categoria: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:   { type: DataTypes.INTEGER, allowNull: false },
    nombre:       { type: DataTypes.STRING(120), allowNull: false },
    descripcion:  DataTypes.TEXT,
    /** Posición en el portal público. El negocio decide qué sección va primero. */
    orden:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    estado:       { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_categoria', schema: 'reserva', timestamps: false,
  });

  ReservaCategoria.associate = (models) => {
    ReservaCategoria.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaCategoria.hasMany(models.ReservaServicio, { foreignKey: 'id_categoria', as: 'servicios' });
  };

  return ReservaCategoria;
};
