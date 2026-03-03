module.exports = (sequelize, DataTypes) => {
  const ParqConfiguracion = sequelize.define('ParqConfiguracion', {
    id_configuracion:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false, unique: true },
    nombre_comercial:    DataTypes.STRING(200),
    direccion:           DataTypes.STRING(255),
    telefono:            DataTypes.STRING(50),
    horario_apertura:    DataTypes.TIME,
    horario_cierre:      DataTypes.TIME,
    logo_url:            DataTypes.STRING(500),
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'parq_configuracion', schema: 'parqueadero', timestamps: false,
  });

  ParqConfiguracion.associate = (models) => {
    ParqConfiguracion.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return ParqConfiguracion;
};
