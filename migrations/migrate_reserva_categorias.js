/**
 * Categorías de servicio y banner del negocio.
 *
 * ## Por qué categorías
 *
 * El portal público lista el catálogo entero de golpe. Con trece servicios ya cuesta encontrar
 * lo que se busca, y un salón real tiene cuarenta: corte, color, uñas, cejas, tratamientos. La
 * categoría es el índice que convierte esa lista en algo navegable —«Barbería», «Color»,
 * «Manicure»— y es también como el negocio piensa su carta.
 *
 * Es una tabla y no un `VARCHAR` en `reserva_servicio` porque hay que **ordenarlas** (el negocio
 * decide qué sección va primero) y renombrarlas sin tocar cada servicio. Un texto libre además
 * se llena de duplicados por tildes y mayúsculas: «Color», «color», «Colór».
 *
 * `id_categoria` es NULL-able a propósito: los servicios que ya existen no tienen categoría y
 * deben seguir funcionando. El portal los agrupa bajo «Otros servicios» en vez de esconderlos.
 * `ON DELETE SET NULL` da la misma garantía si se borra una categoría.
 *
 * ## Por qué el banner va en `gener_negocio`
 *
 * Junto a `logo_url` y `colores`: es identidad del negocio, no del vertical. Mismo razonamiento
 * que en `migrate_reserva_marca`.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-categorias
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function columnaExiste(esquema, tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: categorías de servicio y banner ===\n');

        // ─────────── 1. Tabla de categorías ───────────
        console.log('1. reserva.reserva_categoria...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_categoria (
                id_categoria    SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre          VARCHAR(120) NOT NULL,
                descripcion     TEXT,
                orden           INTEGER NOT NULL DEFAULT 0,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });

        // Dos categorías con el mismo nombre en el mismo negocio no significan nada distinto y
        // rompen el índice visual del portal. El índice es parcial: una categoría inactiva no
        // debe impedir volver a crear una con ese nombre.
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_reserva_categoria_negocio_nombre
                ON reserva.reserva_categoria (id_negocio, lower(nombre))
                WHERE estado = 'A';
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_reserva_categoria_negocio
                ON reserva.reserva_categoria (id_negocio, orden);
        `, { transaction: t });
        console.log('   OK');

        // ─────────── 2. Enlace desde el servicio ───────────
        console.log('\n2. reserva_servicio.id_categoria...');
        if (!await columnaExiste('reserva', 'reserva_servicio', 'id_categoria', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_servicio
                ADD COLUMN id_categoria INTEGER
                    REFERENCES reserva.reserva_categoria(id_categoria) ON DELETE SET NULL;
            `, { transaction: t });
            await sequelize.query(`
                CREATE INDEX IF NOT EXISTS ix_reserva_servicio_categoria
                    ON reserva.reserva_servicio (id_categoria);
            `, { transaction: t });
            console.log('   + id_categoria');
        } else {
            console.log('   = id_categoria ya existía');
        }

        // ─────────── 3. Banner del negocio ───────────
        console.log('\n3. general.gener_negocio.banner_url...');
        if (!await columnaExiste('general', 'gener_negocio', 'banner_url', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio ADD COLUMN banner_url VARCHAR(500);
            `, { transaction: t });
            console.log('   + banner_url');
        } else {
            console.log('   = banner_url ya existía');
        }

        // ─────────── 4. Auditoría ───────────
        //
        // `reserva_categoria` tiene `estado`: entra en la regla fija del proyecto (toda tabla
        // con dinero o estado lleva su trigger en la misma migración que la crea).
        console.log('\n4. Trigger de auditoría...');
        const [[audit]] = await sequelize.query(`
            SELECT 1 AS ok FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';
        `, { transaction: t });
        if (audit) {
            await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON reserva.reserva_categoria;`, { transaction: t });
            await sequelize.query(`
                CREATE TRIGGER trg_audit
                    AFTER INSERT OR UPDATE OR DELETE ON reserva.reserva_categoria
                    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_categoria');
            `, { transaction: t });
            console.log('   OK — trg_audit en reserva_categoria');
        } else {
            console.log('   ⚠️  auditoria.fn_audit no existe — se omite el trigger');
        }

        await t.commit();
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
