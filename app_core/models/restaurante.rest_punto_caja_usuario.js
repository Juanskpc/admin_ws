module.exports = (sequelize, DataTypes) => {
  /**
   * Qué cajas puede usar cada usuario.
   *
   * Sin filas para un usuario, este puede usar la caja única del negocio (y solo esa): es
   * el estado de todo negocio que nunca ha oído hablar de esto. Con varias cajas, lo que
   * hay aquí es lo que el usuario ve al tomar un pedido o al cobrar.
   */
  const RestPuntoCajaUsuario = sequelize.define('RestPuntoCajaUsuario', {
    id_asignacion: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_punto_caja: { type: DataTypes.INTEGER, allowNull: false },
    id_usuario:    { type: DataTypes.INTEGER, allowNull: false },
    id_negocio:    { type: DataTypes.INTEGER, allowNull: false },
    estado:        { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    creado_en:     { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_punto_caja_usuario', schema: 'restaurante', timestamps: false,
  });

  RestPuntoCajaUsuario.associate = (models) => {
    RestPuntoCajaUsuario.belongsTo(models.RestPuntoCaja, { foreignKey: 'id_punto_caja', as: 'punto' });
    RestPuntoCajaUsuario.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'usuario' });
  };

  return RestPuntoCajaUsuario;
};
