/**
 * PROFESIONAL gana la vista Horarios, pero solo para SU PROPIO horario.
 *
 * Hasta ahora un profesional no veía «Horarios» en absoluto (solo ve su agenda y sus citas —
 * `migrate_reserva.js`, paso 13). El caso que faltaba es normal en un salón con varios
 * estilistas: cada uno ajusta sus propios bloques de disponibilidad sin depender del dueño, y
 * sin poder tocar el horario general del negocio ni el de un compañero.
 *
 * ## Dos permisos, no uno
 *
 * `/horarios/editar` (ya existe desde `migrate_reserva_subniveles`) sigue siendo «edita
 * cualquier horario» — el del negocio y el de cualquier profesional. `/horarios/editar-propio`
 * es la variante acotada: el backend (`horarioController.puedeReemplazar`) la resuelve buscando
 * la ficha de `reserva_profesional` de quien llama y comparándola con el `id_profesional` que
 * pide tocar. Sin ficha propia, o pidiendo otra, se rechaza — no alcanza con esconder el
 * selector en el frontend, por lo mismo que el resto de acciones de `gener_nivel` tipo 4.
 *
 * Concede la vista Y la acción a PROFESIONAL a la vez: una sin la otra no serviría de nada
 * (una acción sin vista no se llega a ofrecer; una vista sin ninguna acción de escritura deja
 * Horarios en modo solo-lectura, que ya es una mejora pero no lo que se pidió).
 *
 * Son valores de partida, no una política: cada negocio los ajusta desde Usuarios → Roles.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-horarios-editar-propio
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const TIPO_NIVEL_VISTA = 1;
const TIPO_NIVEL_ACCION = 4;
const URL_ACCION = '/horarios/editar-propio';
const ETIQUETA_ACCION = 'Editar el horario propio';

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: Horarios → editar-propio (reserva) ===\n');

        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        const idTipo = tipo.id_tipo_negocio;

        const [vistas] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tv AND url = '/horarios';
        `, { replacements: { tipo: idTipo, tv: TIPO_NIVEL_VISTA }, transaction: t });
        if (!vistas.length) throw new Error('No existe la vista /horarios. Ejecuta antes `npm run migrate:reserva`.');
        const idVistaHorarios = vistas[0].id_nivel;

        const [[rolProfesional]] = await sequelize.query(`
            SELECT id_rol FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A' AND descripcion = 'PROFESIONAL';
        `, { replacements: { tipo: idTipo }, transaction: t });
        if (!rolProfesional) throw new Error('No existe el rol PROFESIONAL para RESERVA.');
        const idRolProfesional = rolProfesional.id_rol;

        // 1. La vista, para PROFESIONAL.
        console.log('1. Vista /horarios para PROFESIONAL...');
        const [insVista] = await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            VALUES (:rol, :nivel, true, false, false, false, 'A')
            ON CONFLICT (id_rol, id_nivel) DO UPDATE SET puede_ver = true, estado = 'A'
            RETURNING id_rol;
        `, { replacements: { rol: idRolProfesional, nivel: idVistaHorarios }, transaction: t });
        console.log(`   OK — ${insVista.length ? 'concedida' : 'sin cambios'}\n`);

        // 2. La acción, colgada de esa vista.
        console.log('2. Acción /horarios/editar-propio...');
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
                desc: ETIQUETA_ACCION, padre: idVistaHorarios, url: URL_ACCION,
                tipo: idTipo, tn: TIPO_NIVEL_ACCION,
            },
            transaction: t,
        });
        const [[accion]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn AND url = :url;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION, url: URL_ACCION }, transaction: t });
        const idAccion = accion.id_nivel;
        console.log(`   OK — id_nivel = ${idAccion}\n`);

        // 3. Concedida a PROFESIONAL.
        console.log('3. Concediendo la acción a PROFESIONAL...');
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            VALUES (:rol, :nivel, true, false, false, false, 'A')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: idRolProfesional, nivel: idAccion }, transaction: t });
        console.log('   OK\n');

        // 4. Backfill por negocio (mismo criterio que migrate_reserva_subniveles: sin esto, un
        //    negocio con ajustes propios en gener_nivel_negocio no ve ninguno de los dos.
        console.log('4. Backfill gener_nivel_negocio...');
        const [backfill] = await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.id_rol = :rol AND rn.id_nivel IN (:vista, :accion) AND rn.estado = 'A'
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, {
            replacements: { rol: idRolProfesional, vista: idVistaHorarios, accion: idAccion, tipo: idTipo },
            transaction: t,
        });
        console.log(`   OK — ${backfill.length} fila(s)\n`);

        await t.commit();
        console.log('Migración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
