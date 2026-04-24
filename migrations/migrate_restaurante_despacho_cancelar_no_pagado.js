/**
 * Migración: subnivel de seguridad para cancelar pedidos pendientes de pago.
 *
 * Crea el subnivel `despacho_cancelar_no_pagado` bajo `/despacho`
 * y siembra permisos por rol/negocio con default solo para administradores.
 *
 * Idempotente. npm run migrate:restaurante-despacho-cancelar-no-pagado
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

const CODIGO_SUBNIVEL = 'despacho_cancelar_no_pagado';
const DESCRIPCION_SUBNIVEL = 'DESPACHO - CANCELAR NO PAGADO';

async function getTipoNegocioRestaurante(transaction) {
    const [rows] = await sequelize.query(
        `
        SELECT id_tipo_negocio
        FROM general.gener_tipo_negocio
        WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
        ORDER BY id_tipo_negocio
        LIMIT 1;
        `,
        { transaction },
    );

    if (!rows.length) {
        throw new Error('No se encontró tipo de negocio RESTAURANTE.');
    }

    return Number(rows[0].id_tipo_negocio);
}

async function getTipoNivelAccion(transaction) {
    const [rows] = await sequelize.query(
        `
        SELECT id_tipo_nivel
        FROM general.gener_tipo_nivel
        WHERE estado = 'A' AND UPPER(nombre) = 'ACCION'
        ORDER BY id_tipo_nivel
        LIMIT 1;
        `,
        { transaction },
    );

    if (!rows.length) {
        throw new Error('No se encontró tipo de nivel ACCION.');
    }

    return Number(rows[0].id_tipo_nivel);
}

async function getNivelDespacho({ idTipoNegocio, transaction }) {
    const [rows] = await sequelize.query(
        `
        SELECT id_nivel
        FROM general.gener_nivel
        WHERE estado = 'A'
          AND id_tipo_negocio = :idTipoNegocio
          AND id_tipo_nivel = 1
          AND url = '/despacho'
        ORDER BY id_nivel
        LIMIT 1;
        `,
        {
            transaction,
            replacements: { idTipoNegocio },
        },
    );

    return rows.length ? Number(rows[0].id_nivel) : null;
}

async function run() {
    const t = await sequelize.transaction();

    try {
        console.log('=== Migración subnivel despacho_cancelar_no_pagado ===');

        const idTipoNegocio = await getTipoNegocioRestaurante(t);
        const idTipoNivelAccion = await getTipoNivelAccion(t);
        const idNivelDespacho = await getNivelDespacho({ idTipoNegocio, transaction: t });

        if (!idNivelDespacho) {
            throw new Error('No se encontró el módulo /despacho. Ejecuta primero la migración de domicilio/despacho.');
        }

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
                :descripcion,
                :idNivelPadre,
                NULL,
                'A',
                :idTipoNivelAccion,
                :idTipoNegocio,
                :codigo,
                CURRENT_TIMESTAMP
            WHERE NOT EXISTS (
                SELECT 1
                FROM general.gener_nivel nv
                WHERE nv.id_tipo_negocio = :idTipoNegocio
                  AND nv.id_nivel_padre = :idNivelPadre
                  AND nv.id_tipo_nivel = :idTipoNivelAccion
                  AND nv.url = :codigo
            );
            `,
            {
                transaction: t,
                replacements: {
                    descripcion: DESCRIPCION_SUBNIVEL,
                    idNivelPadre: idNivelDespacho,
                    idTipoNivelAccion,
                    idTipoNegocio,
                    codigo: CODIGO_SUBNIVEL,
                },
            },
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
                CASE
                  WHEN UPPER(r.descripcion) LIKE '%ADMIN%' THEN TRUE
                  ELSE FALSE
                END AS puede_ver,
                FALSE,
                FALSE,
                FALSE,
                'A',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = :idTipoNegocio
             AND nv.id_tipo_nivel = :idTipoNivelAccion
             AND nv.estado = 'A'
             AND nv.url = :codigo
            WHERE r.id_tipo_negocio = :idTipoNegocio
              AND r.estado = 'A'
            ON CONFLICT (id_rol, id_nivel)
            DO NOTHING;
            `,
            {
                transaction: t,
                replacements: {
                    idTipoNegocio,
                    idTipoNivelAccion,
                    codigo: CODIGO_SUBNIVEL,
                },
            },
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
                CASE
                  WHEN UPPER(r.descripcion) LIKE '%ADMIN%' THEN TRUE
                  ELSE FALSE
                END AS puede_ver,
                'A',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
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
            ON CONFLICT (id_negocio, id_rol, id_nivel)
            DO NOTHING;
            `,
            {
                transaction: t,
                replacements: {
                    idTipoNegocio,
                    idTipoNivelAccion,
                    codigo: CODIGO_SUBNIVEL,
                },
            },
        );

        await t.commit();
        console.log('OK: subnivel despacho_cancelar_no_pagado creado y sembrado.');
    } catch (error) {
        await t.rollback();
        console.error('Error en migrate_restaurante_despacho_cancelar_no_pagado:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

run();
