/**
 * Variante de un servicio: el mismo servicio con otra duración y otro precio.
 *
 * El largo del cabello en un salón, el tamaño del perro en una peluquería canina, la zona en
 * depilación. Un servicio sin variantes cobra su precio de lista, como siempre.
 *
 * `clave` empareja la variante con un atributo: el tamaño de la mascota (PEQUENO, MEDIANO,
 * GRANDE, GIGANTE) la elige sola al agendar.
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaServicioVariante = sequelize.define('ReservaServicioVariante', {
    id_variante:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_servicio:         { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    nombre:              { type: DataTypes.STRING(80), allowNull: false },
    clave:               { type: DataTypes.STRING(20), allowNull: true },
    duracion_min:        { type: DataTypes.INTEGER, allowNull: false },
    precio:              { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    orden:               { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_servicio_variante', schema: 'reserva', timestamps: false,
  });

  ReservaServicioVariante.associate = (models) => {
    ReservaServicioVariante.belongsTo(models.ReservaServicio, { foreignKey: 'id_servicio', as: 'servicio' });
  };

  return ReservaServicioVariante;
};
