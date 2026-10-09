/**
 * Conversaciones del asistente en `negocio_app` — permisos (2026-10-08).
 *
 *   node scripts/migrar.js restaurante-conversaciones
 *
 * ## Qué es esto
 *
 * La Bandeja del asistente de WhatsApp se mudó de `admin_app_v21` a `negocio_app`. En el panel
 * la protegía un guard escrito en TypeScript (`whatsappGuard`: ADMINISTRADOR siempre, CAJERO si
 * el plan trae el asistente). En `negocio_app` los permisos no se escriben en el código: salen
 * de `general.gener_nivel` y el frontend solo obedece. Así que la vista necesita existir en la
 * base antes de que exista en la app.
 *
 * **No crea ninguna tabla.** El dato de las conversaciones vive en el esquema `intelligence`
 * desde F5-A y las rutas del API (`/admin/intelligence/bandeja/*`) no se tocan: ya acotaban por
 * `alcanceDeNegocios()`, y por eso sirven igual a las dos apps sin cambiar una línea.
 *
 * ## El orden importa, y no es una recomendación
 *
 * Esta migración va **ANTES** de desplegar el frontend. En la sesión de `negocio_app` un permiso
 * **ausente es un permiso denegado**: si la app sale primero, la entrada del menú lleva a «sin
 * acceso» para todo el mundo hasta que la migración corra. Es la trampa que ya costó un
 * despliegue con los subniveles de otro módulo.
 *
 * ## Qué siembra
 *
 *   1. La vista `/conversaciones` (nivel tipo 1), colgando de la raíz `/restaurante`.
 *   2. Un subnivel de acción, `whatsapp_numero`: conectar o desconectar el número del negocio.
 *      Va aparte de la vista a propósito — contestar una conversación y decidir que el WhatsApp
 *      del negocio pase por la Cloud API (con lo que deja de funcionar en el móvil del dueño)
 *      son dos permisos distintos, y el segundo es del dueño.
 *   3. Permisos por rol, replicando lo que hacía el guard del panel, que es la decisión del
 *      usuario del 2026-10-08 («igual que hoy: admin + cajero»):
 *        · ADMINISTRADOR → la vista y `whatsapp_numero`.
 *        · CAJERO        → solo la vista. Contesta; no conecta.
 *   4. El backfill de `gener_nivel_negocio`, sin el cual un negocio CON ajustes propios no vería
 *      el módulo nuevo y se quedaría mudo sin decir por qué.
 *
 * ## Lo que NO hace, y por qué
 *
 * **No mira el plan.** El guard del panel le exigía al cajero la feature `asistente_ia`; aquí
 * eso no se congela en una fila, porque un permiso sembrado no se entera de que el negocio
 * cambió de plan. El plan se resuelve en vivo: `features.estaHabilitado()` en el backend y
 * `auth.tieneFeature()` en la pantalla, que enseña la invitación a mejorar el plan. Un permiso
 * dice «quién»; un plan dice «qué está contratado». Mezclarlos deja permisos que mienten.
 *
 * Todo por NOMBRE y nunca por id (los ids de `gener_tipo_negocio` difieren dev/prod). Idempotente.
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const TIPO_NEGOCIO = 'RESTAURANTE';
const URL_MODULO = '/conversaciones';
const DESCRIPCION_MODULO = 'CONVERSACIONES';
const ICONO_MODULO = 'message-circle';

const SUBNIVELES = [
    { codigo: 'whatsapp_numero', descripcion: 'CONVERSACIONES - CONECTAR Y DESCONECTAR EL NUMERO' },
];

/** Qué rol nace con qué. La vista la ven los dos; el número solo lo toca el administrador. */
const PERMISOS = [
    { rol: 'ADMINISTRADOR', urls: [URL_MODULO, 'whatsapp_numero'] },
    { rol: 'CAJERO', urls: [URL_MODULO] },
];

async function unaFila(sql, replacements, transaction) {
    const [filas] = await sequelize.query(sql, { replacements, transaction });
    return filas.length ? filas[0] : null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('-> Migracion: permisos de Conversaciones (negocio_app)\n');

        // -- 1. El vertical ---------------------------------------------------
        const tipo = await unaFila(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio
              WHERE UPPER(TRIM(nombre)) = :nombre ORDER BY id_tipo_negocio LIMIT 1;`,
            { nombre: TIPO_NEGOCIO },
            t,
        );
        if (!tipo) {
            console.log(`1. No existe el tipo "${TIPO_NEGOCIO}": no hay nada que sembrar.`);
            await t.commit();
            console.log('\nMigracion completada (sin cambios).');
            return;
        }
        const idTipoNegocio = Number(tipo.id_tipo_negocio);
        console.log(`1. Vertical ${TIPO_NEGOCIO}: id ${idTipoNegocio}.`);

        // -- 2. La vista /conversaciones --------------------------------------
        const raiz = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = '/restaurante'
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio },
            t,
        );

        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
            SELECT :descripcion, :idNivelPadre, :icono, 'A', 1, :idTipoNegocio, :url, CURRENT_TIMESTAMP
             WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                 WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
             );
        `, {
            replacements: {
                descripcion: DESCRIPCION_MODULO,
                icono: ICONO_MODULO,
                idTipoNegocio,
                url: URL_MODULO,
                idNivelPadre: raiz ? raiz.id_nivel : null,
            },
            transaction: t,
        });
        console.log(`2. Vista ${URL_MODULO}: lista.`);

        // -- 3. Los subniveles de accion --------------------------------------
        const tipoAccion = await unaFila(
            `SELECT id_tipo_nivel FROM general.gener_tipo_nivel
              WHERE estado = 'A' AND UPPER(nombre) = 'ACCION' ORDER BY id_tipo_nivel LIMIT 1;`,
            {},
            t,
        );
        if (!tipoAccion) throw new Error('No se encontro el tipo de nivel ACCION.');
        const idTipoNivelAccion = Number(tipoAccion.id_tipo_nivel);

        const modulo = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio, url: URL_MODULO },
            t,
        );

        for (const sub of SUBNIVELES) {
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
                    descripcion: sub.descripcion,
                    idNivelPadre: Number(modulo.id_nivel),
                    idTipoNivelAccion,
                    idTipoNegocio,
                    codigo: sub.codigo,
                },
                transaction: t,
            });
        }
        console.log(`3. ${SUBNIVELES.length} subnivel(es) de accion: listos.`);

        // -- 4. Permisos por rol ----------------------------------------------
        for (const { rol, urls } of PERMISOS) {
            await sequelize.query(`
                INSERT INTO general.gener_rol_nivel
                    (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado, fecha_creacion, fecha_actualizacion)
                SELECT r.id_rol, nv.id_nivel, true, true, true, true, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                  FROM general.gener_rol r
                  JOIN general.gener_nivel nv
                    ON nv.id_tipo_negocio = r.id_tipo_negocio
                   AND nv.estado = 'A'
                   AND nv.url IN (:urls)
                 WHERE r.id_tipo_negocio = :idTipoNegocio
                   AND r.estado = 'A'
                   AND UPPER(TRIM(r.descripcion)) = :rol
                ON CONFLICT (id_rol, id_nivel) DO NOTHING;
            `, { replacements: { idTipoNegocio, rol, urls }, transaction: t });
            console.log(`4. ${rol}: ${urls.join(', ')}.`);
        }

        // -- 5. Los negocios que ya existen -----------------------------------
        //
        // `gener_nivel_negocio` manda cuando el negocio tiene ajustes propios: sin fila aqui, un
        // restaurante que haya tocado alguna vez "Roles y permisos" NO veria el modulo nuevo.
        const todasLasUrls = [URL_MODULO, ...SUBNIVELES.map((s) => s.codigo)];
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT n.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              FROM general.gener_negocio n
              JOIN general.gener_nivel nv
                ON nv.id_tipo_negocio = n.id_tipo_negocio
               AND nv.estado = 'A'
               AND nv.url IN (:urls)
              JOIN general.gener_rol_nivel rn
                ON rn.id_nivel = nv.id_nivel
               AND rn.estado = 'A'
             WHERE n.estado = 'A'
               AND n.id_tipo_negocio = :idTipoNegocio
               AND EXISTS (
                   SELECT 1 FROM general.gener_nivel_negocio nn WHERE nn.id_negocio = n.id_negocio
               )
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { idTipoNegocio, urls: todasLasUrls }, transaction: t });
        console.log('5. Backfill de gener_nivel_negocio: listo.');

        // -- 6. Lo que queda --------------------------------------------------
        const [resumen] = await sequelize.query(`
            SELECT r.descripcion AS rol, nv.url, rn.puede_ver
              FROM general.gener_rol_nivel rn
              JOIN general.gener_nivel nv ON nv.id_nivel = rn.id_nivel
              JOIN general.gener_rol r ON r.id_rol = rn.id_rol
             WHERE nv.id_tipo_negocio = :idTipoNegocio AND nv.url IN (:urls) AND rn.estado = 'A'
             ORDER BY r.descripcion, nv.url;
        `, { replacements: { idTipoNegocio, urls: todasLasUrls }, transaction: t });
        console.log('\n   Permisos sembrados:');
        for (const f of resumen) {
            console.log(`     ${String(f.rol).padEnd(16)} ${String(f.url).padEnd(20)} ver: ${f.puede_ver}`);
        }

        await t.commit();
        console.log('\nMigracion completada.');
    } catch (err) {
        await t.rollback();
        console.error('Migracion fallida (se revirtio todo):', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
