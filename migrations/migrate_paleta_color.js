/**
 * migrate_paleta_color.js
 *
 * Crea la tabla general.gener_paleta_color y agrega la columna
 * id_paleta a general.gener_negocio para vincular cada negocio
 * con su identidad visual elegida.
 *
 * También inserta las paletas predefinidas del sistema.
 *
 * Uso: node migrations/migrate_paleta_color.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

// ============================================================
// Paletas predefinidas del sistema
// ============================================================
const PALETAS = [
    {
        nombre: 'Azul Corporativo',
        descripcion: 'Paleta profesional en tonos azules. Ideal para negocios formales y financieras.',
        es_default: true,
        colores: {
            'color-primary': '#1565c0',
            'color-primary-hover': '#0d47a1',
            'color-on-primary': '#ffffff',
            'color-bg': '#f5f5f5',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#212121',
            'color-text-secondary': '#616161',
            'color-border': '#e0e0e0',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#1565c0',
        },
    },
    {
        nombre: 'Rojo Gastronómico',
        descripcion: 'Paleta cálida en tonos rojos y naranjas. Ideal para restaurantes y cafeterías.',
        es_default: false,
        colores: {
            'color-primary': '#c62828',
            'color-primary-hover': '#b71c1c',
            'color-on-primary': '#ffffff',
            'color-bg': '#fafafa',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#212121',
            'color-text-secondary': '#616161',
            'color-border': '#e0e0e0',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#d32f2f',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#c62828',
        },
    },
    {
        nombre: 'Verde Natural',
        descripcion: 'Paleta fresca en tonos verdes. Ideal para tiendas orgánicas, farmacias y spas.',
        es_default: false,
        colores: {
            'color-primary': '#2e7d32',
            'color-primary-hover': '#1b5e20',
            'color-on-primary': '#ffffff',
            'color-bg': '#f1f8e9',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#1b5e20',
            'color-text-secondary': '#558b2f',
            'color-border': '#c8e6c9',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#2e7d32',
        },
    },
    {
        nombre: 'Morado Elegante',
        descripcion: 'Paleta sofisticada en tonos púrpura. Ideal para barberías, salones de belleza y boutiques.',
        es_default: false,
        colores: {
            'color-primary': '#6a1b9a',
            'color-primary-hover': '#4a148c',
            'color-on-primary': '#ffffff',
            'color-bg': '#f3e5f5',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#311b92',
            'color-text-secondary': '#7b1fa2',
            'color-border': '#ce93d8',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#6a1b9a',
        },
    },
    {
        nombre: 'Naranja Vibrante',
        descripcion: 'Paleta enérgica en tonos naranja y ámbar. Ideal para gimnasios, deportes y entretenimiento.',
        es_default: false,
        colores: {
            'color-primary': '#e65100',
            'color-primary-hover': '#bf360c',
            'color-on-primary': '#ffffff',
            'color-bg': '#fff3e0',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#212121',
            'color-text-secondary': '#6d4c41',
            'color-border': '#ffcc80',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ff6f00',
            'color-focus': '#e65100',
        },
    },
    {
        nombre: 'Turquesa Moderno',
        descripcion: 'Paleta moderna en tonos teal y turquesa. Ideal para tecnología, startups y servicios digitales.',
        es_default: false,
        colores: {
            'color-primary': '#00897b',
            'color-primary-hover': '#00695c',
            'color-on-primary': '#ffffff',
            'color-bg': '#e0f2f1',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#004d40',
            'color-text-secondary': '#00796b',
            'color-border': '#80cbc4',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#00897b',
        },
    },
    {
        nombre: 'Dorado Premium',
        descripcion: 'Paleta lujosa en tonos dorados y oscuros. Ideal para joyerías, hoteles y servicios premium.',
        es_default: false,
        colores: {
            'color-primary': '#bf8c00',
            'color-primary-hover': '#a67c00',
            'color-on-primary': '#ffffff',
            'color-bg': '#fffde7',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#3e2723',
            'color-text-secondary': '#5d4037',
            'color-border': '#ffe082',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#bf8c00',
        },
    },
    {
        nombre: 'Rosa Delicado',
        descripcion: 'Paleta suave en tonos rosa y coral. Ideal para pastelerías, floristerías y tiendas infantiles.',
        es_default: false,
        colores: {
            'color-primary': '#d81b60',
            'color-primary-hover': '#c2185b',
            'color-on-primary': '#ffffff',
            'color-bg': '#fce4ec',
            'color-surface': '#ffffff',
            'color-surface-elevated': '#ffffff',
            'color-text-primary': '#880e4f',
            'color-text-secondary': '#ad1457',
            'color-border': '#f48fb1',
            'color-success': '#2e7d32',
            'color-success-bg': '#e8f5e9',
            'color-error': '#c62828',
            'color-error-bg': '#ffebee',
            'color-warning': '#ef6c00',
            'color-focus': '#d81b60',
        },
    },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Iniciando migración: gener_paleta_color...\n');

        // ─── 1. Crear tabla de paletas ──────────────────────────────
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_paleta_color (
                id_paleta   SERIAL       PRIMARY KEY,
                nombre      VARCHAR(100) NOT NULL UNIQUE,
                descripcion TEXT,
                colores     JSONB        NOT NULL,
                es_default  BOOLEAN      NOT NULL DEFAULT FALSE,
                estado      CHAR(1)      NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `, { transaction: t });
        console.log('  ✔ Tabla general.gener_paleta_color creada');

        // ─── 2. Índices ─────────────────────────────────────────────
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gpc_estado
                ON general.gener_paleta_color(estado);
        `, { transaction: t });

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gpc_es_default
                ON general.gener_paleta_color(es_default);
        `, { transaction: t });
        console.log('  ✔ Índices creados');

        // ─── 3. Agregar columna id_paleta a gener_negocio ───────────
        await sequelize.query(`
            ALTER TABLE general.gener_negocio
            ADD COLUMN IF NOT EXISTS id_paleta INTEGER
            REFERENCES general.gener_paleta_color(id_paleta) ON DELETE SET NULL;
        `, { transaction: t });
        console.log('  ✔ Columna id_paleta agregada a general.gener_negocio');

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gn_id_paleta
                ON general.gener_negocio(id_paleta);
        `, { transaction: t });

        // ─── 4. Insertar paletas predefinidas ───────────────────────
        for (const paleta of PALETAS) {
            await sequelize.query(`
                INSERT INTO general.gener_paleta_color (nombre, descripcion, colores, es_default)
                VALUES (:nombre, :descripcion, :colores, :es_default)
                ON CONFLICT (nombre) DO NOTHING;
            `, {
                replacements: {
                    nombre: paleta.nombre,
                    descripcion: paleta.descripcion,
                    colores: JSON.stringify(paleta.colores),
                    es_default: paleta.es_default,
                },
                transaction: t,
            });
        }
        console.log(`  ✔ ${PALETAS.length} paletas predefinidas insertadas`);

        await t.commit();
        console.log('\n✅ Migración general.gener_paleta_color completada');
        console.log('   Tabla: general.gener_paleta_color');
        console.log('   Columna agregada: general.gener_negocio.id_paleta');
        console.log(`   Paletas insertadas: ${PALETAS.map(p => p.nombre).join(', ')}`);
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
