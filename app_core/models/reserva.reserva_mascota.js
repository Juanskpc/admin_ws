/**
 * La mascota de un cliente. Quien reserva es el dueño (`persona_negocio`); el sujeto del
 * servicio es el animal, y sus atributos son los que deciden el precio (el tamaño) y lo que el
 * groomer necesita saber antes de empezar (comportamiento, alergias en la ficha).
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaMascota = sequelize.define('ReservaMascota', {
    id_mascota:          { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    id_persona_negocio:  { type: DataTypes.UUID, allowNull: false },
    nombre:              { type: DataTypes.STRING(80), allowNull: false },
    especie:             { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PERRO' },
    raza:                DataTypes.STRING(80),
    /** PEQUENO · MEDIANO · GRANDE · GIGANTE. Empareja con `reserva_servicio_variante.clave`. */
    tamano:              DataTypes.STRING(10),
    peso_kg:             DataTypes.DECIMAL(5, 2),
    fecha_nacimiento:    DataTypes.DATEONLY,
    sexo:                DataTypes.CHAR(1),
    comportamiento:      DataTypes.STRING(160),
    notas:               DataTypes.TEXT,
    foto_url:            DataTypes.STRING(500),
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_mascota', schema: 'reserva', timestamps: false,
  });

  ReservaMascota.associate = (models) => {
    ReservaMascota.hasMany(models.ReservaCita, { foreignKey: 'id_mascota', as: 'citas' });
  };

  return ReservaMascota;
};
