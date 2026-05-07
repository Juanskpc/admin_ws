/**
 * Migración inicial del módulo Reserva (salones de belleza / barberías).
 * Crea: tipo_negocio RESERVA + roles + esquema reserva + 8 tablas + niveles + permisos.
 *
 * Idempotente. Ejecutar con: npm run migrate:reserva
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Reserva (salones / barberías)\n');

        // 1. Tipo de negocio RESERVA
        console.log('1. Insertando tipo de negocio RESERVA...');
        await sequelize.query(`
            INSERT INTO general.gener_tipo_negocio (nombre, descripcion, estado)
            VALUES ('RESERVA', 'Salones de belleza, barberías y servicios con cita previa', 'A')
            ON CONFLICT (nombre) DO NOTHING;
        `, { transaction: t });

        const [[tipoReserva]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre='RESERVA';
        `, { transaction: t });
        const idTipoReserva = tipoReserva.id_tipo_negocio;
        console.log(`   id_tipo_negocio = ${idTipoReserva}\n`);

        // 2. Roles del salón
        console.log('2. Insertando roles...');
        await sequelize.query(`
            INSERT INTO general.gener_rol (descripcion, id_tipo_negocio, estado) VALUES
                ('ADMINISTRADOR',  :tipo, 'A'),
                ('RECEPCIONISTA',  :tipo, 'A'),
                ('PROFESIONAL',    :tipo, 'A')
            ON CONFLICT DO NOTHING;
        `, { replacements: { tipo: idTipoReserva }, transaction: t });

        const rolesReserva = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipoReserva }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolAdmin        = rolesReserva.find(r => r.descripcion === 'ADMINISTRADOR').id_rol;
        const rolRecepcion    = rolesReserva.find(r => r.descripcion === 'RECEPCIONISTA').id_rol;
        const rolProfesional  = rolesReserva.find(r => r.descripcion === 'PROFESIONAL').id_rol;
        console.log('   ' + rolesReserva.map(r => `${r.descripcion}=${r.id_rol}`).join(', ') + '\n');

        // 3. Esquema reserva
        console.log('3. Creando esquema reserva...');
        await sequelize.query(`CREATE SCHEMA IF NOT EXISTS reserva;`, { transaction: t });
        // gen_random_uuid() requiere pgcrypto; en RDS ya viene, pero guardamos por seguridad.
        await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`, { transaction: t });
        console.log('   OK\n');

        // 4. reserva_config — config por negocio
        console.log('4. Creando reserva.reserva_config...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_config (
                id_negocio                INTEGER PRIMARY KEY
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                anticipacion_min_horas    INTEGER     NOT NULL DEFAULT 1,
                buffer_limpieza_min       INTEGER     NOT NULL DEFAULT 10,
                ventana_cancelacion_horas INTEGER     NOT NULL DEFAULT 4,
                paso_slot_min             INTEGER     NOT NULL DEFAULT 15,
                cobro_adelantado          BOOLEAN     NOT NULL DEFAULT FALSE,
                instrucciones_pago        TEXT,
                fecha_creacion            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        console.log('   OK\n');

        // 5. reserva_servicio
        console.log('5. Creando reserva.reserva_servicio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_servicio (
                id_servicio         SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre              VARCHAR(150) NOT NULL,
                descripcion         TEXT,
                duracion_min        INTEGER NOT NULL CHECK (duracion_min > 0),
                precio              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (precio >= 0),
                color_hex           CHAR(7) DEFAULT '#3b82f6',
                imagen_url          VARCHAR(500),
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_servicio_negocio ON reserva.reserva_servicio (id_negocio, estado);
        `, { transaction: t });
        console.log('   OK\n');

        // 6. reserva_profesional
        console.log('6. Creando reserva.reserva_profesional...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_profesional (
                id_profesional      SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_usuario          INTEGER REFERENCES general.gener_usuario(id_usuario) ON DELETE SET NULL,
                nombre              VARCHAR(150) NOT NULL,
                especialidad        VARCHAR(150),
                telefono            VARCHAR(30),
                email               VARCHAR(120),
                foto_url            VARCHAR(500),
                color_hex           CHAR(7) DEFAULT '#10b981',
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_profesional_negocio ON reserva.reserva_profesional (id_negocio, estado);
        `, { transaction: t });
        console.log('   OK\n');

        // 7. reserva_profesional_servicio (M:N — qué servicios da cada profesional)
        console.log('7. Creando reserva.reserva_profesional_servicio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_profesional_servicio (
                id_profesional INTEGER NOT NULL REFERENCES reserva.reserva_profesional(id_profesional) ON DELETE CASCADE,
                id_servicio    INTEGER NOT NULL REFERENCES reserva.reserva_servicio(id_servicio) ON DELETE CASCADE,
                PRIMARY KEY (id_profesional, id_servicio)
            );
        `, { transaction: t });
        console.log('   OK\n');

        // 8. reserva_horario (semanal recurrente)
        console.log('8. Creando reserva.reserva_horario...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_horario (
                id_horario      SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_profesional  INTEGER REFERENCES reserva.reserva_profesional(id_profesional) ON DELETE CASCADE,
                dia_semana      SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
                hora_inicio     TIME NOT NULL,
                hora_fin        TIME NOT NULL,
                CHECK (hora_fin > hora_inicio)
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_horario_neg_dia
                ON reserva.reserva_horario (id_negocio, id_profesional, dia_semana);
        `, { transaction: t });
        console.log('   OK\n');

        // 9. reserva_bloqueo (vacaciones, festivos, descansos puntuales)
        console.log('9. Creando reserva.reserva_bloqueo...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_bloqueo (
                id_bloqueo      SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_profesional  INTEGER REFERENCES reserva.reserva_profesional(id_profesional) ON DELETE CASCADE,
                fecha_inicio    TIMESTAMP NOT NULL,
                fecha_fin       TIMESTAMP NOT NULL,
                motivo          VARCHAR(200),
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK (fecha_fin > fecha_inicio)
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_bloqueo_rango
                ON reserva.reserva_bloqueo (id_negocio, id_profesional, fecha_inicio, fecha_fin);
        `, { transaction: t });
        console.log('   OK\n');

        // 10. reserva_cita (la reserva)
        console.log('10. Creando reserva.reserva_cita...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_cita (
                id_cita                  SERIAL PRIMARY KEY,
                id_negocio               INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_profesional           INTEGER NOT NULL REFERENCES reserva.reserva_profesional(id_profesional),
                fecha_hora_inicio        TIMESTAMP NOT NULL,
                fecha_hora_fin           TIMESTAMP NOT NULL,
                estado                   VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','confirmada','completada','cancelada','no_show')),
                cliente_nombre           VARCHAR(150) NOT NULL,
                cliente_telefono         VARCHAR(30),
                cliente_email            VARCHAR(120),
                notas                    TEXT,
                codigo_publico           UUID NOT NULL DEFAULT gen_random_uuid(),
                creado_por_id_usuario    INTEGER REFERENCES general.gener_usuario(id_usuario),
                cancelado_por            VARCHAR(20),
                cancelado_motivo         TEXT,
                requiere_pago            BOOLEAN NOT NULL DEFAULT FALSE,
                monto_total              NUMERIC(14,2) NOT NULL DEFAULT 0,
                comprobante_pago_url     VARCHAR(500),
                pago_estado              VARCHAR(25) NOT NULL DEFAULT 'no_aplica'
                    CHECK (pago_estado IN ('no_aplica','pendiente_validacion','aprobado','rechazado')),
                pago_validado_por_id_usuario INTEGER REFERENCES general.gener_usuario(id_usuario),
                pago_validado_en         TIMESTAMP,
                pago_rechazo_motivo      TEXT,
                fecha_creacion           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CHECK (fecha_hora_fin > fecha_hora_inicio)
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_cita_codigo
                ON reserva.reserva_cita (codigo_publico);
            CREATE INDEX IF NOT EXISTS ix_reserva_cita_prof_fecha
                ON reserva.reserva_cita (id_profesional, fecha_hora_inicio)
                WHERE estado IN ('pendiente','confirmada');
            CREATE INDEX IF NOT EXISTS ix_reserva_cita_negocio_fecha
                ON reserva.reserva_cita (id_negocio, fecha_hora_inicio);
            CREATE INDEX IF NOT EXISTS ix_reserva_cita_pago_pendiente
                ON reserva.reserva_cita (id_negocio, pago_estado)
                WHERE pago_estado = 'pendiente_validacion';
        `, { transaction: t });
        console.log('   OK\n');

        // 11. reserva_cita_servicio (snapshot de precio/duración)
        console.log('11. Creando reserva.reserva_cita_servicio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_cita_servicio (
                id_cita               INTEGER NOT NULL REFERENCES reserva.reserva_cita(id_cita) ON DELETE CASCADE,
                id_servicio           INTEGER NOT NULL REFERENCES reserva.reserva_servicio(id_servicio),
                precio_snapshot       NUMERIC(14,2) NOT NULL,
                duracion_snapshot_min INTEGER NOT NULL,
                PRIMARY KEY (id_cita, id_servicio)
            );
        `, { transaction: t });
        console.log('   OK\n');

        // 12. Niveles de navegación
        console.log('12. Insertando niveles de navegación...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'RESERVA', NULL, 'calendar-clock', 'A', 1, '/reserva', :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva'
            );
        `, { replacements: { tipo: idTipoReserva }, transaction: t });

        const [[nivelRoot]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva';
        `, { replacements: { tipo: idTipoReserva }, transaction: t });
        const idNivelRoot = nivelRoot.id_nivel;

        const modulos = [
            ['DASHBOARD',     '/dashboard',     'layout-dashboard'],
            ['AGENDA',        '/agenda',        'calendar-days'],
            ['CITAS',         '/citas',         'calendar-check'],
            ['SERVICIOS',     '/servicios',     'scissors'],
            ['PROFESIONALES', '/profesionales', 'users'],
            ['HORARIOS',      '/horarios',      'clock'],
            ['CONFIGURACION', '/configuracion', 'settings'],
        ];
        for (const [desc, url, icono] of modulos) {
            await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, :icono, 'A', 1, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
                );
            `, { replacements: { desc, url, icono, padre: idNivelRoot, tipo: idTipoReserva }, transaction: t });
        }
        console.log('   OK\n');

        // 13. Permisos por rol
        console.log('13. Asignando permisos por rol...');

        // ADMINISTRADOR: total a los 7 módulos hijo
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, true, true, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IS NOT NULL
              AND n.url <> '/reserva'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolAdmin, tipo: idTipoReserva }, transaction: t });

        // RECEPCIONISTA: dashboard, agenda, citas (CRUD completo), servicios (ver), profesionales (ver)
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel,
                   true,
                   CASE WHEN n.url IN ('/citas') THEN true ELSE false END,
                   CASE WHEN n.url IN ('/citas') THEN true ELSE false END,
                   false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard','/agenda','/citas','/servicios','/profesionales')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolRecepcion, tipo: idTipoReserva }, transaction: t });

        // PROFESIONAL: solo ver su agenda y citas
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, false, false, false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard','/agenda','/citas')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolProfesional, tipo: idTipoReserva }, transaction: t });
        console.log('   OK\n');

        // 14. Backfill por-negocio (si ya existen negocios tipo RESERVA)
        console.log('14. Backfill gener_nivel_negocio para negocios RESERVA existentes...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.id_rol IN (
                SELECT id_rol FROM general.gener_rol WHERE id_tipo_negocio = :tipo AND estado = 'A'
            )
            JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                         AND niv.id_tipo_negocio = :tipo
                                         AND niv.id_tipo_nivel = 1
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { tipo: idTipoReserva }, transaction: t });
        console.log('   OK\n');

        // 15. Crear negocio demo Reserva
        console.log('15. Creando negocio demo Reserva...');
        await sequelize.query(`
            INSERT INTO general.gener_negocio (nombre, nit, email_contacto, id_tipo_negocio, estado)
            VALUES ('Salón Demo EscalApp', '900-RESERVA-001', 'reserva@escalapp.cloud', :tipo, 'A')
            ON CONFLICT DO NOTHING;
        `, { replacements: { tipo: idTipoReserva }, transaction: t });

        const [[negocioReserva]] = await sequelize.query(`
            SELECT id_negocio FROM general.gener_negocio
            WHERE nit = '900-RESERVA-001' AND id_tipo_negocio = :tipo;
        `, { replacements: { tipo: idTipoReserva }, transaction: t });

        if (negocioReserva) {
            const idNegocioReserva = negocioReserva.id_negocio;
            console.log(`   id_negocio = ${idNegocioReserva}`);

            // Config por defecto del negocio demo
            await sequelize.query(`
                INSERT INTO reserva.reserva_config (id_negocio)
                VALUES (:neg)
                ON CONFLICT (id_negocio) DO NOTHING;
            `, { replacements: { neg: idNegocioReserva }, transaction: t });

            // Vincular usuario principal
            const [[usuarioPrincipal]] = await sequelize.query(`
                SELECT id_usuario FROM general.gener_usuario
                WHERE num_identificacion = '1193035399' AND estado = 'A';
            `, { transaction: t });

            if (usuarioPrincipal) {
                const idUsuario = usuarioPrincipal.id_usuario;
                console.log(`   id_usuario = ${idUsuario}`);

                await sequelize.query(`
                    INSERT INTO general.gener_negocio_usuario (id_negocio, id_usuario, estado)
                    VALUES (:neg, :usr, 'A')
                    ON CONFLICT DO NOTHING;
                `, { replacements: { neg: idNegocioReserva, usr: idUsuario }, transaction: t });

                await sequelize.query(`
                    INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
                    VALUES (:usr, :rol, :neg, 'A')
                    ON CONFLICT DO NOTHING;
                `, { replacements: { usr: idUsuario, rol: rolAdmin, neg: idNegocioReserva }, transaction: t });

                await sequelize.query(`
                    INSERT INTO general.gener_nivel_negocio
                        (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
                    SELECT :neg, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    FROM general.gener_rol_nivel rn
                    JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                                 AND niv.id_tipo_negocio = :tipo
                                                 AND niv.id_tipo_nivel = 1
                    WHERE rn.id_rol = :rol
                    ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
                `, { replacements: { neg: idNegocioReserva, tipo: idTipoReserva, rol: rolAdmin }, transaction: t });

                console.log('   Usuario vinculado y permisos asignados.\n');
            } else {
                console.log('   Usuario 1193035399 no encontrado, saltando asignación.\n');
            }
        } else {
            console.log('   Negocio demo no creado (posiblemente ya existe con otro NIT).\n');
        }

        await t.commit();
        console.log('✓ Migración Reserva completada');
        console.log(`  tipo_negocio = ${idTipoReserva}, roles = ${rolesReserva.map(r => r.descripcion).join(', ')}`);
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        console.error(error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
