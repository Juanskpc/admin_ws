/**
 * Añade el módulo **Informes** al vertical `reserva`.
 *
 * Solo toca el catálogo de permisos: crea el nivel `/informes` y lo concede a los roles que
 * deben verlo. No hay DDL — los informes se calculan sobre las tablas que ya existen.
 *
 * ## Por qué hace falta una migración para una vista
 *
 * `permissionGuard` (frontend) solo deja entrar a una ruta que aparezca en `permisos_vista`, y
 * esa lista sale de `gener_nivel` + `gener_rol_nivel`. Sin estas filas la pantalla existe,
 * compila y es inalcanzable: el menú no la muestra y la URL rebota. Añadir una vista al
 * vertical es, por diseño, añadirla también al catálogo.
 *
 * ## Quién lo ve
 *
 * - **ADMINISTRADOR**: sí. Es el destinatario: son las cifras para decidir sobre el negocio.
 * - **RECEPCIONISTA** y **PROFESIONAL**: no. Un informe incluye ingresos totales y el
 *   rendimiento comparado de cada compañero; eso es información del dueño, no de la operación
 *   diaria. Concederlo es una decisión que el negocio puede tomar después desde
 *   `gener_nivel_negocio`, que es exactamente para lo que existe esa tabla.
 *
 * Idempotente: se puede ejecutar tantas veces como haga falta.
 *
 *   npm run migrate:reserva-informes
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const URL_NIVEL = '/informes';

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: módulo Informes (reserva) ===\n');

        // 1. Tipo de negocio RESERVA
        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });

        if (!tipo) {
            throw new Error(
                'No existe el tipo de negocio RESERVA. Ejecuta antes `npm run migrate:reserva`.',
            );
        }
        const idTipo = tipo.id_tipo_negocio;
        console.log(`1. Tipo RESERVA = ${idTipo}`);

        // 2. Nivel padre del vertical, para colgar de él el módulo nuevo.
        const [[padre]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva';
        `, { replacements: { tipo: idTipo }, transaction: t });
        const idPadre = padre ? padre.id_nivel : null;
        console.log(`2. Nivel padre = ${idPadre ?? '(ninguno)'}`);

        // 3. Nivel /informes. La guarda va por (tipo, tipo_nivel, url), que es como identifica
        //    un módulo el resto de la migración del vertical.
        console.log('3. Insertando nivel INFORMES...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'INFORMES', :padre, 'chart-column', 'A', 1, :url, :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
            );
        `, { replacements: { padre: idPadre, url: URL_NIVEL, tipo: idTipo }, transaction: t });

        const [[nivel]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url;
        `, { replacements: { tipo: idTipo, url: URL_NIVEL }, transaction: t });
        console.log(`   OK — id_nivel = ${nivel.id_nivel}`);

        // 4. Permiso para ADMINISTRADOR. Solo lectura: un informe no se crea ni se borra.
        console.log('4. Concediendo a ADMINISTRADOR...');
        const [resRol] = await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT r.id_rol, :nivel, true, false, false, false, 'A'
            FROM general.gener_rol r
            WHERE r.id_tipo_negocio = :tipo AND r.descripcion = 'ADMINISTRADOR' AND r.estado = 'A'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING
            RETURNING id_rol;
        `, { replacements: { nivel: nivel.id_nivel, tipo: idTipo }, transaction: t });
        console.log(`   OK — ${resRol.length} fila(s) nuevas`);

        // 5. Backfill por negocio.
        //
        //    `gener_nivel_negocio` actúa como filtro: si un negocio ya tiene ajustes propios y
        //    este nivel no está entre ellos, la vista se le oculta aunque el rol la permita
        //    (ver `dashboardService.getPermisosVistaNegocio`). Por eso hay que sembrarla en los
        //    negocios que ya existen, no solo conceder el permiso al rol.
        console.log('5. Backfill gener_nivel_negocio...');
        const [resNeg] = await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, true, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.id_nivel = :nivel
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, { replacements: { nivel: nivel.id_nivel, tipo: idTipo }, transaction: t });
        console.log(`   OK — ${resNeg.length} fila(s) nuevas`);

        await t.commit();

        // Verificación posterior al commit: se lee lo que quedó, no lo que se creyó escribir.
        const resumen = await sequelize.query(`
            SELECT r.descripcion AS rol, rn.puede_ver,
                   (SELECT COUNT(*) FROM general.gener_nivel_negocio nn WHERE nn.id_nivel = :nivel) AS negocios
            FROM general.gener_rol_nivel rn
            JOIN general.gener_rol r ON r.id_rol = rn.id_rol
            WHERE rn.id_nivel = :nivel;
        `, { replacements: { nivel: nivel.id_nivel }, type: sequelize.QueryTypes.SELECT });

        console.log('\n=== Resultado ===');
        resumen.forEach(r => console.log(`   ${r.rol}: ver=${r.puede_ver} · negocios sembrados=${r.negocios}`));
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
