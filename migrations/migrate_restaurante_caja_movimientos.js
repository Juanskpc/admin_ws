/**
 * Migración: sección «Movimientos» en Caja — seguimiento del flujo mesero → caja.
 *
 * Sube un subnivel de permiso `caja_ver_movimientos` bajo el módulo /caja.
 * Se siembra en FALSE para TODOS los roles y TODOS los negocios, incluidos los
 * administradores: mismo criterio que `caja_eliminar_pedido` (ver
 * `migrate_restaurante_caja_anular_pedido.js`) — es una pantalla de control sobre
 * lo que hacen los propios empleados (quién tomó cada pedido, quién lo cobró,
 * quién lo canceló o lo anuló), y eso se habilita a mano en Usuarios → Roles y
 * permisos, nunca por defecto.
 *
 * No crea ninguna tabla ni columna nueva: el rastro que esta sección muestra ya
 * existe —`pedid_orden.id_usuario` (quién tomó el pedido), `rest_movimiento_caja`
 * (quién cobró y quién anuló, con `id_movimiento_anula` marcando la reversa) y
 * `auditoria.audit_dato` (quién canceló sin cobrar, que no queda en ninguna
 * columna de `pedid_orden`) — ver `app_restaurante_api/services/seguimientoPedidoService.js`.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-caja-movimientos
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const CODIGO = 'caja_ver_movimientos';
const DESCRIPCION = 'CAJA - VER MOVIMIENTOS';

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Caja - Movimientos (seguimiento de pedidos)\n');

        // ── 1. Subnivel de permiso ──
        console.log(`1. Creando subnivel ${CODIGO}...`);
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

        // ── 2. Permiso por rol: FALSE para todos ──
        console.log('2. Sembrando permiso por rol en FALSE...');
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

        // ── 3. Permiso por negocio: FALSE para todos ──
        console.log('3. Sembrando permiso por negocio en FALSE...');
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
