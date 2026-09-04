/**
 * Migración: subniveles de permiso para los tipos de pedido "En mesa" y "Domicilios".
 *
 * Hoy los tres botones del POS (En mesa / Para llevar / Domicilio) son fijos: solo
 * "Para llevar" tiene subnivel (pedidos_para_llevar). Esta migración crea los dos
 * que faltan para que un negocio que solo vende para llevar pueda apagar el resto:
 *
 *   - pedidos_en_mesa    → botón "En mesa" del POS + módulo Mesas en el menú.
 *   - pedidos_domicilio  → botón "Domicilio" del POS + filtro Domicilio en Despacho
 *                          + panel de domiciliarios en Caja.
 *
 * REGLA DE COMPATIBILIDAD: ambos se siembran en TRUE para todos los roles y todos
 * los negocios existentes. Quien ya opera hoy no percibe ningún cambio; el negocio
 * nuevo los desmarca desde Usuarios → Roles y permisos.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-subniveles-tipo-pedido
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const SUBNIVELES = [
    { moduloUrl: '/pedidos', descripcion: 'PEDIDOS - EN MESA',   codigo: 'pedidos_en_mesa' },
    { moduloUrl: '/pedidos', descripcion: 'PEDIDOS - DOMICILIOS', codigo: 'pedidos_domicilio' },
];

async function getRestauranteTipoId(transaction) {
    const [rows] = await sequelize.query(`
        SELECT id_tipo_negocio
        FROM general.gener_tipo_negocio
        WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
        ORDER BY id_tipo_negocio
        LIMIT 1;
    `, { transaction });

    if (!rows.length) {
        throw new Error('No se encontro tipo de negocio RESTAURANTE en general.gener_tipo_negocio.');
    }
    return Number(rows[0].id_tipo_negocio);
}

async function getAccionTipoNivelId(transaction) {
    const [rows] = await sequelize.query(`
        SELECT id_tipo_nivel
        FROM general.gener_tipo_nivel
        WHERE estado = 'A' AND UPPER(nombre) = 'ACCION'
        ORDER BY id_tipo_nivel
        LIMIT 1;
    `, { transaction });

    if (!rows.length) {
        throw new Error('No se encontro id_tipo_nivel ACCION en general.gener_tipo_nivel.');
    }
    return Number(rows[0].id_tipo_nivel);
}

async function insertSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction }) {
    const creados = [];

    for (const item of SUBNIVELES) {
        const [parentRows] = await sequelize.query(`
            SELECT id_nivel
            FROM general.gener_nivel
            WHERE estado = 'A'
              AND id_tipo_negocio = :idTipoNegocio
              AND id_tipo_nivel = 1
              AND url = :moduloUrl
            ORDER BY id_nivel
            LIMIT 1;
        `, { transaction, replacements: { idTipoNegocio, moduloUrl: item.moduloUrl } });

        if (!parentRows.length) {
            console.warn(`   ! No se encontro modulo padre ${item.moduloUrl}. Se omite ${item.codigo}.`);
            continue;
        }

        const idNivelPadre = Number(parentRows[0].id_nivel);

        await sequelize.query(`
            INSERT INTO general.gener_nivel (
                descripcion, id_nivel_padre, icono, estado,
                id_tipo_nivel, id_tipo_negocio, url, fecha_creacion
            )
            SELECT :descripcion, :idNivelPadre, NULL, 'A',
                   :idTipoNivelAccion, :idTipoNegocio, :codigo, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel nv
                WHERE nv.id_tipo_negocio = :idTipoNegocio
                  AND nv.id_nivel_padre = :idNivelPadre
                  AND nv.id_tipo_nivel = :idTipoNivelAccion
                  AND nv.url = :codigo
            );
        `, {
            transaction,
            replacements: {
                descripcion: item.descripcion,
                idNivelPadre,
                idTipoNivelAccion,
                idTipoNegocio,
                codigo: item.codigo,
            },
        });

        creados.push(item.codigo);
    }

    return creados;
}

/**
 * Permiso global por rol. TRUE para todos: preserva el comportamiento actual,
 * donde los tres tipos de pedido son visibles para cualquiera que entre al POS.
 */
async function seedRolNivel({ idTipoNegocio, idTipoNivelAccion, codigos, transaction }) {
    if (!codigos.length) return;

    await sequelize.query(`
        INSERT INTO general.gener_rol_nivel (
            id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar,
            estado, fecha_creacion, fecha_actualizacion
        )
        SELECT r.id_rol, nv.id_nivel, TRUE, FALSE, FALSE, FALSE,
               'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM general.gener_rol r
        JOIN general.gener_nivel nv
          ON nv.id_tipo_negocio = :idTipoNegocio
         AND nv.id_tipo_nivel = :idTipoNivelAccion
         AND nv.estado = 'A'
         AND nv.url IN (:codigos)
        WHERE r.id_tipo_negocio = :idTipoNegocio
          AND r.estado = 'A'
        ON CONFLICT (id_rol, id_nivel) DO NOTHING;
    `, { transaction, replacements: { idTipoNegocio, idTipoNivelAccion, codigos } });
}

/** Permiso por negocio (el que edita "Roles y permisos"). También TRUE de entrada. */
async function seedNivelNegocio({ idTipoNegocio, idTipoNivelAccion, codigos, transaction }) {
    if (!codigos.length) return;

    await sequelize.query(`
        INSERT INTO general.gener_nivel_negocio (
            id_negocio, id_rol, id_nivel, puede_ver,
            estado, fecha_creacion, fecha_actualizacion
        )
        SELECT n.id_negocio, r.id_rol, nv.id_nivel, TRUE,
               'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM general.gener_negocio n
        JOIN general.gener_rol r
          ON r.estado = 'A'
         AND r.id_tipo_negocio = n.id_tipo_negocio
        JOIN general.gener_nivel nv
          ON nv.id_tipo_negocio = n.id_tipo_negocio
         AND nv.id_tipo_nivel = :idTipoNivelAccion
         AND nv.estado = 'A'
         AND nv.url IN (:codigos)
        WHERE n.estado = 'A'
          AND n.id_tipo_negocio = :idTipoNegocio
        ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
    `, { transaction, replacements: { idTipoNegocio, idTipoNivelAccion, codigos } });
}

async function run() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Subniveles de tipo de pedido\n');

        const idTipoNegocio = await getRestauranteTipoId(t);
        const idTipoNivelAccion = await getAccionTipoNivelId(t);

        console.log('1. Creando subniveles pedidos_en_mesa / pedidos_domicilio...');
        const codigos = await insertSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction: t });
        console.log(`   ✓ subniveles asegurados: ${codigos.join(', ') || '(ninguno)'}`);

        console.log('2. Sembrando permisos por rol (TRUE)...');
        await seedRolNivel({ idTipoNegocio, idTipoNivelAccion, codigos, transaction: t });

        console.log('3. Sembrando permisos por negocio (TRUE)...');
        await seedNivelNegocio({ idTipoNegocio, idTipoNivelAccion, codigos, transaction: t });

        await t.commit();
        console.log('\n✓ Listo. Todos los roles conservan En mesa y Domicilios activos.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

run();
