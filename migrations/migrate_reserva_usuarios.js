/**
 * Añade el módulo **Usuarios** al vertical `reserva`.
 *
 * Solo catálogo de permisos: el nivel `/usuarios` y su concesión al rol ADMINISTRADOR. No hay
 * DDL — los usuarios, roles y permisos viven en tablas de `general` que ya existen.
 *
 * ## Quién lo ve
 *
 * Solo **ADMINISTRADOR**. Dar de alta usuarios es decidir quién entra al negocio y con qué
 * permisos; un recepcionista con acceso a esta pantalla podría concederse a sí mismo la caja o
 * los informes. Es la única vista del vertical donde el reparto de roles no es discutible.
 *
 * ## Y el rol PROFESIONAL
 *
 * `migrate_reserva.js` ya le dio `/dashboard`, `/agenda` y `/citas` en solo lectura, que es lo
 * que necesita alguien que solo viene a ver su día. Esta migración no lo toca.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-usuarios
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const URL_NIVEL = '/usuarios';

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: módulo Usuarios (reserva) ===\n');

        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) {
            throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        }
        const idTipo = tipo.id_tipo_negocio;
        console.log(`1. Tipo RESERVA = ${idTipo}`);

        const [[padre]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/reserva';
        `, { replacements: { tipo: idTipo }, transaction: t });

        console.log('2. Insertando nivel USUARIOS...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'USUARIOS', :padre, 'user-cog', 'A', 1, :url, :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
            );
        `, { replacements: { padre: padre ? padre.id_nivel : null, url: URL_NIVEL, tipo: idTipo }, transaction: t });

        const [[nivel]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url;
        `, { replacements: { tipo: idTipo, url: URL_NIVEL }, transaction: t });
        console.log(`   OK — id_nivel = ${nivel.id_nivel}`);

        console.log('3. Concediendo a ADMINISTRADOR...');
        const [rolNivel] = await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT r.id_rol, :nivel, true, true, true, true, 'A'
            FROM general.gener_rol r
            WHERE r.id_tipo_negocio = :tipo AND r.descripcion = 'ADMINISTRADOR' AND r.estado = 'A'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING
            RETURNING id_rol;
        `, { replacements: { nivel: nivel.id_nivel, tipo: idTipo }, transaction: t });
        console.log(`   OK — ${rolNivel.length} fila(s) nuevas`);

        // Backfill: `gener_nivel_negocio` actúa como filtro. Un negocio que ya tenga ajustes
        // propios y no incluya este nivel no vería la vista aunque el rol la permita.
        console.log('4. Backfill gener_nivel_negocio...');
        const [backfill] = await sequelize.query(`
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
        console.log(`   OK — ${backfill.length} fila(s) nuevas`);

        await t.commit();

        const resumen = await sequelize.query(`
            SELECT r.descripcion AS rol, rn.puede_ver, rn.puede_crear,
                   (SELECT COUNT(*) FROM general.gener_nivel_negocio nn WHERE nn.id_nivel = :nivel) AS negocios
            FROM general.gener_rol_nivel rn
            JOIN general.gener_rol r ON r.id_rol = rn.id_rol
            WHERE rn.id_nivel = :nivel;
        `, { replacements: { nivel: nivel.id_nivel }, type: sequelize.QueryTypes.SELECT });

        console.log('\n=== Resultado ===');
        resumen.forEach(r => console.log(`   ${r.rol}: ver=${r.puede_ver} crear=${r.puede_crear} · negocios=${r.negocios}`));
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
