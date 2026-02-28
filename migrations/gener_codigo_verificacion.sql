-- ============================================================
-- Tabla: general.gener_codigo_verificacion
-- Códigos OTP de verificación unificados.
--   - RESET_PASSWORD: recuperación de contraseña (id_usuario requerido)
--   - REGISTRO: verificación de email para crear cuenta (id_usuario nullable)
--
-- Migración inicial:   node migrations/migrate_password_reset.js
-- Migración evolución: node migrations/migrate_codigo_verificacion.js
-- ============================================================

CREATE TABLE IF NOT EXISTS general.gener_codigo_verificacion (
    id          BIGSERIAL    PRIMARY KEY,
    id_usuario  INTEGER      NULL
                REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    tipo        VARCHAR(30)  NOT NULL DEFAULT 'RESET_PASSWORD',
                -- Valores: 'RESET_PASSWORD', 'REGISTRO'
    token_hash  TEXT         NOT NULL,        -- bcrypt del OTP de 6 dígitos
    expires_at  TIMESTAMPTZ  NOT NULL,        -- NOW() + 15 min por defecto
    used        BOOLEAN      NOT NULL DEFAULT FALSE,
    attempts    INTEGER      NOT NULL DEFAULT 0,
    id_plan     INTEGER      NULL
                REFERENCES general.gener_plan(id_plan) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_gcv_id_usuario
    ON general.gener_codigo_verificacion(id_usuario);

CREATE INDEX IF NOT EXISTS idx_gcv_expires_used
    ON general.gener_codigo_verificacion(expires_at, used);

CREATE INDEX IF NOT EXISTS idx_gcv_email
    ON general.gener_codigo_verificacion(email);

CREATE INDEX IF NOT EXISTS idx_gcv_tipo
    ON general.gener_codigo_verificacion(tipo);

CREATE INDEX IF NOT EXISTS idx_gcv_email_tipo
    ON general.gener_codigo_verificacion(email, tipo, used);
