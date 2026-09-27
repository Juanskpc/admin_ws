/**
 * Repara los permisos de vista que el despliegue del 2026-09-27 dejó a medias.
 *
 * ## Qué pasó
 *
 * `lib_vistas_reserva.publicarVista` siembra el ajuste por negocio de una vista nueva **solo
 * donde ya había ajustes**, porque `getPermisosVistaNegocio` (dashboardService) trata la
 * presencia de ajustes como «este negocio decide qué ve cada rol»: con un solo ajuste, lo que no
 * esté listado queda denegado. La condición existía, pero miraba el **negocio** y la resolución
 * es por **(negocio, rol)**.
 *
 * Resultado en producción: un negocio que tenía ajustes de PROFESIONAL pero ninguno de
 * ADMINISTRADOR pasó el filtro, y al ADMINISTRADOR —que hasta entonces heredaba las 16 vistas de
 * la plantilla del rol— se le sembraron solo las 5 nuevas (`/recursos`, `/mascotas`,
 * `/ocupacion`, `/estancias`, `/unidades`). Desde ese momento veía **esas cinco y nada más**: sin
 * `/dashboard` ni `/agenda`, la sesión entra directa a «Sin acceso al módulo de reservas». Le
 * pasó al administrador de D'ALEX BARBERIA.
 *
 * ## Cómo se repara
 *
 * **Borrando** esas filas, no añadiendo las que faltan. Sin ajustes, el par (negocio, rol)
 * vuelve a heredar la plantilla del rol — que ya incluye las vistas nuevas—, que es exactamente
 * el estado que tenía antes del despliegue. Añadir las 11 que faltaban dejaría al negocio con un
 * juego de ajustes propios que nadie pidió y que se quedaría congelado ante la próxima vista.
 *
 * Solo toca los pares cuyo juego de ajustes es **enteramente** de esas cinco vistas: si un
 * negocio configuró de verdad lo que ve cada rol (tiene ajustes de otras vistas, o denegaciones
 * explícitas con `puede_ver = false`), no se toca nada suyo. Las acciones (`id_tipo_nivel = 4`)
 * tampoco se tocan: su backfill sí sembró el juego completo.
 *
 * La causa está corregida en `lib_vistas_reserva.js` (la condición ahora es por rol), así que
 * esto es una reparación de datos de una sola vez. Idempotente: al segundo pase no hay nada que
 * borrar.
 *
 *   npm run migrate:reserva-reparar-vistas
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

/** Las vistas que introdujo el despliegue 2026-09-27 (perfiles y estancias). */
const VISTAS_NUEVAS = ['/recursos', '/mascotas', '/ocupacion', '/estancias', '/unidades'];

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: reparar vistas por negocio (reserva) ===\n');

        // Pares (negocio, rol) cuyo juego COMPLETO de ajustes de vista son las nuevas: antes del
        // despliegue no tenían ninguno y heredaban la plantilla del rol.
        const huerfanos = await sequelize.query(`
            SELECT nn.id_negocio, nn.id_rol, n.nombre AS negocio, r.descripcion AS rol,
                   COUNT(*) AS filas
              FROM general.gener_nivel_negocio nn
              JOIN general.gener_nivel nv ON nv.id_nivel = nn.id_nivel AND nv.id_tipo_nivel = 1
              JOIN general.gener_negocio n ON n.id_negocio = nn.id_negocio
              JOIN general.gener_rol r     ON r.id_rol = nn.id_rol
             WHERE nn.estado = 'A'
             GROUP BY nn.id_negocio, nn.id_rol, n.nombre, r.descripcion
            HAVING bool_and(nv.url = ANY(:nuevas));
        `, { replacements: { nuevas: VISTAS_NUEVAS }, type: sequelize.QueryTypes.SELECT, transaction: t });

        if (huerfanos.length === 0) {
            console.log('   Nada que reparar.\n');
        } else {
            for (const h of huerfanos) {
                console.log(`   #${h.id_negocio} «${h.negocio}» · ${h.rol}: ${h.filas} ajuste(s) sueltos → se quitan (vuelve a heredar la plantilla del rol)`);
            }

            const pares = huerfanos.map(h => `(${Number(h.id_negocio)},${Number(h.id_rol)})`).join(',');
            const [, meta] = await sequelize.query(`
                DELETE FROM general.gener_nivel_negocio nn
                 USING general.gener_nivel nv
                 WHERE nv.id_nivel = nn.id_nivel
                   AND nv.id_tipo_nivel = 1
                   AND (nn.id_negocio, nn.id_rol) IN (${pares});
            `, { transaction: t });
            console.log(`\n   OK — ${meta?.rowCount ?? 0} fila(s) eliminadas\n`);
        }

        await t.commit();

        // Verificación tras el commit: ningún par debe quedar con menos vistas de las que su
        // plantilla concede, salvo que tenga denegaciones explícitas (configuración real).
        const pendientes = await sequelize.query(`
            SELECT n.nombre AS negocio, r.descripcion AS rol,
                   COUNT(*) FILTER (WHERE nn.puede_ver) AS ve
              FROM general.gener_nivel_negocio nn
              JOIN general.gener_nivel nv ON nv.id_nivel = nn.id_nivel AND nv.id_tipo_nivel = 1
              JOIN general.gener_negocio n ON n.id_negocio = nn.id_negocio
              JOIN general.gener_rol r     ON r.id_rol = nn.id_rol
             WHERE nn.estado = 'A' AND r.id_tipo_negocio = (
                     SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA')
             GROUP BY n.nombre, r.descripcion
            HAVING COUNT(*) FILTER (WHERE nn.puede_ver) = 0
                OR bool_and(nv.url = ANY(:nuevas));
        `, { replacements: { nuevas: VISTAS_NUEVAS }, type: sequelize.QueryTypes.SELECT });

        console.log('=== Resultado ===');
        if (pendientes.length === 0) console.log('   Sin pares de (negocio, rol) truncados.');
        else pendientes.forEach(p => console.log(`   ⚠️  ${p.negocio} · ${p.rol}: ${p.ve} vista(s)`));
        console.log('\nMigración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
