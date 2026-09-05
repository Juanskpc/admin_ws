/**
 * Migración: subnivel `caja_ver_ingresos` bajo el módulo /caja.
 *
 * Gobierna si un rol ve el DINERO en Caja (ingresos, egresos, esperado, desglose
 * por forma de pago, monto de cada movimiento). Sin él, el módulo sigue abriéndose
 * y los movimientos se siguen listando —fecha, tipo, concepto, usuario— pero sin
 * cifras: sirve para que un cajero opere y cuente a ciegas sin ver el acumulado
 * del turno.
 *
 * ⚠ Se siembra en TRUE para TODOS los roles y negocios existentes, porque hoy ese
 * dinero lo ve cualquiera que entre a Caja: en la sesión "ausente" es
 * indistinguible de "denegado" (`getPermisosSubnivelNegocio` solo devuelve filas
 * con puede_ver = true), así que sembrar en false apagaría la función de golpe a
 * los clientes que ya operan. Quien quiera restringirlo lo apaga a mano en
 * Usuarios → Roles y permisos.
 *
 * Por el mismo motivo esta migración tiene que correr ANTES de desplegar el
 * frontend que la consume.
 *
 * Idempotente. npm run migrate:restaurante-caja-ver-ingresos
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

const CODIGO_SUBNIVEL = 'caja_ver_ingresos';
const DESCRIPCION_SUBNIVEL = 'CAJA - VER INGRESOS';

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

async function getNivelCaja({ idTipoNegocio, transaction }) {
    const [rows] = await sequelize.query(
        `
        SELECT id_nivel
        FROM general.gener_nivel
        WHERE estado = 'A'
          AND id_tipo_negocio = :idTipoNegocio
          AND id_tipo_nivel = 1
          AND url = '/caja'
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
        console.log('=== Migración subnivel caja_ver_ingresos ===');

        const idTipoNegocio = await getTipoNegocioRestaurante(t);
        const idTipoNivelAccion = await getTipoNivelAccion(t);
        const idNivelCaja = await getNivelCaja({ idTipoNegocio, transaction: t });

        if (!idNivelCaja) {
            throw new Error('No se encontró el módulo /caja. Ejecuta primero migrate:restaurante-caja.');
        }

        console.log('1. Creando el subnivel...');
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
                    idNivelPadre: idNivelCaja,
                    idTipoNivelAccion,
                    idTipoNegocio,
                    codigo: CODIGO_SUBNIVEL,
                },
            },
        );

        console.log('2. Sembrando la matriz global de roles (puede_ver = TRUE)...');
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

        console.log('3. Sembrando el override por negocio (puede_ver = TRUE)...');
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

        const [[conteo]] = await sequelize.query(
            `
            SELECT
                (SELECT COUNT(*) FROM general.gener_rol_nivel rn
                   JOIN general.gener_nivel nv ON nv.id_nivel = rn.id_nivel
                  WHERE nv.url = :codigo AND nv.id_tipo_nivel = :idTipoNivelAccion) AS roles,
                (SELECT COUNT(*) FROM general.gener_nivel_negocio nn
                   JOIN general.gener_nivel nv ON nv.id_nivel = nn.id_nivel
                  WHERE nv.url = :codigo AND nv.id_tipo_nivel = :idTipoNivelAccion) AS negocios;
            `,
            {
                transaction: t,
                replacements: { codigo: CODIGO_SUBNIVEL, idTipoNivelAccion },
            },
        );

        await t.commit();
        console.log(
            `OK: subnivel ${CODIGO_SUBNIVEL} creado. ` +
            `${conteo.roles} filas de rol, ${conteo.negocios} de negocio.`
        );
    } catch (error) {
        await t.rollback();
        console.error('Error en migrate_restaurante_caja_ver_ingresos:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

run();
