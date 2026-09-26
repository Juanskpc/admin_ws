module.exports = (sequelize, DataTypes) => {
  const ReservaServicio = sequelize.define('ReservaServicio', {
    id_servicio:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(150), allowNull: false },
    descripcion:         DataTypes.TEXT,
    duracion_min:        { type: DataTypes.INTEGER, allowNull: false },
    precio:              { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    color_hex:           { type: DataTypes.CHAR(7), defaultValue: '#3b82f6' },
    imagen_url:          DataTypes.STRING(500),
    /** Categoría del portal público. NULL = sin clasificar (se agrupa en «Otros»). */
    id_categoria:        DataTypes.INTEGER,
    /**
     * Tiempo de proceso: a los `proceso_desde_min` minutos de empezar, el profesional queda
     * libre `proceso_min` minutos (el tinte actuando) y puede atender a otra persona. Con 0
     * el servicio ocupa al profesional entero, que es lo de siempre.
     */
    proceso_desde_min:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    proceso_min:         { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    /** El precio y la duración se fijan en la cita (tatuajes): el catálogo da una referencia. */
    a_cotizar:           { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    requiere_consentimiento: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    /** Cabina, sala o equipo que ocupa el servicio. NULL = no consulta ningún recurso. */
    id_tipo_recurso:     { type: DataTypes.INTEGER, allowNull: true },
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_servicio', schema: 'reserva', timestamps: false,
  });

  ReservaServicio.associate = (models) => {
    ReservaServicio.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    ReservaServicio.belongsToMany(models.ReservaProfesional, {
      through: models.ReservaProfesionalServicio,
      foreignKey: 'id_servicio',
      otherKey: 'id_profesional',
      as: 'profesionales',
    });
    ReservaServicio.hasMany(models.ReservaCitaServicio, { foreignKey: 'id_servicio', as: 'citasIncluyen' });
    ReservaServicio.belongsTo(models.ReservaCategoria, { foreignKey: 'id_categoria', as: 'categoria' });
    ReservaServicio.hasMany(models.ReservaServicioVariante, { foreignKey: 'id_servicio', as: 'variantes' });
    ReservaServicio.belongsTo(models.ReservaTipoRecurso, { foreignKey: 'id_tipo_recurso', as: 'tipoRecurso' });
  };

  return ReservaServicio;
};
