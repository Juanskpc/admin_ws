/**
 * Migración: anulación de pedidos ya cobrados desde Caja.
 *
 *  1. Subnivel de permiso `caja_eliminar_pedido` bajo el módulo /caja.
 *     Se siembra en FALSE para TODOS los roles y TODOS los negocios, incluidos
 *     los administradores: es una acción sensible (mueve dinero de un turno ya
 *     cobrado) y debe habilitarse a mano en Usuarios → Roles y permisos.
 *
 *  2. Columna `restaurante.rest_movimiento_caja.id_movimiento_anula`, que apunta
 *     al movimiento que esta fila reversa.
 *
 * La anulación NO borra nada: registra un movimiento compensatorio por cada
 * movimiento del pedido, así que el original sigue visible en el listado, el
 * neto de caja queda en cero y el `id_usuario` del compensatorio deja constancia
 * de quién lo hizo. `rest_movimiento_caja` ya tiene trg_audit, de modo que el
 * rastro completo queda además en `auditoria.audit_dato`.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-caja-anular-pedido
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const CODIGO = 'caja_eliminar_pedido';
const DESCRIPCION = 'CAJA - ELIMINAR PEDIDO';

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Caja - Anular pedido cobrado\n');

        // ── 1. Columna de enlace del movimiento compensatorio ──
        console.log('1. Agregando rest_movimiento_caja.id_movimiento_anula...');
        const [col] = await sequelize.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'restaurante'
              AND table_name = 'rest_movimiento_caja'
              AND column_name = 'id_movimiento_anula';
        `, { transaction: t });

        if (col.length === 0) {
            await sequelize.query(`
                ALTER TABLE restaurante.rest_movimiento_caja
                ADD COLUMN id_movimiento_anula INTEGER NULL
                    REFERENCES restaurante.rest_movimiento_caja(id_movimiento) ON DELETE RESTRICT;
            `, { transaction: t });
            await sequelize.query(`
                CREATE INDEX IF NOT EXISTS ix_rest_mov_caja_anula
                    ON restaurante.rest_movimiento_caja (id_movimiento_anula)
                    WHERE id_movimiento_anula IS NOT NULL;
            `, { transaction: t });
            console.log('   ✓ columna e índice creados');
        } else {
            console.log('   • ya existía, se omite');
        }

        // ── 2. Subnivel de permiso ──
        console.log(`2. Creando subnivel ${CODIGO}...`);
        const [[nivelCaja]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = 1 AND id_tipo_nivel = 1 AND url = '/caja'
            LIMIT 1;
        `, { transaction: t });

        if (!nivelCaja) {
            throw new Error('No existe el módulo /caja para restaurante. Ejecuta migrate:restaurante-caja primero.');
        }

        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT :desc, :padre, NULL, 'A', 4, :codigo, 1
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = 1 AND id_tipo_nivel = 4 AND url = :codigo
            );
        `, {
            replacements: { desc: DESCRIPCION, codigo: CODIGO, padre: nivelCaja.id_nivel },
            transaction: t,
        });
        console.log('   ✓ subnivel asegurado');

        // ── 3. Permiso por rol: FALSE para todos ──
        console.log('3. Sembrando permiso por rol en FALSE...');
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar,
                 estado, fecha_creacion, fecha_actualizacion)
            SELECT r.id_rol, nv.id_nivel, FALSE, FALSE, FALSE, FALSE,
                   'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = 1
             AND nv.id_tipo_nivel = 4
             AND nv.estado = 'A'
             AND nv.url = :codigo
            WHERE r.id_tipo_negocio = 1
              AND r.estado = 'A'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { codigo: CODIGO }, transaction: t });

        // ── 4. Permiso por negocio: FALSE para todos ──
        console.log('4. Sembrando permiso por negocio en FALSE...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT n.id_negocio, r.id_rol, nv.id_nivel, FALSE,
                   'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            JOIN general.gener_rol r
              ON r.estado = 'A'
             AND r.id_tipo_negocio = n.id_tipo_negocio
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = n.id_tipo_negocio
             AND nv.id_tipo_nivel = 4
             AND nv.estado = 'A'
             AND nv.url = :codigo
            WHERE n.estado = 'A'
              AND n.id_tipo_negocio = 1
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { codigo: CODIGO }, transaction: t });

        const [[conteo]] = await sequelize.query(`
            SELECT
              (SELECT COUNT(*) FROM general.gener_rol_nivel rn
                 JOIN general.gener_nivel nv ON nv.id_nivel = rn.id_nivel
                WHERE nv.url = :codigo)::int AS roles,
              (SELECT COUNT(*) FROM general.gener_nivel_negocio nn
                 JOIN general.gener_nivel nv ON nv.id_nivel = nn.id_nivel
                WHERE nv.url = :codigo)::int AS negocios,
              (SELECT COUNT(*) FROM general.gener_nivel_negocio nn
                 JOIN general.gener_nivel nv ON nv.id_nivel = nn.id_nivel
                WHERE nv.url = :codigo AND nn.puede_ver)::int AS habilitados;
        `, { replacements: { codigo: CODIGO }, transaction: t });

        await t.commit();
        console.log(`\n   filas rol=${conteo.roles} · negocio=${conteo.negocios} · habilitados=${conteo.habilitados}`);
        console.log('✓ Migración completada. Nadie tiene el permiso todavía.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
