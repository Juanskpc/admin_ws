/**
 * Migración: permiso para eliminar la cuenta de un cliente (tiquetera / fiado).
 *
 * Crea el subnivel `clientes_eliminar` bajo el módulo /clientes y lo siembra **en FALSE para
 * todos los roles, administradores incluidos**: quién puede eliminar una tiquetera lo decide el
 * dueño en Usuarios → Roles y permisos, igual que `caja_eliminar_pedido`.
 *
 * Eliminar no borra el libro del cliente (`cuentaService.eliminarCuenta` marca `estado = 'E'`),
 * así que esta migración no toca ninguna tabla de datos: `rest_cuenta.estado` es CHAR(1) sin
 * CHECK y ya admite la 'E'.
 *
 * ⚠️ `gener_nivel_negocio` se siembra SOLO en los negocios que ya tienen filas propias. Meterle
 * una fila a un negocio que no tenía ninguna lo convertiría en «negocio con ajustes propios», y
 * a esos la visibilidad se les lee de esa tabla: se quedaría sin ver el resto de la vertical.
 * A los demás les basta la matriz global (`gener_rol_nivel`), que queda en FALSE.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-clientes-eliminar
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

const URL_MODULO = '/clientes';
const CODIGO = 'clientes_eliminar';
const DESCRIPCION = 'CLIENTES - ELIMINAR TIQUETERA';

async function unaFila(sql, replacements, transaction) {
    const [filas] = await sequelize.query(sql, { replacements, transaction });
    return filas.length ? filas[0] : null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante — permiso para eliminar cuentas de cliente\n');

        const tipo = await unaFila(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio
              WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
              ORDER BY id_tipo_negocio LIMIT 1;`,
            {},
            t,
        );
        if (!tipo) throw new Error('No se encontró el tipo de negocio RESTAURANTE.');
        const idTipoNegocio = Number(tipo.id_tipo_negocio);

        const tipoAccion = await unaFila(
            `SELECT id_tipo_nivel FROM general.gener_tipo_nivel
              WHERE estado = 'A' AND UPPER(nombre) = 'ACCION' ORDER BY id_tipo_nivel LIMIT 1;`,
            {},
            t,
        );
        if (!tipoAccion) throw new Error('No se encontró el tipo de nivel ACCION.');
        const idTipoNivelAccion = Number(tipoAccion.id_tipo_nivel);

        const modulo = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio, url: URL_MODULO },
            t,
        );
        if (!modulo) {
            throw new Error('No existe el módulo /clientes. Ejecuta antes npm run migrate:restaurante-cuentas.');
        }

        // ── 1. El subnivel ──
        console.log(`1. Creando subnivel ${CODIGO}...`);
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
            SELECT :descripcion, :idNivelPadre, NULL, 'A', :idTipoNivelAccion, :idTipoNegocio, :codigo, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :idTipoNegocio
                  AND id_tipo_nivel = :idTipoNivelAccion
                  AND url = :codigo
            );
        `, {
            replacements: {
                descripcion: DESCRIPCION,
                idNivelPadre: Number(modulo.id_nivel),
                idTipoNivelAccion,
                idTipoNegocio,
                codigo: CODIGO,
            },
            transaction: t,
        });
        console.log('   ✓');

        // ── 2. Matriz global: FALSE para todos los roles ──
        console.log('2. Sembrando el permiso por rol en FALSE...');
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar,
                 estado, fecha_creacion, fecha_actualizacion)
            SELECT r.id_rol, nv.id_nivel, false, false, false, false,
                   'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = r.id_tipo_negocio
             AND nv.id_tipo_nivel = :idTipoNivelAccion
             AND nv.estado = 'A'
             AND nv.url = :codigo
            WHERE r.id_tipo_negocio = :idTipoNegocio
              AND r.estado = 'A'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { idTipoNegocio, idTipoNivelAccion, codigo: CODIGO }, transaction: t });
        console.log('   ✓');

        // ── 3. Negocios con ajustes propios: FALSE explícito ──
        console.log('3. Sembrando FALSE en los negocios que ya tienen ajustes propios...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT n.id_negocio, r.id_rol, nv.id_nivel, false,
                   'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            JOIN general.gener_rol r
              ON r.estado = 'A'
             AND r.id_tipo_negocio = n.id_tipo_negocio
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = n.id_tipo_negocio
             AND nv.id_tipo_nivel = :idTipoNivelAccion
             AND nv.estado = 'A'
             AND nv.url = :codigo
            WHERE n.estado = 'A'
              AND n.id_tipo_negocio = :idTipoNegocio
              AND EXISTS (
                  SELECT 1 FROM general.gener_nivel_negocio nn WHERE nn.id_negocio = n.id_negocio
              )
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { idTipoNegocio, idTipoNivelAccion, codigo: CODIGO }, transaction: t });
        console.log('   ✓');

        await t.commit();
        console.log('\n✓ Migración completada. Nadie puede eliminar tiqueteras todavía: se concede en Roles y permisos.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
