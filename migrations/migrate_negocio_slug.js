/**
 * `slug` en `general.gener_negocio`: la identidad del negocio en una URL propia.
 *
 * Hasta ahora el único enlace público era `escalapp.cloud/reserva/p/:id_negocio` — funcional,
 * pero un número no dice nada del negocio ni se ve bien en redes. Con `slug` (p. ej.
 * `dalex-barberia`) el negocio puede compartir `dalex-barberia.escalapp.cloud`, que Caddy resuelve
 * en el VPS (bloque `*.escalapp.cloud` con TLS on-demand, fuera de este repo) y la app front
 * traduce internamente al mismo `/p/:id_negocio` de siempre — ver `subdominio.guard.ts`.
 *
 * Vive en `gener_negocio`, no en un esquema de vertical: es identidad del negocio, igual que
 * `logo_url` y `colores` (`migrate_reserva_marca.js`), no de un módulo.
 *
 * ## Backfill, no solo columna
 *
 * Un negocio sin `slug` no tiene subdominio, así que se generan aquí para TODOS los activos a
 * partir de su `nombre` actual, con el mismo generador (`app_core/helpers/slug.js`) que usa el
 * alta de un negocio nuevo — para que un slug de backfill no se escriba con una regla distinta a
 * la de uno recién creado. Los que ya tengan uno (ninguno, en la primera corrida) se dejan tal
 * cual: es idempotente.
 *
 * Idempotente: `IF NOT EXISTS` / consulta a `information_schema` antes de la `ALTER`, backfill
 * solo de filas con `slug IS NULL`, transacción única.
 *
 *   npm run migrate:negocio-slug
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');
const { generarSlugUnico } = require('../app_core/helpers/slug');

async function columnaExiste(tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'general' AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: slug de negocio (URL propia) ===\n');

        console.log('1. Columna gener_negocio.slug...');
        if (!await columnaExiste('gener_negocio', 'slug', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio ADD COLUMN slug VARCHAR(63);
            `, { transaction: t });
            console.log('   + gener_negocio.slug');
        } else {
            console.log('   Ya existía.');
        }

        // Insensible a mayúsculas a propósito: un subdominio no distingue "Dalex" de "dalex", y
        // dos negocios con slugs que solo difieren en caja serían indistinguibles en la práctica.
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_gener_negocio_slug
            ON general.gener_negocio (lower(slug))
            WHERE slug IS NOT NULL;
        `, { transaction: t });
        console.log('   OK\n');

        console.log('2. Backfill de negocios sin slug...');
        const pendientes = await sequelize.query(`
            SELECT id_negocio, nombre FROM general.gener_negocio
            WHERE estado = 'A' AND slug IS NULL
            ORDER BY id_negocio ASC;
        `, { type: sequelize.QueryTypes.SELECT, transaction: t });

        if (pendientes.length === 0) {
            console.log('   Nada que rellenar.\n');
        } else {
            // Los slugs ya asignados EN ESTA MISMA corrida no están todavía en la base, así que
            // `existe` mira también este set en memoria — si no, dos negocios con el mismo
            // nombre en el backfill se llevarían el mismo slug antes de que el índice único
            // pudiera impedirlo (la comprobación es anterior al INSERT de la fila anterior).
            const usados = new Set();
            for (const neg of pendientes) {
                const slug = await generarSlugUnico(neg.nombre, async (candidato) => {
                    if (usados.has(candidato)) return true;
                    const [filas] = await sequelize.query(`
                        SELECT 1 FROM general.gener_negocio WHERE lower(slug) = lower(:candidato);
                    `, { replacements: { candidato }, transaction: t });
                    return filas.length > 0;
                });
                usados.add(slug);
                await sequelize.query(`
                    UPDATE general.gener_negocio SET slug = :slug WHERE id_negocio = :id;
                `, { replacements: { slug, id: neg.id_negocio }, transaction: t });
                console.log(`   #${neg.id_negocio} «${neg.nombre}» → ${slug}`);
            }
            console.log(`   OK — ${pendientes.length} negocio(s) con slug nuevo\n`);
        }

        await t.commit();

        const [total] = await sequelize.query(`
            SELECT COUNT(*) FILTER (WHERE slug IS NOT NULL) AS con_slug, COUNT(*) AS total
            FROM general.gener_negocio WHERE estado = 'A';
        `, { type: sequelize.QueryTypes.SELECT });
        console.log('=== Resultado ===');
        console.log(`   Negocios activos con slug: ${total.con_slug} / ${total.total}`);
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
