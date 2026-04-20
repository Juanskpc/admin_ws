/**
 * Agrega subniveles de permiso para restaurante y los parametriza por rol/negocio.
 *
 * Uso:
 *   node migrations/migrate_restaurante_subniveles_permisos.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

const SUBNIVELES = [
  { moduloUrl: '/pedidos', descripcion: 'PEDIDOS - PARA LLEVAR', codigo: 'pedidos_para_llevar' },
  { moduloUrl: '/pedidos', descripcion: 'PEDIDOS - COBRAR', codigo: 'pedidos_cobrar' },
  { moduloUrl: '/pedidos', descripcion: 'PEDIDOS - IMPRIMIR', codigo: 'pedidos_imprimir' },
  { moduloUrl: '/pedidos', descripcion: 'PEDIDOS - ENVIAR A COCINA', codigo: 'pedidos_enviar_cocina' },
  { moduloUrl: '/mesas', descripcion: 'MESAS - NUEVA MESA', codigo: 'mesas_nueva_mesa' },
  { moduloUrl: '/mesas', descripcion: 'MESAS - ACCIONES DEL PEDIDO', codigo: 'mesas_acciones_pedido' },
  { moduloUrl: '/mesas', descripcion: 'MESAS - ADMINISTRACION DE MESA', codigo: 'mesas_administracion' },
  { moduloUrl: '/inventario', descripcion: 'INVENTARIO - AGREGAR NUEVO INSUMO', codigo: 'inventario_agregar_insumo' },
  { moduloUrl: '/inventario', descripcion: 'INVENTARIO - AJUSTE RAPIDO', codigo: 'inventario_ajuste_rapido' },
];

async function getRestauranteTipoId(transaction) {
  const [rows] = await sequelize.query(
    `
      SELECT id_tipo_negocio
      FROM general.gener_tipo_negocio
      WHERE estado = 'A'
        AND UPPER(nombre) LIKE '%RESTAURANTE%'
      ORDER BY id_tipo_negocio
      LIMIT 1;
    `,
    { transaction }
  );

  if (!rows.length) {
    throw new Error('No se encontro tipo de negocio RESTAURANTE en general.gener_tipo_negocio.');
  }

  return Number(rows[0].id_tipo_negocio);
}

async function getAccionTipoNivelId(transaction) {
  const [rows] = await sequelize.query(
    `
      SELECT id_tipo_nivel
      FROM general.gener_tipo_nivel
      WHERE estado = 'A'
        AND UPPER(nombre) = 'ACCION'
      ORDER BY id_tipo_nivel
      LIMIT 1;
    `,
    { transaction }
  );

  if (!rows.length) {
    throw new Error('No se encontro id_tipo_nivel ACCION en general.gener_tipo_nivel.');
  }

  return Number(rows[0].id_tipo_nivel);
}

async function insertSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction }) {
  for (const item of SUBNIVELES) {
    const [parentRows] = await sequelize.query(
      `
        SELECT id_nivel
        FROM general.gener_nivel
        WHERE estado = 'A'
          AND id_tipo_negocio = :idTipoNegocio
          AND id_tipo_nivel = 1
          AND url = :moduloUrl
        ORDER BY id_nivel
        LIMIT 1;
      `,
      {
        transaction,
        replacements: {
          idTipoNegocio,
          moduloUrl: item.moduloUrl,
        },
      }
    );

    if (!parentRows.length) {
      console.warn(`[migrate_subniveles] No se encontro modulo padre ${item.moduloUrl}. Se omite ${item.codigo}.`);
      continue;
    }

    const idNivelPadre = Number(parentRows[0].id_nivel);

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
        transaction,
        replacements: {
          descripcion: item.descripcion,
          idNivelPadre,
          idTipoNivelAccion,
          idTipoNegocio,
          codigo: item.codigo,
        },
      }
    );
  }
}

async function seedRolNivelSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction }) {
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
          WHEN nv.url = 'pedidos_cobrar' AND UPPER(r.descripcion) LIKE '%MESERO%' THEN FALSE
          ELSE COALESCE(rn_mod.puede_ver, FALSE)
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
      LEFT JOIN general.gener_rol_nivel rn_mod
        ON rn_mod.id_rol = r.id_rol
       AND rn_mod.id_nivel = nv.id_nivel_padre
       AND rn_mod.estado = 'A'
      WHERE r.id_tipo_negocio = :idTipoNegocio
        AND r.estado = 'A'
      ON CONFLICT (id_rol, id_nivel)
      DO NOTHING;
    `,
    {
      transaction,
      replacements: {
        idTipoNegocio,
        idTipoNivelAccion,
      },
    }
  );
}

async function seedNivelNegocioSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction }) {
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
          WHEN nv.url = 'pedidos_cobrar' AND UPPER(r.descripcion) LIKE '%MESERO%' THEN FALSE
          ELSE COALESCE(nn_mod.puede_ver, rn_mod.puede_ver, FALSE)
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
      LEFT JOIN general.gener_nivel_negocio nn_mod
        ON nn_mod.id_negocio = n.id_negocio
       AND nn_mod.id_rol = r.id_rol
       AND nn_mod.id_nivel = nv.id_nivel_padre
       AND nn_mod.estado = 'A'
      LEFT JOIN general.gener_rol_nivel rn_mod
        ON rn_mod.id_rol = r.id_rol
       AND rn_mod.id_nivel = nv.id_nivel_padre
       AND rn_mod.estado = 'A'
      WHERE n.estado = 'A'
        AND n.id_tipo_negocio = :idTipoNegocio
      ON CONFLICT (id_negocio, id_rol, id_nivel)
      DO NOTHING;
    `,
    {
      transaction,
      replacements: {
        idTipoNegocio,
        idTipoNivelAccion,
      },
    }
  );
}

async function run() {
  const t = await sequelize.transaction();

  try {
    console.log('=== Migracion subniveles de permisos (restaurante) ===');

    const idTipoNegocio = await getRestauranteTipoId(t);
    const idTipoNivelAccion = await getAccionTipoNivelId(t);

    await insertSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction: t });
    await seedRolNivelSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction: t });
    await seedNivelNegocioSubniveles({ idTipoNegocio, idTipoNivelAccion, transaction: t });

    await t.commit();
    console.log('OK: subniveles creados y permisos iniciales sembrados.');
  } catch (error) {
    await t.rollback();
    console.error('Error en migrate_restaurante_subniveles_permisos:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
    process.exit();
  }
}

run();
