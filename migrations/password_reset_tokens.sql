-- ============================================================
-- Migración: general.password_reset_tokens
-- OTPs de un solo uso para recuperación de contraseña.
--
-- Referencia: general.gener_usuario.id_usuario
-- Ejecutar: node migrations/migrate_password_reset.js
-- ============================================================

CREATE TABLE IF NOT EXISTS general.password_reset_tokens (
    id          BIGSERIAL PRIMARY KEY,
    id_usuario  INTEGER   NOT NULL
                REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
    token_hash  TEXT      NOT NULL,        -- bcrypt del OTP de 6 dígitos
    expires_at  TIMESTAMPTZ NOT NULL,      -- NOW() + 15 min por defecto
    used        BOOLEAN   NOT NULL DEFAULT FALSE,
    attempts    INTEGER   NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_prt_id_usuario
    ON general.password_reset_tokens(id_usuario);

CREATE INDEX IF NOT EXISTS idx_prt_expires_used
    ON general.password_reset_tokens(expires_at, used);

-- ============================================================
-- Seed de prueba (solo desarrollo) — ELIMINAR EN PRODUCCIÓN
-- Inserta un token de ejemplo con OTP "123456" (no válido en prod)
-- INSERT INTO general.password_reset_tokens (id_usuario, token_hash, expires_at)
-- VALUES (1, '<bcrypt_hash_de_123456>', NOW() + INTERVAL '15 minutes');
-- ============================================================
