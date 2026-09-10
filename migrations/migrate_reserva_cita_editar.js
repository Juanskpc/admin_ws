/**
 * Permiso de **edición de citas** en el vertical `reserva`.
 *
 * Hasta ahora una cita agendada no se podía tocar: si el cliente pedía otro servicio o quería
 * añadir uno, la única salida era eliminarla y volverla a crear, lo que se lleva por delante
 * el histórico, el código público con el que el cliente consulta y los recordatorios ya
 * programados. Se modela como una acción más (`gener_nivel` con `id_tipo_nivel = 4`) colgada
 * de `/citas`:
 *
 *   - `/citas/editar` → `citas_editar` — cambiar servicios, profesional y hora de una cita.
 *
 * ## A quién se le concede
 *
 * A los roles que **ya gestionan citas**, es decir los que tienen `/citas/completar` o
 * `/citas/cancelar`. El razonamiento: quien ya puede cerrar o cancelar una cita tiene sobre
 * ella una potestad mayor que la de corregirle un servicio, así que negarle la edición no
 * protegería nada y sí obligaría al dueño a repartir permisos a mano el primer día.
 *
 * No se siembra a todo el mundo: un rol que solo consulta la agenda sigue sin poder editar.
 *
 * A diferencia de `caja_ver_ingresos`, esto es una capacidad **nueva** —antes no la tenía
 * nadie— así que sembrarla acotada no le quita nada a quien ya operaba.
 *
 * Idempotente. Debe correr ANTES de desplegar el frontend que la consume, o el boton
 * "Editar" no aparecera para nadie ("ausente" == "denegado" en la sesion).
 *
 *   npm run migrate:reserva-cita-editar
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const TIPO_NIVEL_ACCION = 4;
const URL_VISTA = '/citas';
const URL_ACCION = '/citas/editar';
const DESCRIPCION = 'Editar una cita agendada';

/** Acciones cuya posesión implica que el rol ya gestiona citas. */
const ACCIONES_QUE_IMPLICAN_GESTION = ['/citas/completar', '/citas/cancelar'];

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: permiso de edición de citas (reserva) ===\n');

        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        const idTipo = tipo.id_tipo_negocio;
        console.log(`1. Tipo RESERVA = ${idTipo}`);

        const [[vista]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url AND estado = 'A';
        `, { replacements: { tipo: idTipo, url: URL_VISTA }, transaction: t });
        if (!vista) throw new Error(`No existe la vista ${URL_VISTA}. Ejecuta antes las migraciones de reserva.`);

        console.log('2. Insertando la acción...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT :desc, :padre, NULL, 'A', :tn, :url, :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn AND url = :url
            );
        `, {
            replacements: {
                desc: DESCRIPCION, padre: vista.id_nivel, url: URL_ACCION,
                tipo: idTipo, tn: TIPO_NIVEL_ACCION,
            },
            transaction: t,
        });

        const [[accion]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn AND url = :url;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION, url: URL_ACCION }, transaction: t });
        if (!accion) throw new Error('No se pudo crear ni encontrar la acción.');
        console.log(`   OK — ${URL_ACCION} = nivel ${accion.id_nivel}\n`);

        // ── Matriz global por rol ──
        // Se concede al rol que ya tenga alguna de las acciones de gestión. Un rol que solo
        // mira la agenda no entra.
        console.log('3. Concediendo a los roles que ya gestionan citas...');
        const [rolesGlobal] = await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT DISTINCT rn.id_rol, :nivel, true, false, true, false, 'A'
            FROM general.gener_rol_nivel rn
            JOIN general.gener_nivel nv ON nv.id_nivel = rn.id_nivel
            WHERE nv.id_tipo_negocio = :tipo
              AND nv.id_tipo_nivel = :tn
              AND nv.url IN (:implican)
              AND rn.puede_ver = true
              AND rn.estado = 'A'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING
            RETURNING id_rol;
        `, {
            replacements: {
                nivel: accion.id_nivel, tipo: idTipo, tn: TIPO_NIVEL_ACCION,
                implican: ACCIONES_QUE_IMPLICAN_GESTION,
            },
            transaction: t,
        });
        console.log(`   OK — ${rolesGlobal.length} rol(es)\n`);

        // ── Override por negocio ──
        // Un negocio con ajustes propios no vería las filas de la plantilla, así que su
        // administrador se quedaría sin la acción recién creada. Se replica el mismo
        // criterio: lo recibe quien ya gestiona citas EN ESE negocio.
        console.log('4. Backfill gener_nivel_negocio...');
        const [porNegocio] = await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT DISTINCT nn.id_negocio, nn.id_rol, :nivel, true, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_nivel_negocio nn
            JOIN general.gener_nivel nv ON nv.id_nivel = nn.id_nivel
            JOIN general.gener_negocio neg ON neg.id_negocio = nn.id_negocio
            WHERE nv.id_tipo_negocio = :tipo
              AND nv.id_tipo_nivel = :tn
              AND nv.url IN (:implican)
              AND nn.puede_ver = true
              AND nn.estado = 'A'
              AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, {
            replacements: {
                nivel: accion.id_nivel, tipo: idTipo, tn: TIPO_NIVEL_ACCION,
                implican: ACCIONES_QUE_IMPLICAN_GESTION,
            },
            transaction: t,
        });
        console.log(`   OK — ${porNegocio.length} fila(s)\n`);

        await t.commit();

        const resumen = await sequelize.query(`
            SELECT r.descripcion AS rol, rn.puede_ver
            FROM general.gener_rol_nivel rn
            JOIN general.gener_rol r ON r.id_rol = rn.id_rol
            WHERE rn.id_nivel = :nivel
            ORDER BY r.descripcion;
        `, { replacements: { nivel: accion.id_nivel }, type: sequelize.QueryTypes.SELECT });

        console.log('=== Resultado ===');
        if (resumen.length === 0) {
            console.log('   ⚠️  Ningún rol tiene todavía /citas/completar ni /citas/cancelar,');
            console.log('      así que nadie recibió la edición. Concédela en Roles y permisos.');
        } else {
            resumen.forEach(r => console.log(`   ${URL_ACCION} → ${r.rol} (${r.puede_ver ? 'sí' : 'no'})`));
        }
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
