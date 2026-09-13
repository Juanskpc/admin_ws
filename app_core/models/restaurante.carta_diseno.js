/**
 * Diseño publicado de la carta virtual de un negocio.
 *
 * Una fila por negocio, y su ausencia también significa algo: el negocio usa la carta por
 * defecto («Esencial»). Por eso nadie crea esta fila al registrar un negocio; aparece la primera
 * vez que se publica un diseño desde Configuración → Apariencia.
 *
 * `marca` y `opciones` guardan solo lo que el negocio tocó. Los valores completos de cada
 * plantilla viven en el frontend: afinar una plantilla mejora la carta de todos los negocios que la
 * usan sin perder su color.
 */
module.exports = (sequelize, DataTypes) => {
  const CartaDiseno = sequelize.define('CartaDiseno', {
    id_diseno:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:     { type: DataTypes.INTEGER, allowNull: false, unique: true },
    plantilla:      { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'esencial' },
    formato:        { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'cards' },
    /** `{ color?, fuente_titulos?, borde? }` — solo lo que el negocio cambió. */
    marca:          { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    /** `{ mostrar_agotados? }` */
    opciones:       { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    publicado_en:   DataTypes.DATE,
    id_usuario:     DataTypes.INTEGER,
    fecha_creacion: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'carta_diseno', schema: 'restaurante', timestamps: false,
  });

  CartaDiseno.associate = (models) => {
    CartaDiseno.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return CartaDiseno;
};
