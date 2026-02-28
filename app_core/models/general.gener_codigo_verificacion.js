// ============================================================
// Modelo Sequelize: general.gener_codigo_verificacion
// Tabla unificada para códigos de verificación (OTP).
//   - RESET_PASSWORD: recuperación de contraseña (requiere id_usuario)
//   - REGISTRO: verificación de email para crear cuenta (no requiere id_usuario)
//
// Migración: node migrations/migrate_codigo_verificacion.js
// ============================================================

module.exports = (sequelize, DataTypes) => {
    const GenerCodigoVerificacion = sequelize.define('GenerCodigoVerificacion', {
        id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            autoIncrement: true,
        },
        /** ID del usuario (nullable: en REGISTRO aún no existe usuario). */
        id_usuario: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        /** Email destino del código (siempre presente). */
        email: {
            type: DataTypes.STRING(255),
            allowNull: false,
        },
        /** Tipo de verificación: RESET_PASSWORD | REGISTRO */
        tipo: {
            type: DataTypes.STRING(30),
            allowNull: false,
            defaultValue: 'RESET_PASSWORD',
            validate: {
                isIn: [['RESET_PASSWORD', 'REGISTRO']],
            },
        },
        /** Hash bcrypt del OTP de 6 dígitos. NUNCA almacenar el código en texto plano. */
        token_hash: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        expires_at: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        /** true = ya fue usado; un token solo puede usarse una vez. */
        used: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
        },
        /** Contador de intentos fallidos de verificación. Máx: OTP_MAX_ATTEMPTS. */
        attempts: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
        },
        /** ID del plan seleccionado (solo para tipo REGISTRO, opcional). */
        id_plan: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    }, {
        tableName: 'gener_codigo_verificacion',
        schema: 'general',
        timestamps: false,
    });

    GenerCodigoVerificacion.associate = (models) => {
        GenerCodigoVerificacion.belongsTo(models.GenerUsuario, {
            foreignKey: 'id_usuario',
            as: 'usuario',
        });
        GenerCodigoVerificacion.belongsTo(models.GenerPlan, {
            foreignKey: 'id_plan',
            as: 'plan',
        });
    };

    return GenerCodigoVerificacion;
};
