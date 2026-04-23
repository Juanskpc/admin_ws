module.exports = (sequelize, DataTypes) => {
  const GymMiembro = sequelize.define('GymMiembro', {
    id_miembro:        { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false },
    primer_nombre:     { type: DataTypes.STRING(80), allowNull: false },
    segundo_nombre:    DataTypes.STRING(80),
    primer_apellido:   { type: DataTypes.STRING(80), allowNull: false },
    segundo_apellido:  DataTypes.STRING(80),
    num_identificacion: DataTypes.STRING(40),
    email:             DataTypes.STRING(160),
    telefono:          DataTypes.STRING(40),
    fecha_nacimiento:  DataTypes.DATEONLY,
    sexo:              DataTypes.CHAR(1),
    peso_kg:           DataTypes.DECIMAL(5, 2),
    altura_cm:         DataTypes.DECIMAL(5, 2),
    porcentaje_grasa:  DataTypes.DECIMAL(4, 2),
    direccion:         DataTypes.STRING(255),
    ciudad:            DataTypes.STRING(120),
    codigo_postal:     DataTypes.STRING(20),
    alergias:          DataTypes.TEXT,
    condiciones_medicas: DataTypes.TEXT,
    contacto_emergencia_nombre:   DataTypes.STRING(160),
    contacto_emergencia_telefono: DataTypes.STRING(40),
    foto_url:          DataTypes.STRING(500),
    codigo_qr:         { type: DataTypes.STRING(60), allowNull: false, unique: true },
    estado:            { type: DataTypes.STRING(20), defaultValue: 'ACTIVO' },
    fecha_registro:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'gym_miembro', schema: 'gym', timestamps: false,
  });

  GymMiembro.associate = (models) => {
    GymMiembro.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    GymMiembro.hasMany(models.GymMembresia, { foreignKey: 'id_miembro', as: 'membresias' });
    GymMiembro.hasMany(models.GymPago,      { foreignKey: 'id_miembro', as: 'pagos' });
    GymMiembro.hasMany(models.GymAsistencia, { foreignKey: 'id_miembro', as: 'asistencias' });
  };

  return GymMiembro;
};
