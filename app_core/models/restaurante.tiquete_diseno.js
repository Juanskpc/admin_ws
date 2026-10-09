/**
 * Diseño del tiquete impreso de un negocio: el común y el de factura electrónica.
 *
 * Una fila por negocio, y su ausencia significa «tiquete por defecto». Nadie la crea al registrar
 * un negocio; aparece la primera vez que se guarda un diseño en Configuración → Tiquete.
 *
 * `comun` y `electronica` guardan solo lo que el negocio tocó. Los valores por defecto viven en el
 * frontend, que es quien imprime. Ver `app_restaurante_api/services/tiqueteDisenoService.js`.
 */
module.exports = (sequelize, DataTypes) => {
  const TiqueteDiseno = sequelize.define('TiqueteDiseno', {
    id_tiquete_diseno: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:        { type: DataTypes.INTEGER, allowNull: false, unique: true },
    comun:             { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    electronica:       { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    actualizado_en:    DataTypes.DATE,
    id_usuario:        DataTypes.INTEGER,
    fecha_creacion:    { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'tiquete_diseno', schema: 'restaurante', timestamps: false,
  });

  TiqueteDiseno.associate = (models) => {
    TiqueteDiseno.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
  };

  return TiqueteDiseno;
};
