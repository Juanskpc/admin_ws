/**
 * Perfiles de rubro en `reserva`: las particularidades de salón, spa, estética, tatuaje y
 * mascotas (ver `docs/perfiles-de-reserva.md`).
 *
 *   npm run migrate:reserva-perfiles
 *
 * ## La regla que gobierna toda esta migración
 *
 * **Cada columna nueva nace en un valor neutro**, y con ese valor el sistema hace exactamente lo
 * que hacía antes: `proceso_min = 0` no libera ningún tramo, `deposito_pct = 0` deja el cobro
 * adelantado todo-o-nada de siempre, `id_recurso` nulo no consulta ninguna cabina, sin filas en
 * `reserva_servicio_variante` el servicio cobra su precio de lista. Así una barbería que ya
 * factura no cambia en nada, y lo vigila `__tests__/reserva/motor_dorado.test.js`.
 *
 * `reserva` tiene cliente en producción desde el 2026-09-09, así que ADR-003 ya aplica: solo
 * cambios aditivos. Todo lo de aquí lo es.
 *
 * ## Qué crea
 *
 * 1. `reserva_config`: `funciones` (qué opciones del perfil encendió o apagó el negocio),
 *    `deposito_pct`, `deposito_reembolsable`, `hora_checkin`, `hora_checkout`.
 * 2. Recursos (cabinas, salas, equipos): `reserva_tipo_recurso` + `reserva_recurso`.
 * 3. `reserva_servicio`: tiempo de proceso, «a cotizar», consentimiento y tipo de recurso.
 * 4. `reserva_servicio_variante`: precio y duración por variante (largo, tamaño, zona).
 * 5. `reserva_mascota`: la mascota del cliente, colgada de `platform.persona_negocio`.
 * 6. `reserva_cita`: tramos de proceso, abono, mascota y recurso. `reserva_cita_servicio`:
 *    la variante elegida. `reserva_hold`: el recurso apartado.
 * 7. `reserva_ficha`: ficha del cliente (notas, fórmulas, contraindicaciones, consentimientos,
 *    vacunas). Datos sensibles: se audita **sin** su contenido.
 * 8. `reserva_profesional_imagen`: portafolio por profesional.
 * 9. Auditoría de las tablas con dinero o estado.
 * 10. Vistas nuevas en el catálogo de permisos: `/recursos` y `/mascotas`.
 *
 * Las **acciones** nuevas (ficha, abonos, estancias) van en `migrate_reserva_subniveles.js`, que
 * se corre **después** de esta y de `migrate:reserva-estancias`.
 *
 * Idempotente: guardas `IF NOT EXISTS` / `information_schema` en cada paso.
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');
const { publicarVista, auditar, asegurarColumna } = require('./lib_vistas_reserva');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: perfiles de rubro (reserva) ===\n');

        // ── 1. Configuración ──────────────────────────────────────────────────
        console.log('1. reserva_config...');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_config', 'funciones',
            `JSONB NOT NULL DEFAULT '{}'::jsonb`);
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_config', 'deposito_pct',
            'SMALLINT NOT NULL DEFAULT 0 CHECK (deposito_pct BETWEEN 0 AND 100)');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_config', 'deposito_reembolsable',
            'BOOLEAN NOT NULL DEFAULT true');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_config', 'hora_checkin',
            `TIME NOT NULL DEFAULT '15:00'`);
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_config', 'hora_checkout',
            `TIME NOT NULL DEFAULT '12:00'`);

        // ── 2. Recursos ───────────────────────────────────────────────────────
        console.log('\n2. Recursos...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_tipo_recurso (
                id_tipo_recurso     SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre              VARCHAR(80) NOT NULL,
                descripcion         VARCHAR(255),
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_tipo_recurso_negocio
                ON reserva.reserva_tipo_recurso (id_negocio);

            CREATE TABLE IF NOT EXISTS reserva.reserva_recurso (
                id_recurso          SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_tipo_recurso     INTEGER NOT NULL REFERENCES reserva.reserva_tipo_recurso(id_tipo_recurso),
                nombre              VARCHAR(80) NOT NULL,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_recurso_tipo
                ON reserva.reserva_recurso (id_negocio, id_tipo_recurso);
        `, { transaction: t });
        console.log('   OK');

        // ── 3. Servicio ───────────────────────────────────────────────────────
        console.log('\n3. reserva_servicio...');
        // Tramo de proceso: a los `proceso_desde_min` minutos de empezar, el profesional queda
        // libre durante `proceso_min` (el tinte actuando). La cita sigue ocupando al cliente.
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_servicio', 'proceso_desde_min',
            'INTEGER NOT NULL DEFAULT 0 CHECK (proceso_desde_min >= 0)');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_servicio', 'proceso_min',
            'INTEGER NOT NULL DEFAULT 0 CHECK (proceso_min >= 0)');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_servicio', 'a_cotizar',
            'BOOLEAN NOT NULL DEFAULT false');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_servicio', 'requiere_consentimiento',
            'BOOLEAN NOT NULL DEFAULT false');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_servicio', 'id_tipo_recurso',
            'INTEGER NULL REFERENCES reserva.reserva_tipo_recurso(id_tipo_recurso)');

        // ── 4. Variantes ──────────────────────────────────────────────────────
        console.log('\n4. Variantes de servicio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_servicio_variante (
                id_variante         SERIAL PRIMARY KEY,
                id_servicio         INTEGER NOT NULL REFERENCES reserva.reserva_servicio(id_servicio) ON DELETE CASCADE,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre              VARCHAR(80) NOT NULL,
                -- Clave opcional para emparejar con un atributo: el tamaño de la mascota
                -- (PEQUENO, MEDIANO, GRANDE, GIGANTE) elige la variante sola.
                clave               VARCHAR(20),
                duracion_min        INTEGER NOT NULL CHECK (duracion_min > 0),
                precio              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (precio >= 0),
                orden               SMALLINT NOT NULL DEFAULT 0,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_variante_servicio
                ON reserva.reserva_servicio_variante (id_servicio);
        `, { transaction: t });
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita_servicio', 'id_variante',
            'INTEGER NULL REFERENCES reserva.reserva_servicio_variante(id_variante) ON DELETE SET NULL');
        // El nombre de la variante se congela como el precio: renombrar «Largo» mañana no debe
        // reescribir lo que dice una cita ya cobrada.
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita_servicio', 'variante_snapshot',
            'VARCHAR(80) NULL');

        // ── 5. Mascotas ───────────────────────────────────────────────────────
        console.log('\n5. Mascotas...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_mascota (
                id_mascota          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_persona_negocio  UUID NOT NULL REFERENCES platform.persona_negocio(id_persona_negocio),
                nombre              VARCHAR(80) NOT NULL,
                especie             VARCHAR(20) NOT NULL DEFAULT 'PERRO',
                raza                VARCHAR(80),
                tamano              VARCHAR(10) CHECK (tamano IN ('PEQUENO', 'MEDIANO', 'GRANDE', 'GIGANTE')),
                peso_kg             NUMERIC(5,2),
                fecha_nacimiento    DATE,
                sexo                CHAR(1) CHECK (sexo IN ('M', 'H')),
                comportamiento      VARCHAR(160),
                notas               TEXT,
                foto_url            VARCHAR(500),
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_mascota_dueno
                ON reserva.reserva_mascota (id_negocio, id_persona_negocio);
        `, { transaction: t });
        console.log('   OK');

        // ── 6. Cita y hold ────────────────────────────────────────────────────
        console.log('\n6. reserva_cita / reserva_hold...');
        // Lista de tramos [desde_min, hasta_min], relativos al inicio, en los que el profesional
        // queda libre. Relativos para que reagendar no tenga que recalcularlos.
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita', 'proceso_tramos', 'JSONB NULL');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita', 'monto_abono', 'NUMERIC(14,2) NULL');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita', 'id_metodo_pago_abono',
            'INTEGER NULL REFERENCES reserva.reserva_metodo_pago(id_metodo_pago)');
        // Turno de caja en el que entró el abono. NULL con abono aprobado = aún por asentar.
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita', 'id_caja_abono',
            'INTEGER NULL REFERENCES reserva.reserva_caja(id_caja)');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita', 'id_mascota',
            'UUID NULL REFERENCES reserva.reserva_mascota(id_mascota) ON DELETE SET NULL');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_cita', 'id_recurso',
            'INTEGER NULL REFERENCES reserva.reserva_recurso(id_recurso)');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_hold', 'id_recurso',
            'INTEGER NULL REFERENCES reserva.reserva_recurso(id_recurso)');
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_reserva_cita_recurso
                ON reserva.reserva_cita (id_recurso, fecha_hora_inicio) WHERE id_recurso IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_reserva_cita_mascota
                ON reserva.reserva_cita (id_mascota) WHERE id_mascota IS NOT NULL;
        `, { transaction: t });

        // ── 7. Ficha ──────────────────────────────────────────────────────────
        console.log('\n7. Ficha del cliente...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_ficha (
                id_ficha            SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_persona_negocio  UUID NOT NULL REFERENCES platform.persona_negocio(id_persona_negocio),
                id_mascota          UUID NULL REFERENCES reserva.reserva_mascota(id_mascota) ON DELETE CASCADE,
                id_cita             INTEGER NULL REFERENCES reserva.reserva_cita(id_cita) ON DELETE SET NULL,
                tipo                VARCHAR(20) NOT NULL
                                    CHECK (tipo IN ('NOTA', 'FORMULA', 'CONTRAINDICACION',
                                                    'CONSENTIMIENTO', 'VACUNA', 'REFERENCIA')),
                titulo              VARCHAR(150),
                contenido           TEXT,
                archivo_url         VARCHAR(500),
                vence_en            DATE,
                id_usuario          INTEGER REFERENCES general.gener_usuario(id_usuario),
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_ficha_cliente
                ON reserva.reserva_ficha (id_negocio, id_persona_negocio, fecha_creacion DESC);
            CREATE INDEX IF NOT EXISTS idx_reserva_ficha_cita
                ON reserva.reserva_ficha (id_cita) WHERE id_cita IS NOT NULL;
        `, { transaction: t });
        console.log('   OK');

        // ── 8. Portafolio ─────────────────────────────────────────────────────
        console.log('\n8. Portafolio por profesional...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_profesional_imagen (
                id_imagen           SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_profesional      INTEGER NOT NULL REFERENCES reserva.reserva_profesional(id_profesional) ON DELETE CASCADE,
                url                 VARCHAR(500) NOT NULL,
                descripcion         VARCHAR(200),
                orden               SMALLINT NOT NULL DEFAULT 0,
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_prof_imagen
                ON reserva.reserva_profesional_imagen (id_profesional, orden);
        `, { transaction: t });
        console.log('   OK');

        // ── 9. Auditoría ──────────────────────────────────────────────────────
        console.log('\n9. Auditoría...');
        for (const [tabla, pk, sensibles] of [
            ['reserva.reserva_tipo_recurso', 'id_tipo_recurso'],
            ['reserva.reserva_recurso', 'id_recurso'],
            ['reserva.reserva_servicio_variante', 'id_variante'],
            ['reserva.reserva_mascota', 'id_mascota'],
            // Salud: se audita quién tocó qué ficha y cuándo, pero no se copia lo que dice.
            ['reserva.reserva_ficha', 'id_ficha', 'contenido'],
        ]) {
            if (await auditar(sequelize, t, tabla, pk, sensibles)) console.log(`   ✓ ${tabla}`);
        }

        // ── 10. Vistas ────────────────────────────────────────────────────────
        console.log('\n10. Vistas del catálogo de permisos...');
        const recursos = await publicarVista(sequelize, t, {
            url: '/recursos', descripcion: 'RECURSOS', icono: 'door-open',
            roles: { ADMINISTRADOR: { crear: true, editar: true, eliminar: true } },
        });
        console.log(`   /recursos (${recursos.ajustes} ajuste(s) de negocio)`);
        const mascotas = await publicarVista(sequelize, t, {
            url: '/mascotas', descripcion: 'MASCOTAS', icono: 'paw-print',
            roles: {
                ADMINISTRADOR: { crear: true, editar: true, eliminar: true },
                RECEPCIONISTA: { crear: true, editar: true },
                PROFESIONAL: {},
            },
        });
        console.log(`   /mascotas (${mascotas.ajustes} ajuste(s) de negocio)`);

        await t.commit();
        console.log('\n✓ Migración de perfiles completada.');
        console.log('  Siguiente: npm run migrate:reserva-estancias && npm run migrate:reserva-subniveles\n');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
