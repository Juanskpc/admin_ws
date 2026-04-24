/**
 * Agrega el subnivel 'inventario_gestionar_insumo' (editar / eliminar insumos).
 *
 * Idempotente. npm run migrate:restaurante-inventario-gestionar
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const SUBNIVEL = {
    moduloUrl: '/inventario',
    descripcion: 'INVENTARIO - GESTIONAR INSUMO',
    codigo: 'inventario_gestionar_insumo',
};

async function getRestauranteTipoId(t) {
    const [rows] = await sequelize.query(
        `SELECT id_tipo_negocio
         FROM general.gener_tipo_negocio
         WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
         ORDER BY id_tipo_negocio LIMIT 1;`,
        { transaction: t }
    );
    if (!rows.length) throw new Error('No se encontró tipo de negocio RESTAURANTE.');
    return Number(rows[0].id_tipo_negocio);
}

async function getAccionTipoNivelId(t) {
    const [rows] = await sequelize.query(
        `SELECT id_tipo_nivel
         FROM general.gener_tipo_nivel
         WHERE estado = 'A' AND UPPER(nombre) = 'ACCION'
         ORDER BY id_tipo_nivel LIMIT 1;`,
        { transaction: t }
    );
    if (!rows.length) throw new Error('No se encontró id_tipo_nivel ACCION.');
    return Number(rows[0].id_tipo_nivel);
}

async function run() {
    const t = await sequelize.transaction();
    try {
        console.log('=== Migración: inventario_gestionar_insumo ===');

        const idTipoNegocio = await getRestauranteTipoId(t);
        const idTipoNivelAccion = await getAccionTipoNivelId(t);

        // 1. Buscar nivel padre (/inventario)
        const [padreRows] = await sequelize.query(
            `SELECT id_nivel FROM general.gener_nivel
             WHERE estado = 'A'
               AND id_tipo_negocio = :idTipoNegocio
               AND id_tipo_nivel = 1
               AND url = :moduloUrl
             ORDER BY id_nivel LIMIT 1;`,
            { transaction: t, replacements: { idTipoNegocio, moduloUrl: SUBNIVEL.moduloUrl } }
        );
        if (!padreRows.length) throw new Error(`No se encontró módulo padre ${SUBNIVEL.moduloUrl}.`);
        const idNivelPadre = Number(padreRows[0].id_nivel);

        // 2. Insertar subnivel (idempotente)
        await sequelize.query(
            `INSERT INTO general.gener_nivel
               (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
             SELECT :descripcion, :idNivelPadre, NULL, 'A', :idTipoNivelAccion, :idTipoNegocio, :codigo, CURRENT_TIMESTAMP
             WHERE NOT EXISTS (
               SELECT 1 FROM general.gener_nivel
               WHERE id_tipo_negocio = :idTipoNegocio
                 AND id_nivel_padre  = :idNivelPadre
                 AND id_tipo_nivel   = :idTipoNivelAccion
                 AND url             = :codigo
             );`,
            {
                transaction: t,
                replacements: {
                    descripcion: SUBNIVEL.descripcion,
                    idNivelPadre,
                    idTipoNivelAccion,
                    idTipoNegocio,
                    codigo: SUBNIVEL.codigo,
                },
            }
        );
        console.log(`  ✔ nivel insertado (o ya existía): ${SUBNIVEL.codigo}`);

        // 3. Obtener id_nivel recién creado (o existente)
        const [nivelRows] = await sequelize.query(
            `SELECT id_nivel FROM general.gener_nivel
             WHERE estado = 'A'
               AND id_tipo_negocio = :idTipoNegocio
               AND id_nivel_padre  = :idNivelPadre
               AND id_tipo_nivel   = :idTipoNivelAccion
               AND url             = :codigo
             LIMIT 1;`,
            {
                transaction: t,
                replacements: { idTipoNegocio, idNivelPadre, idTipoNivelAccion, codigo: SUBNIVEL.codigo },
            }
        );
        const idNivel = Number(nivelRows[0].id_nivel);

        // 4. Sembrar general.gener_rol_nivel (por rol, heredando visibilidad del padre)
        await sequelize.query(
            `INSERT INTO general.gener_rol_nivel
               (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado, fecha_creacion, fecha_actualizacion)
             SELECT
               r.id_rol,
               :idNivel,
               CASE WHEN UPPER(r.descripcion) LIKE '%ADMIN%' THEN TRUE
                    ELSE COALESCE(rn_padre.puede_ver, FALSE) END,
               FALSE, FALSE, FALSE,
               'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             FROM general.gener_rol r
             LEFT JOIN general.gener_rol_nivel rn_padre
               ON rn_padre.id_rol   = r.id_rol
              AND rn_padre.id_nivel = :idNivelPadre
              AND rn_padre.estado   = 'A'
             WHERE r.id_tipo_negocio = :idTipoNegocio
               AND r.estado = 'A'
             ON CONFLICT (id_rol, id_nivel) DO NOTHING;`,
            { transaction: t, replacements: { idNivel, idNivelPadre, idTipoNegocio } }
        );
        console.log('  ✔ general.gener_rol_nivel sembrado');

        // 5. Sembrar general.gener_nivel_negocio (por negocio/rol, heredando visibilidad del padre)
        await sequelize.query(
            `INSERT INTO general.gener_nivel_negocio
               (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
             SELECT
               n.id_negocio,
               r.id_rol,
               :idNivel,
               CASE WHEN UPPER(r.descripcion) LIKE '%ADMIN%' THEN TRUE
                    ELSE COALESCE(nn_padre.puede_ver, rn_padre.puede_ver, FALSE) END,
               'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             FROM general.gener_negocio n
             JOIN general.gener_rol r
               ON r.estado = 'A' AND r.id_tipo_negocio = n.id_tipo_negocio
             LEFT JOIN general.gener_nivel_negocio nn_padre
               ON nn_padre.id_negocio = n.id_negocio
              AND nn_padre.id_rol     = r.id_rol
              AND nn_padre.id_nivel   = :idNivelPadre
              AND nn_padre.estado     = 'A'
             LEFT JOIN general.gener_rol_nivel rn_padre
               ON rn_padre.id_rol   = r.id_rol
              AND rn_padre.id_nivel = :idNivelPadre
              AND rn_padre.estado   = 'A'
             WHERE n.estado = 'A'
               AND n.id_tipo_negocio = :idTipoNegocio
             ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;`,
            { transaction: t, replacements: { idNivel, idNivelPadre, idTipoNegocio } }
        );
        console.log('  ✔ general.gener_nivel_negocio sembrado');

        await t.commit();
        console.log('OK: migración completada.');
    } catch (err) {
        await t.rollback();
        console.error('Error:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
        process.exit();
    }
}

run();
