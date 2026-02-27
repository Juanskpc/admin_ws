// ============================================================
// Modelo Sequelize: general.password_reset_tokens
// Tabla para OTPs de recuperación de contraseña.
// Se crea con: node migrations/migrate_password_reset.js
// ============================================================

module.exports = (sequelize, DataTypes) => {
    const PasswordResetToken = sequelize.define('PasswordResetToken', {
        id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            autoIncrement: true,
        },
        id_usuario: {
            type: DataTypes.INTEGER,
            allowNull: false,
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
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    }, {
        tableName: 'password_reset_tokens',
        schema: 'general',
        timestamps: false,
    });

    PasswordResetToken.associate = (models) => {
        PasswordResetToken.belongsTo(models.GenerUsuario, {
            foreignKey: 'id_usuario',
            as: 'usuario',
        });
    };

    return PasswordResetToken;
};
