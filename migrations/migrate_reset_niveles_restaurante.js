/**
 * Resetea niveles y permisos de RESTAURANTE (id_tipo_negocio = 1).
 *
 * Objetivo:
 * 1) Reemplazar niveles de restaurante por una lista corta de modulos.
 * 2) Quitar permisos para todos los roles de restaurante, dejando activos solo los roles administrador.
 * 3) Rehidratar gener_nivel_usuario para restaurante con la nueva matriz.
 *
 * Uso:
 *   node migrations/migrate_reset_niveles_restaurante.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;
const RESTAURANTE_TIPO_ID = 1;

async function getModuloTipoNivelId(transaction) {
    const [rows] = await sequelize.query(
        `
        SELECT id_tipo_nivel
        FROM general.gener_tipo_nivel
        WHERE estado = 'A'
          AND UPPER(nombre) = 'MODULO'
        LIMIT 1;
        `,
        { transaction }
    );

    if (!rows.length) {
        throw new Error('No se encontro id_tipo_nivel para MODULO en gener_tipo_nivel.');
    }

    return Number(rows[0].id_tipo_nivel);
}

async function logResumen(label, transaction) {
    const [rows] = await sequelize.query(
        `
        SELECT
          (SELECT COUNT(*) FROM general.gener_nivel WHERE id_tipo_negocio = :tipoNegocio) AS niveles_restaurante,
          (
            SELECT COUNT(*)
            FROM general.gener_rol_nivel rn
            JOIN general.gener_rol r ON r.id_rol = rn.id_rol
            WHERE r.id_tipo_negocio = :tipoNegocio
              AND rn.estado = 'A'
              AND rn.puede_ver = TRUE
          ) AS permisos_rol_activos,
          (
            SELECT COUNT(*)
            FROM general.gener_nivel_negocio nn
            JOIN general.gener_rol r ON r.id_rol = nn.id_rol
            JOIN general.gener_negocio n ON n.id_negocio = nn.id_negocio
            WHERE r.id_tipo_negocio = :tipoNegocio
              AND n.id_tipo_negocio = :tipoNegocio
              AND nn.estado = 'A'
              AND nn.puede_ver = TRUE
          ) AS permisos_negocio_activos,
          (
            SELECT COUNT(*)
            FROM general.gener_nivel_usuario nu
            JOIN general.gener_nivel nv ON nv.id_nivel = nu.id_nivel
            WHERE nv.id_tipo_negocio = :tipoNegocio
          ) AS niveles_usuario_restaurante;
        `,
        {
            transaction,
            replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
        }
    );

    console.log(label, rows[0]);
}

async function resetNivelesRestaurante() {
    const t = await sequelize.transaction();

    try {
        console.log('=== Reset niveles/permisos RESTAURANTE ===');

        await logResumen('Antes:', t);

        const moduloTipoNivelId = await getModuloTipoNivelId(t);

        const [adminRoles] = await sequelize.query(
            `
            SELECT id_rol, descripcion
            FROM general.gener_rol
            WHERE id_tipo_negocio = :tipoNegocio
              AND estado = 'A'
              AND UPPER(descripcion) LIKE '%ADMIN%'
            ORDER BY id_rol;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        if (!adminRoles.length) {
            throw new Error('No hay roles administradores activos para RESTAURANTE.');
        }

        console.log('Roles admin detectados:', adminRoles.map((r) => `${r.id_rol}:${r.descripcion}`).join(', '));

        // 1) Limpiar asignaciones de usuario para niveles restaurante actuales.
        await sequelize.query(
            `
            DELETE FROM general.gener_nivel_usuario nu
            USING general.gener_nivel nv
            WHERE nu.id_nivel = nv.id_nivel
              AND nv.id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        // 2) Limpiar permisos por rol/negocio para niveles de restaurante.
        await sequelize.query(
            `
            DELETE FROM general.gener_nivel_negocio nn
            USING general.gener_nivel nv
            WHERE nn.id_nivel = nv.id_nivel
              AND nv.id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        await sequelize.query(
            `
            DELETE FROM general.gener_rol_nivel rn
            USING general.gener_nivel nv
            WHERE rn.id_nivel = nv.id_nivel
              AND nv.id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        // 3) Reemplazar niveles de restaurante por lista corta de modulos.
        await sequelize.query(
            `
            DELETE FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        const [rootRows] = await sequelize.query(
            `
            INSERT INTO general.gener_nivel (
              descripcion,
              id_nivel_padre,
              icono,
              estado,
              id_tipo_nivel,
              id_tipo_negocio,
              url,
              fecha_creacion
            )
            VALUES (
              'RESTAURANTE',
              NULL,
              NULL,
              'A',
              :tipoNivelModulo,
              :tipoNegocio,
              '/restaurante',
              CURRENT_TIMESTAMP
            )
            RETURNING id_nivel;
            `,
            {
                transaction: t,
                replacements: {
                    tipoNegocio: RESTAURANTE_TIPO_ID,
                    tipoNivelModulo: moduloTipoNivelId,
                },
            }
        );

        const idNivelPadre = Number(rootRows[0].id_nivel);

        await sequelize.query(
            `
            INSERT INTO general.gener_nivel (
              descripcion,
              id_nivel_padre,
              icono,
              estado,
              id_tipo_nivel,
              id_tipo_negocio,
              url,
              fecha_creacion
            )
            SELECT
              x.descripcion,
              :idNivelPadre,
              NULL,
              'A',
              :tipoNivelModulo,
              :tipoNegocio,
              x.url,
              CURRENT_TIMESTAMP
            FROM (
              VALUES
                ('DASHBOARD', '/dashboard'),
                ('PEDIDOS', '/pedidos'),
                ('COCINA', '/cocina'),
                ('MENU', '/menu'),
                ('GESTION', '/gestion'),
                ('MESAS', '/mesas'),
                ('INVENTARIO', '/inventario'),
                ('PERSONAL', '/usuarios'),
                ('REPORTES', '/reportes'),
                ('CONFIGURACION', '/configuracion')
            ) AS x(descripcion, url);
            `,
            {
                transaction: t,
                replacements: {
                    idNivelPadre,
                    tipoNegocio: RESTAURANTE_TIPO_ID,
                    tipoNivelModulo: moduloTipoNivelId,
                },
            }
        );

        // 4) Limpiar cualquier matriz previa de restaurante y dejar solo admin con acceso.
        await sequelize.query(
            `
            DELETE FROM general.gener_rol_nivel rn
            USING general.gener_rol r
            WHERE rn.id_rol = r.id_rol
              AND r.id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        await sequelize.query(
            `
            DELETE FROM general.gener_nivel_negocio nn
            USING general.gener_rol r, general.gener_negocio n
            WHERE nn.id_rol = r.id_rol
              AND nn.id_negocio = n.id_negocio
              AND r.id_tipo_negocio = :tipoNegocio
              AND n.id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        await sequelize.query(
            `
            INSERT INTO general.gener_rol_nivel (
              id_rol,
              id_nivel,
              puede_ver,
              puede_crear,
              puede_editar,
              puede_eliminar,
              estado,
              fecha_creacion,
              fecha_actualizacion
            )
            SELECT
              r.id_rol,
              nv.id_nivel,
              TRUE,
              FALSE,
              FALSE,
              FALSE,
              'A',
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = :tipoNegocio
             AND nv.id_tipo_nivel = :tipoNivelModulo
             AND nv.estado = 'A'
            WHERE r.id_tipo_negocio = :tipoNegocio
              AND r.estado = 'A'
              AND UPPER(r.descripcion) LIKE '%ADMIN%'
            ON CONFLICT (id_rol, id_nivel)
            DO UPDATE SET
              puede_ver = EXCLUDED.puede_ver,
              puede_crear = FALSE,
              puede_editar = FALSE,
              puede_eliminar = FALSE,
              estado = 'A',
              fecha_actualizacion = CURRENT_TIMESTAMP;
            `,
            {
                transaction: t,
                replacements: {
                    tipoNegocio: RESTAURANTE_TIPO_ID,
                    tipoNivelModulo: moduloTipoNivelId,
                },
            }
        );

        await sequelize.query(
            `
            INSERT INTO general.gener_nivel_negocio (
              id_negocio,
              id_rol,
              id_nivel,
              puede_ver,
              estado,
              fecha_creacion,
              fecha_actualizacion
            )
            SELECT
              n.id_negocio,
              r.id_rol,
              nv.id_nivel,
              TRUE,
              'A',
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            JOIN general.gener_rol r
              ON r.id_tipo_negocio = n.id_tipo_negocio
             AND r.estado = 'A'
             AND UPPER(r.descripcion) LIKE '%ADMIN%'
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = n.id_tipo_negocio
             AND nv.id_tipo_nivel = :tipoNivelModulo
             AND nv.estado = 'A'
            WHERE n.id_tipo_negocio = :tipoNegocio
              AND n.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel)
            DO UPDATE SET
              puede_ver = EXCLUDED.puede_ver,
              estado = 'A',
              fecha_actualizacion = CURRENT_TIMESTAMP;
            `,
            {
                transaction: t,
                replacements: {
                    tipoNegocio: RESTAURANTE_TIPO_ID,
                    tipoNivelModulo: moduloTipoNivelId,
                },
            }
        );

        // 5) Rehidratar niveles efectivos por usuario para restaurante (solo desde matriz por negocio).
        await sequelize.query(
            `
            DELETE FROM general.gener_nivel_usuario nu
            USING general.gener_nivel nv
            WHERE nu.id_nivel = nv.id_nivel
              AND nv.id_tipo_negocio = :tipoNegocio;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        await sequelize.query(
            `
            INSERT INTO general.gener_nivel_usuario (id_usuario, id_nivel, fecha)
            SELECT DISTINCT
              ur.id_usuario,
              nn.id_nivel,
              CURRENT_DATE
            FROM general.gener_usuario_rol ur
            JOIN general.gener_usuario u
              ON u.id_usuario = ur.id_usuario
             AND u.estado = 'A'
            JOIN general.gener_rol r
              ON r.id_rol = ur.id_rol
             AND r.estado = 'A'
             AND r.id_tipo_negocio = :tipoNegocio
            JOIN general.gener_nivel_negocio nn
              ON nn.id_rol = ur.id_rol
             AND nn.id_negocio = ur.id_negocio
             AND nn.estado = 'A'
             AND nn.puede_ver = TRUE
            JOIN general.gener_nivel nv
              ON nv.id_nivel = nn.id_nivel
             AND nv.id_tipo_negocio = :tipoNegocio
             AND nv.estado = 'A'
            WHERE ur.estado = 'A'
              AND ur.id_negocio IS NOT NULL;
            `,
            {
                transaction: t,
                replacements: { tipoNegocio: RESTAURANTE_TIPO_ID },
            }
        );

        await logResumen('Despues:', t);

        await t.commit();
        console.log('OK: reset de niveles/permisos RESTAURANTE completado.');
    } catch (error) {
        await t.rollback();
        console.error('Error en migrate_reset_niveles_restaurante:', error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
        process.exit();
    }
}

resetNivelesRestaurante();
