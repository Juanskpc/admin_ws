/**
 * Publica una vista del módulo RESERVA en el catálogo de permisos. **No es una migración**: lo
 * usan `migrate_reserva_perfiles.js` y `migrate_reserva_estancias.js`, que crean vistas nuevas
 * (Recursos, Mascotas, Estancias, Ocupación, Unidades) con la misma receta que ya siguió
 * `/clientes` en `migrate_reserva_clientes.js`:
 *
 * 1. La fila de `gener_nivel` (tipo 1) colgando del raíz `/reserva`.
 * 2. La plantilla por rol (`gener_rol_nivel`).
 * 3. El ajuste por negocio (`gener_nivel_negocio`) **solo en los pares (negocio, rol) que ya
 *    tienen ajustes**. Esa condición importa: `getPermisosVistaNegocio` trata la presencia de
 *    ajustes como «este negocio decide qué ve cada rol», así que sembrar una fila donde no había
 *    ninguna le haría perder todas las demás vistas. La receta de `/clientes` no la tenía porque
 *    en ese momento todos los negocios tenían ajustes; aquí se pone por escrito.
 *
 *    **Por rol, no por negocio** (2026-09-27): la condición miraba solo el negocio, y la
 *    resolución de permisos es por (negocio, rol). Un negocio con ajustes de PROFESIONAL y
 *    ninguno de ADMINISTRADOR pasaba el filtro, se le sembraban las vistas nuevas al
 *    ADMINISTRADOR —que hasta entonces heredaba las 16 de la plantilla— y se quedaba viendo
 *    solo esas. Le pasó a D'ALEX BARBERIA al desplegar perfiles y estancias: su administrador
 *    entró a «Sin acceso al módulo de reservas». Lo repara
 *    `migrate_reserva_reparar_vistas_negocio.js`.
 *
 * Que la vista exista para todo el módulo no significa que todos la vean: el perfil del rubro
 * la quita de la sesión si su función no está activa (`app_reserva_api/perfiles`).
 *
 * Idempotente.
 */
'use strict';

async function idTipoReserva(sequelize, t) {
    const [tipo] = await sequelize.query(
        `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';`,
        { type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    if (!tipo) throw new Error('No existe el tipo de negocio RESERVA. Ejecuta antes: npm run migrate:reserva');
    return tipo.id_tipo_negocio;
}

/**
 * @param {object} v
 * @param {string} v.url           Ruta de la vista (`/recursos`).
 * @param {string} v.descripcion   Nombre en mayúsculas, como el resto del catálogo.
 * @param {string} v.icono         Icono lucide.
 * @param {Object<string,{crear?:boolean,editar?:boolean,eliminar?:boolean}>} v.roles
 *        Roles que la ven y con qué banderas. Un rol ausente no la ve.
 */
async function publicarVista(sequelize, t, { url, descripcion, icono, roles }) {
    const idTipo = await idTipoReserva(sequelize, t);

    const [root] = await sequelize.query(
        `SELECT id_nivel FROM general.gener_nivel
          WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva';`,
        { replacements: { tipo: idTipo }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    if (!root) throw new Error('No existe el nivel raíz /reserva. Ejecuta antes: npm run migrate:reserva');

    await sequelize.query(
        `INSERT INTO general.gener_nivel
             (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
         SELECT :descripcion, :padre, :icono, 'A', 1, :url, :tipo
          WHERE NOT EXISTS (
              SELECT 1 FROM general.gener_nivel
               WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
          );`,
        { replacements: { descripcion, padre: root.id_nivel, icono, url, tipo: idTipo }, transaction: t },
    );

    for (const [rol, banderas] of Object.entries(roles)) {
        await sequelize.query(
            `INSERT INTO general.gener_rol_nivel
                 (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
             SELECT r.id_rol, n.id_nivel, true, :crear, :editar, :eliminar, 'A'
               FROM general.gener_rol r
               JOIN general.gener_nivel n
                 ON n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = 1 AND n.url = :url
              WHERE r.id_tipo_negocio = :tipo AND r.estado = 'A' AND r.descripcion = :rol
             ON CONFLICT (id_rol, id_nivel) DO NOTHING;`,
            {
                replacements: {
                    tipo: idTipo, url, rol,
                    crear: !!banderas.crear, editar: !!banderas.editar, eliminar: !!banderas.eliminar,
                },
                transaction: t,
            },
        );
    }

    const [, meta] = await sequelize.query(
        `INSERT INTO general.gener_nivel_negocio
             (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
         SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM general.gener_negocio neg
           JOIN general.gener_nivel niv
             ON niv.id_tipo_negocio = :tipo AND niv.id_tipo_nivel = 1 AND niv.url = :url
           JOIN general.gener_rol_nivel rn ON rn.id_nivel = niv.id_nivel AND rn.estado = 'A'
          WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            AND EXISTS (
                SELECT 1 FROM general.gener_nivel_negocio x
                 WHERE x.id_negocio = neg.id_negocio AND x.id_rol = rn.id_rol AND x.estado = 'A'
            )
         ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;`,
        { replacements: { tipo: idTipo, url }, transaction: t },
    );
    return { ajustes: meta?.rowCount ?? 0 };
}

/** Crea el trigger de auditoría si `auditoria.fn_audit` existe; si no, avisa y sigue. */
async function auditar(sequelize, t, esquemaTabla, pk, sensibles = null) {
    const [[fn]] = await sequelize.query(
        `SELECT 1 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';`,
        { transaction: t },
    );
    if (!fn) {
        console.log(`   ⚠️  auditoria.fn_audit no existe — ${esquemaTabla} queda sin trigger.`);
        return false;
    }
    const args = sensibles ? `'${pk}', '${sensibles}'` : `'${pk}'`;
    await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON ${esquemaTabla};`, { transaction: t });
    await sequelize.query(
        `CREATE TRIGGER trg_audit
             AFTER INSERT OR UPDATE OR DELETE ON ${esquemaTabla}
             FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit(${args});`,
        { transaction: t },
    );
    return true;
}

/** ¿Existe la columna? Guarda de toda ALTER, como pide la convención de migraciones. */
async function existeColumna(sequelize, t, esquema, tabla, columna) {
    const filas = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;`,
        { replacements: { esquema, tabla, columna }, type: sequelize.QueryTypes.SELECT, transaction: t },
    );
    return filas.length > 0;
}

/** Añade una columna si no existe. `definicion` es el tipo y sus restricciones. */
async function asegurarColumna(sequelize, t, esquema, tabla, columna, definicion) {
    if (await existeColumna(sequelize, t, esquema, tabla, columna)) {
        console.log(`   · ${tabla}.${columna} ya existe`);
        return false;
    }
    await sequelize.query(`ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${definicion};`, { transaction: t });
    console.log(`   + ${tabla}.${columna}`);
    return true;
}

module.exports = { idTipoReserva, publicarVista, auditar, existeColumna, asegurarColumna };
