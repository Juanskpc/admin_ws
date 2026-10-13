module.exports = (sequelize, DataTypes) => {
  /**
   * Rubro = sector de ingreso del negocio (Parrilla, Sushi, Pizza…).
   *
   * No confundir con `rest_punto_caja`. Son dos ejes distintos y ninguno estorba al otro:
   *
   *   caja  → de la ORDEN. Lleva turno, arqueo y cajón. Cuenta contra el tope del plan.
   *   rubro → del ÍTEM. Solo agrupa lo que se vende, vía la categoría de la carta. Es gratis.
   *
   * Que el rubro viva en el ítem es lo único que deja repartir un pedido mixto con un solo
   * pago: la mesa que pide de los tres sectores paga una vez y el informe sale partido.
   *
   * Una categoría sin rubro (`carta_categoria.id_rubro IS NULL`) es «General»: se vende en
   * todos los sectores. Es el estado de todo lo que ya existía, y por eso el negocio que no
   * usa rubros no ve ninguna pantalla nueva.
   */
  const RestRubro = sequelize.define('RestRubro', {
    id_rubro:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false },
    nombre:         { type: DataTypes.STRING(60), allowNull: false },
    descripcion:    DataTypes.STRING(160),
    // #RRGGBB para las gráficas de informes. NULL = lo asigna la paleta por defecto.
    color:          DataTypes.STRING(9),
    orden:          { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    estado:         { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' }, // A=Activo, I=Inactivo
    creado_en:      { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    actualizado_en: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_rubro', schema: 'restaurante', timestamps: false,
  });

  RestRubro.associate = (models) => {
    RestRubro.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestRubro.hasMany(models.CartaCategoria, { foreignKey: 'id_rubro', as: 'categorias' });
  };

  return RestRubro;
};
