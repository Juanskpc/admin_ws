/**
 * Caja, formas de pago y multipago para el vertical `reserva`.
 *
 * Crea:
 *   1. `reserva.reserva_metodo_pago`   — formas de pago propias de cada negocio
 *   2. `reserva.reserva_caja`          — turnos de caja (apertura / cierre)
 *   3. `reserva.reserva_movimiento_caja` — ingresos y egresos del turno
 *   4. `reserva.reserva_pago_cita`     — desglose multipago de una cita
 *   5. columnas nuevas en `reserva_cita` (`id_metodo_pago`, `id_caja`) y en
 *      `reserva_config` (`permite_cobro_profesional`, `permite_multipago`)
 *   6. el nivel `/caja` en el catálogo de permisos
 *
 * ## Decisiones que quedan grabadas en el esquema
 *
 * - **Una sola caja abierta por negocio**, garantizado por un índice único parcial y no por una
 *   comprobación en el servicio. Dos peticiones simultáneas de apertura ganarían las dos si la
 *   regla viviera solo en JavaScript.
 * - **`reserva_movimiento_caja.id_profesional`** existe aunque el profesional no cobre: es quien
 *   *prestó* el servicio, y es lo que permite liquidar al final del día. Sin esa columna habría
 *   que reconstruirlo desde la cita, y una cita puede cambiar de profesional.
 * - **`id_caja` en la cita** deja constancia de en qué turno se cobró. Es la única forma de
 *   cuadrar una caja pasada sin depender de las fechas, que se mueven si se reagenda.
 * - Se auditan las tres tablas con dinero (`trg_audit`), según la regla fija del proyecto.
 *
 * Idempotente: `IF NOT EXISTS` en todo, consulta a `information_schema` antes de cada `ALTER`,
 * y una sola transacción.
 *
 *   npm run migrate:reserva-caja
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function columnaExiste(tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'reserva' AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: Caja y formas de pago (reserva) ===\n');

        // ─────────── 1. Formas de pago por negocio ───────────
        console.log('1. reserva.reserva_metodo_pago...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_metodo_pago (
                id_metodo_pago  SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre          VARCHAR(80) NOT NULL,
                orden           SMALLINT NOT NULL DEFAULT 0,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });

        // Un negocio no puede tener dos formas de pago activas con el mismo nombre: al cuadrar
        // la caja, «Efectivo» y «efectivo» serían dos filas distintas en el desglose.
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_metodo_pago_nombre
            ON reserva.reserva_metodo_pago (id_negocio, lower(trim(nombre)))
            WHERE estado = 'A';
        `, { transaction: t });
        console.log('   OK\n');

        // ─────────── 2. Turnos de caja ───────────
        console.log('2. reserva.reserva_caja...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_caja (
                id_caja          SERIAL PRIMARY KEY,
                id_negocio       INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_usuario       INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
                monto_apertura   NUMERIC(12,2) NOT NULL DEFAULT 0,
                monto_cierre     NUMERIC(12,2),
                monto_reportado  NUMERIC(12,2),
                diferencia       NUMERIC(12,2),
                fecha_apertura   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_cierre     TIMESTAMP,
                estado           CHAR(1) NOT NULL DEFAULT 'A',
                observaciones    TEXT
            );
        `, { transaction: t });

        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_caja_abierta_por_negocio
            ON reserva.reserva_caja (id_negocio)
            WHERE estado = 'A';
        `, { transaction: t });
        console.log('   OK\n');

        // ─────────── 3. Movimientos del turno ───────────
        console.log('3. reserva.reserva_movimiento_caja...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_movimiento_caja (
                id_movimiento   SERIAL PRIMARY KEY,
                id_caja         INTEGER NOT NULL REFERENCES reserva.reserva_caja(id_caja) ON DELETE CASCADE,
                tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('INGRESO','EGRESO')),
                monto           NUMERIC(12,2) NOT NULL CHECK (monto > 0),
                concepto        VARCHAR(255),
                id_cita         INTEGER REFERENCES reserva.reserva_cita(id_cita) ON DELETE SET NULL,
                id_profesional  INTEGER REFERENCES reserva.reserva_profesional(id_profesional) ON DELETE SET NULL,
                id_metodo_pago  INTEGER REFERENCES reserva.reserva_metodo_pago(id_metodo_pago) ON DELETE SET NULL,
                id_usuario      INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
                fecha           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_movimiento_caja_id_caja
            ON reserva.reserva_movimiento_caja (id_caja);
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_movimiento_caja_profesional
            ON reserva.reserva_movimiento_caja (id_caja, id_profesional);
        `, { transaction: t });
        console.log('   OK\n');

        // ─────────── 4. Desglose multipago ───────────
        console.log('4. reserva.reserva_pago_cita...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_pago_cita (
                id_pago         SERIAL PRIMARY KEY,
                id_cita         INTEGER NOT NULL REFERENCES reserva.reserva_cita(id_cita) ON DELETE CASCADE,
                id_metodo_pago  INTEGER NOT NULL REFERENCES reserva.reserva_metodo_pago(id_metodo_pago),
                valor           NUMERIC(12,2) NOT NULL CHECK (valor > 0),
                fecha           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_pago_cita_id_cita
            ON reserva.reserva_pago_cita (id_cita);
        `, { transaction: t });
        console.log('   OK\n');

        // ─────────── 5. Columnas nuevas ───────────
        console.log('5. Columnas en reserva_cita y reserva_config...');

        if (!await columnaExiste('reserva_cita', 'id_metodo_pago', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_cita
                ADD COLUMN id_metodo_pago INTEGER
                    REFERENCES reserva.reserva_metodo_pago(id_metodo_pago) ON DELETE SET NULL;
            `, { transaction: t });
            console.log('   + reserva_cita.id_metodo_pago');
        }

        if (!await columnaExiste('reserva_cita', 'id_caja', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_cita
                ADD COLUMN id_caja INTEGER
                    REFERENCES reserva.reserva_caja(id_caja) ON DELETE SET NULL;
            `, { transaction: t });
            console.log('   + reserva_cita.id_caja');
        }

        if (!await columnaExiste('reserva_config', 'permite_cobro_profesional', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_config
                ADD COLUMN permite_cobro_profesional BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   + reserva_config.permite_cobro_profesional');
        }

        if (!await columnaExiste('reserva_config', 'permite_multipago', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_config
                ADD COLUMN permite_multipago BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   + reserva_config.permite_multipago');
        }

        if (!await columnaExiste('reserva_config', 'exige_caja_abierta', t)) {
            // Sin esto, cobrar con la caja cerrada sería posible y el dinero no aparecería en
            // ningún turno. Se deja apagado por defecto para no romper a quien ya opera sin caja.
            await sequelize.query(`
                ALTER TABLE reserva.reserva_config
                ADD COLUMN exige_caja_abierta BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   + reserva_config.exige_caja_abierta');
        }
        console.log('   OK\n');

        // ─────────── 6. Formas de pago por defecto ───────────
        //
        // Un negocio sin formas de pago no puede completar ni una cita, así que se siembran las
        // tres habituales en Colombia. Solo para negocios que aún no tengan ninguna: si el
        // dueño ya configuró las suyas, esto no le añade nada.
        console.log('6. Sembrando formas de pago por defecto...');
        const [sembradas] = await sequelize.query(`
            INSERT INTO reserva.reserva_metodo_pago (id_negocio, nombre, orden, estado)
            SELECT n.id_negocio, v.nombre, v.orden, 'A'
            FROM general.gener_negocio n
            JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
            CROSS JOIN (VALUES ('Efectivo', 1), ('Tarjeta', 2), ('Transferencia', 3)) AS v(nombre, orden)
            WHERE tn.nombre = 'RESERVA'
              AND n.estado = 'A'
              AND NOT EXISTS (
                  SELECT 1 FROM reserva.reserva_metodo_pago mp WHERE mp.id_negocio = n.id_negocio
              )
            RETURNING id_metodo_pago;
        `, { transaction: t });
        console.log(`   OK — ${sembradas.length} forma(s) de pago creadas\n`);

        // ─────────── 7. Auditoría ───────────
        //
        // Regla fija del proyecto: toda tabla con dinero o estado lleva su trigger en la misma
        // migración que la crea. `reserva_pago_cita` es detalle de alta rotación y bajo valor
        // individual, pero mueve dinero y cuadra una caja: se audita igual.
        console.log('7. Triggers de auditoría...');
        const tablasAudit = [
            ['reserva_caja', 'id_caja'],
            ['reserva_movimiento_caja', 'id_movimiento'],
            ['reserva_metodo_pago', 'id_metodo_pago'],
            ['reserva_pago_cita', 'id_pago'],
        ];
        const [[fnAudit]] = await sequelize.query(`
            SELECT 1 AS ok FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';
        `, { transaction: t });

        if (!fnAudit) {
            console.log('   ⚠️  auditoria.fn_audit no existe — se omiten los triggers.');
        } else {
            for (const [tabla, pk] of tablasAudit) {
                await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON reserva.${tabla};`, { transaction: t });
                await sequelize.query(`
                    CREATE TRIGGER trg_audit
                        AFTER INSERT OR UPDATE OR DELETE ON reserva.${tabla}
                        FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');
                `, { transaction: t });
                console.log(`   ✓ ${tabla}`);
            }
        }
        console.log('   OK\n');

        // ─────────── 8. Nivel /caja en el catálogo de permisos ───────────
        console.log('8. Nivel /caja...');
        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        const idTipo = tipo.id_tipo_negocio;

        const [[padre]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva';
        `, { replacements: { tipo: idTipo }, transaction: t });

        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'CAJA', :padre, 'wallet', 'A', 1, '/caja', :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/caja'
            );
        `, { replacements: { padre: padre ? padre.id_nivel : null, tipo: idTipo }, transaction: t });

        const [[nivelCaja]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/caja';
        `, { replacements: { tipo: idTipo }, transaction: t });

        // ADMINISTRADOR y RECEPCIONISTA: la caja es trabajo de mostrador, no solo del dueño.
        // El profesional no la ve: cobra su servicio, no cuadra el turno.
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT r.id_rol, :nivel, true, true, true, false, 'A'
            FROM general.gener_rol r
            WHERE r.id_tipo_negocio = :tipo
              AND r.descripcion IN ('ADMINISTRADOR', 'RECEPCIONISTA')
              AND r.estado = 'A'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { nivel: nivelCaja.id_nivel, tipo: idTipo }, transaction: t });

        const [backfill] = await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, true, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.id_nivel = :nivel
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, { replacements: { nivel: nivelCaja.id_nivel, tipo: idTipo }, transaction: t });
        console.log(`   OK — id_nivel=${nivelCaja.id_nivel}, ${backfill.length} fila(s) de negocio\n`);

        await t.commit();

        // Verificación tras el commit: se comprueba lo que quedó, no lo que se creyó escribir.
        const tablas = await sequelize.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'reserva' AND table_name IN
                ('reserva_metodo_pago','reserva_caja','reserva_movimiento_caja','reserva_pago_cita')
            ORDER BY table_name;
        `, { type: sequelize.QueryTypes.SELECT });
        const cols = await sequelize.query(`
            SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'reserva'
              AND ((table_name = 'reserva_cita'   AND column_name IN ('id_metodo_pago','id_caja'))
                OR (table_name = 'reserva_config' AND column_name IN ('permite_cobro_profesional','permite_multipago','exige_caja_abierta')))
            ORDER BY table_name, column_name;
        `, { type: sequelize.QueryTypes.SELECT });

        console.log('=== Resultado ===');
        console.log('   Tablas:', tablas.map(x => x.table_name).join(', '));
        cols.forEach(c => console.log(`   Columna: ${c.table_name}.${c.column_name}`));
        console.log('\nMigración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
