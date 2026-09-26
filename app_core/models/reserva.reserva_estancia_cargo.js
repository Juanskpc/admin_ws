/** Un consumo o servicio extra cargado a una estancia (minibar, lavandería, baño del perro). */
module.exports = (sequelize, DataTypes) => {
  const ReservaEstanciaCargo = sequelize.define('ReservaEstanciaCargo', {
    id_cargo:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_estancia: { type: DataTypes.INTEGER, allowNull: false },
    concepto:    { type: DataTypes.STRING(150), allowNull: false },
    valor:       { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    id_usuario:  DataTypes.INTEGER,
    fecha:       { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_estancia_cargo', schema: 'reserva', timestamps: false,
  });

  return ReservaEstanciaCargo;
};
