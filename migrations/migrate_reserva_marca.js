/**
 * Identidad visual del negocio: logo y colores propios.
 *
 * Añade a `general.gener_negocio`:
 *   - `logo_url`  — ruta del logo subido
 *   - `colores`   — JSONB con los colores elegidos por el dueño
 *
 * Y siembra `general.gener_paleta_color` con paletas listas para quien no tenga colores propios.
 *
 * ## Por qué en `gener_negocio` y no en `reserva_config`
 *
 * El logo y los colores son identidad **del negocio**, no del vertical. Una barbería que mañana
 * abra también un restaurante no querría un logo distinto en cada módulo. `gener_negocio` ya
 * tiene `id_paleta` para exactamente esto —lleva ahí desde el principio y estaba sin usar—, así
 * que los colores propios se ponen a su lado en vez de inventar una tabla paralela.
 *
 * ## Dos formas de tener colores, y cuál gana
 *
 * - `id_paleta` → una de las paletas predefinidas.
 * - `colores`   → colores propios, elegidos con el selector.
 *
 * **`colores` manda si existe.** Si el dueño se tomó la molestia de elegir su color exacto, una
 * paleta seleccionada antes no debería pisarlo. Al elegir una paleta se copian sus valores a
 * `colores`, de modo que el resto del sistema lee siempre de un único sitio y no hay que
 * resolver precedencias en cada consulta.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-marca
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

/**
 * Paletas de partida.
 *
 * Cada una define solo `primario` y `acento`; el resto (hover, color del texto encima) se
 * deriva en el cliente. Guardar valores derivados los dejaría desincronizados en cuanto alguien
 * cambie el primario.
 */
const PALETAS = [
    ['Índigo EscalApp', { primario: '#312E81', acento: '#6366F1' }],
    ['Esmeralda',       { primario: '#0F766E', acento: '#10B981' }],
    ['Vino',            { primario: '#881337', acento: '#E11D48' }],
    ['Cobalto',         { primario: '#1E40AF', acento: '#3B82F6' }],
    ['Terracota',       { primario: '#9A3412', acento: '#F97316' }],
    ['Grafito',         { primario: '#1F2937', acento: '#6B7280' }],
    ['Violeta',         { primario: '#6B21A8', acento: '#A855F7' }],
    ['Bosque',          { primario: '#14532D', acento: '#22C55E' }],
];

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
        console.log('\n=== Migración: identidad visual del negocio ===\n');

        console.log('1. Columnas en gener_negocio...');
        if (!await columnaExiste('gener_negocio', 'logo_url', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio ADD COLUMN logo_url VARCHAR(500);
            `, { transaction: t });
            console.log('   + logo_url');
        }
        if (!await columnaExiste('gener_negocio', 'colores', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio ADD COLUMN colores JSONB;
            `, { transaction: t });
            console.log('   + colores');
        }
        console.log('   OK\n');

        console.log('2. Sembrando paletas...');
        let nuevas = 0;
        for (const [nombre, colores] of PALETAS) {
            const [res] = await sequelize.query(`
                INSERT INTO general.gener_paleta_color (nombre, colores)
                SELECT :nombre, CAST(:colores AS jsonb)
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_paleta_color WHERE lower(nombre) = lower(:nombre)
                )
                RETURNING id_paleta;
            `, { replacements: { nombre, colores: JSON.stringify(colores) }, transaction: t });
            nuevas += res.length;
        }
        console.log(`   OK — ${nuevas} paleta(s) nuevas\n`);

        await t.commit();

        const paletas = await sequelize.query(`
            SELECT id_paleta, nombre, colores FROM general.gener_paleta_color ORDER BY id_paleta;
        `, { type: sequelize.QueryTypes.SELECT });
        const cols = await sequelize.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'general' AND table_name = 'gener_negocio'
              AND column_name IN ('logo_url', 'colores') ORDER BY column_name;
        `, { type: sequelize.QueryTypes.SELECT });

        console.log('=== Resultado ===');
        cols.forEach(c => console.log(`   gener_negocio.${c.column_name}`));
        paletas.forEach(p => console.log(`   #${p.id_paleta} ${p.nombre} — ${p.colores.primario} / ${p.colores.acento}`));
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
