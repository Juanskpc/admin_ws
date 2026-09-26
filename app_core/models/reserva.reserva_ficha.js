/**
 * Una anotación en la ficha de un cliente (o de su mascota).
 *
 * `tipo`: NOTA · FORMULA (la fórmula de color de un salón) · CONTRAINDICACION · CONSENTIMIENTO
 * (con el archivo firmado) · VACUNA (con vencimiento) · REFERENCIA (la imagen del diseño de un
 * tatuaje).
 *
 * Son datos sensibles en estética y en mascotas (Ley 1581): la tabla se audita sin copiar
 * `contenido`, y leerla exige la acción `clientes_ficha_ver` o `agenda_ficha`.
 */
module.exports = (sequelize, DataTypes) => {
  const ReservaFicha = sequelize.define('ReservaFicha', {
    id_ficha:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:          { type: DataTypes.INTEGER, allowNull: false },
    id_persona_negocio:  { type: DataTypes.UUID, allowNull: false },
    id_mascota:          { type: DataTypes.UUID, allowNull: true },
    id_cita:             { type: DataTypes.INTEGER, allowNull: true },
    tipo:                { type: DataTypes.STRING(20), allowNull: false },
    titulo:              DataTypes.STRING(150),
    contenido:           DataTypes.TEXT,
    archivo_url:         DataTypes.STRING(500),
    vence_en:            DataTypes.DATEONLY,
    id_usuario:          DataTypes.INTEGER,
    estado:              { type: DataTypes.CHAR(1), defaultValue: 'A' },
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'reserva_ficha', schema: 'reserva', timestamps: false,
  });

  ReservaFicha.associate = (models) => {
    ReservaFicha.belongsTo(models.ReservaMascota, { foreignKey: 'id_mascota', as: 'mascota' });
    ReservaFicha.belongsTo(models.GenerUsuario, { foreignKey: 'id_usuario', as: 'autor' });
  };

  return ReservaFicha;
};
