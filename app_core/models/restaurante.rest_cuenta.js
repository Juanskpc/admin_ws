module.exports = (sequelize, DataTypes) => {
  /**
   * La cuenta de un cliente en un restaurante: tiquetera y fiado son la misma cosa.
   *
   *   saldo > 0 → tiene comida pagada por delante (tiquetera)
   *   saldo < 0 → le debe al restaurante (fiado), hasta `cupo`
   *
   * El saldo NO vive aquí: se suma de `rest_cuenta_movimiento`. Un número guardado
   * aparte se desajusta el día que alguien escriba un movimiento sin actualizarlo,
   * y entonces nadie sabe cuál de los dos tiene razón.
   */
  const RestCuenta = sequelize.define('RestCuenta', {
    id_cuenta:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_negocio:         { type: DataTypes.INTEGER, allowNull: false },
    /** El cliente ES `platform.persona_negocio` (ADR-006). No hay otro «cliente». */
    id_persona_negocio: { type: DataTypes.UUID, allowNull: false },
    /** DINERO (saldo en pesos) o TIQUETES (unidades de un producto). */
    modo:               { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'DINERO' },
    /** Hasta cuánto puede deber. 0 = no se le fía. */
    cupo:               { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    estado:             { type: DataTypes.CHAR(1), allowNull: false, defaultValue: 'A' },
    nota:               DataTypes.TEXT,
    fecha_creacion:      { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    fecha_actualizacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'rest_cuenta', schema: 'restaurante', timestamps: false,
  });

  RestCuenta.associate = (models) => {
    RestCuenta.belongsTo(models.GenerNegocio, { foreignKey: 'id_negocio', as: 'negocio' });
    RestCuenta.hasMany(models.RestCuentaMovimiento, { foreignKey: 'id_cuenta', as: 'movimientos' });
  };

  return RestCuenta;
};
