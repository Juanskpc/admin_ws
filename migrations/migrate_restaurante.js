/**
 * Migración — Esquema "restaurante"
 *
 * Crea todas las tablas necesarias para el módulo de restaurante:
 *
 * CARTA (menú):
 *   carta_categoria         — Categorías del menú (Burgers, Bebidas, etc.)
 *   carta_producto          — Productos del menú
 *   carta_ingrediente       — Ingredientes maestros
 *   carta_producto_ingred   — Relación M:N producto ↔ ingrediente
 *
 * PEDIDOS (POS):
 *   pedid_orden             — Orden / ticket / cuenta
 *   pedid_detalle           — Cada línea de producto en la orden
 *   pedid_detalle_exclu     — Ingredientes excluidos por línea ("sin cebolla")
 *
 * Ejecutar: node migrations/migrate_restaurante.js
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('╔══════════════════════════════════════════╗');
        console.log('║  MIGRACIÓN — Esquema restaurante         ║');
        console.log('╚══════════════════════════════════════════╝\n');

        // ====================================================
        // 1. Esquema
        // ====================================================
        console.log('1. Creando esquema "restaurante"...');
        await sequelize.query('CREATE SCHEMA IF NOT EXISTS restaurante;', { transaction: t });
        console.log('   ✔ Esquema listo\n');

        // ====================================================
        // 2. carta_categoria
        // ====================================================
        console.log('2. Creando tabla carta_categoria...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.carta_categoria (
                id_categoria    SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre          VARCHAR(100) NOT NULL,
                descripcion     VARCHAR(255),
                icono           VARCHAR(50),
                orden           INTEGER NOT NULL DEFAULT 0,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(id_negocio, nombre)
            );
        `, { transaction: t });
        console.log('   ✔ carta_categoria\n');

        // ====================================================
        // 3. carta_producto
        // ====================================================
        console.log('3. Creando tabla carta_producto...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.carta_producto (
                id_producto     SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_categoria    INTEGER NOT NULL REFERENCES restaurante.carta_categoria(id_categoria),
                nombre          VARCHAR(150) NOT NULL,
                descripcion     VARCHAR(500),
                precio          NUMERIC(12,2) NOT NULL DEFAULT 0,
                imagen_url      VARCHAR(500),
                icono           VARCHAR(50),
                es_popular      BOOLEAN NOT NULL DEFAULT FALSE,
                disponible      BOOLEAN NOT NULL DEFAULT TRUE,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        console.log('   ✔ carta_producto\n');

        // ====================================================
        // 4. carta_ingrediente
        // ====================================================
        console.log('4. Creando tabla carta_ingrediente...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.carta_ingrediente (
                id_ingrediente  SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre          VARCHAR(100) NOT NULL,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(id_negocio, nombre)
            );
        `, { transaction: t });
        console.log('   ✔ carta_ingrediente\n');

        // ====================================================
        // 5. carta_producto_ingred (M:N)
        // ====================================================
        console.log('5. Creando tabla carta_producto_ingred...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.carta_producto_ingred (
                id_producto_ingred  SERIAL PRIMARY KEY,
                id_producto         INTEGER NOT NULL REFERENCES restaurante.carta_producto(id_producto),
                id_ingrediente      INTEGER NOT NULL REFERENCES restaurante.carta_ingrediente(id_ingrediente),
                es_removible        BOOLEAN NOT NULL DEFAULT TRUE,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                UNIQUE(id_producto, id_ingrediente)
            );
        `, { transaction: t });
        console.log('   ✔ carta_producto_ingred\n');

        // ====================================================
        // 6. pedid_orden
        // ====================================================
        console.log('6. Creando tabla pedid_orden...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.pedid_orden (
                id_orden        SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_usuario      INTEGER NOT NULL REFERENCES general.gener_usuario(id_usuario),
                numero_orden    VARCHAR(20) NOT NULL,
                mesa            VARCHAR(50),
                nota            TEXT,
                subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
                impuesto        NUMERIC(12,2) NOT NULL DEFAULT 0,
                total           NUMERIC(12,2) NOT NULL DEFAULT 0,
                estado          VARCHAR(20) NOT NULL DEFAULT 'ABIERTA',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_cierre    TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_pedid_orden_negocio
                ON restaurante.pedid_orden(id_negocio, estado);
        `, { transaction: t });
        console.log('   ✔ pedid_orden\n');

        // ====================================================
        // 7. pedid_detalle
        // ====================================================
        console.log('7. Creando tabla pedid_detalle...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.pedid_detalle (
                id_detalle      SERIAL PRIMARY KEY,
                id_orden        INTEGER NOT NULL REFERENCES restaurante.pedid_orden(id_orden),
                id_producto     INTEGER NOT NULL REFERENCES restaurante.carta_producto(id_producto),
                cantidad        INTEGER NOT NULL DEFAULT 1,
                precio_unitario NUMERIC(12,2) NOT NULL,
                subtotal        NUMERIC(12,2) NOT NULL,
                nota            TEXT,
                estado          VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        console.log('   ✔ pedid_detalle\n');

        // ====================================================
        // 8. pedid_detalle_exclu (ingredientes removidos)
        // ====================================================
        console.log('8. Creando tabla pedid_detalle_exclu...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.pedid_detalle_exclu (
                id_detalle_exclu  SERIAL PRIMARY KEY,
                id_detalle        INTEGER NOT NULL REFERENCES restaurante.pedid_detalle(id_detalle),
                id_ingrediente    INTEGER NOT NULL REFERENCES restaurante.carta_ingrediente(id_ingrediente),
                UNIQUE(id_detalle, id_ingrediente)
            );
        `, { transaction: t });
        console.log('   ✔ pedid_detalle_exclu\n');

        // ====================================================
        // 9. Datos de ejemplo para id_negocio = 1
        // ====================================================
        console.log('9. Insertando datos de ejemplo...');

        // Categorías
        await sequelize.query(`
            INSERT INTO restaurante.carta_categoria (id_negocio, nombre, descripcion, icono, orden)
            VALUES
                (1, 'Hamburguesas', 'Todas nuestras hamburguesas', '🍔', 1),
                (1, 'Papas',        'Papas y acompañamientos',     '🍟', 2),
                (1, 'Combos',       'Combos armados',              '🍗', 3),
                (1, 'Bebidas',      'Gaseosas, jugos y más',       '🥤', 4),
                (1, 'Postres',      'Dulces y helados',            '🧁', 5),
                (1, 'Extras',       'Porciones adicionales',       '🌮', 6),
                (1, 'Ensaladas',    'Opciones saludables',         '🥗', 7)
            ON CONFLICT DO NOTHING;
        `, { transaction: t });

        // Ingredientes maestros
        await sequelize.query(`
            INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre)
            VALUES
                (1, 'Lechuga'), (1, 'Tomate'), (1, 'Cebolla'),
                (1, 'Queso cheddar'), (1, 'Queso mozzarella'),
                (1, 'Jalapeño'), (1, 'Pepinillos'), (1, 'Bacon'),
                (1, 'Salsa BBQ'), (1, 'Mayonesa'), (1, 'Ketchup'),
                (1, 'Mostaza'), (1, 'Aguacate'), (1, 'Cebolla caramelizada')
            ON CONFLICT DO NOTHING;
        `, { transaction: t });

        // Obtener IDs dinámicos
        const [cats] = await sequelize.query(
            `SELECT id_categoria, nombre FROM restaurante.carta_categoria WHERE id_negocio = 1 ORDER BY orden`,
            { transaction: t }
        );
        const catMap = {};
        cats.forEach(c => { catMap[c.nombre] = c.id_categoria; });

        // Productos
        await sequelize.query(`
            INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, descripcion, precio, icono, es_popular)
            VALUES
                (1, ${catMap['Hamburguesas']}, 'Burger Clásica',   'Res, cheddar, lechuga',             12000, '🍔', TRUE),
                (1, ${catMap['Hamburguesas']}, 'Burger Volcán',    'Res doble, jalapeño',               18000, '🔥', TRUE),
                (1, ${catMap['Hamburguesas']}, 'Burger BBQ',       'Res, BBQ, cebolla caramelizada',    15500, '🧀', FALSE),
                (1, ${catMap['Hamburguesas']}, 'Chicken Crispy',   'Pollo crujiente, mayo',             13000, '🐔', FALSE),
                (1, ${catMap['Hamburguesas']}, 'Doble Fuego',      '2 carnes, 2 quesos, bacon',         22000, '💥', TRUE),
                (1, ${catMap['Hamburguesas']}, 'Veggie Burger',    'Carne vegetal, aguacate',           14000, '🌱', FALSE),
                (1, ${catMap['Papas']},        'Papas Clásicas',   'Papas fritas crujientes',            5000, '🍟', FALSE),
                (1, ${catMap['Papas']},        'Papas con Queso',  'Papas fritas con queso cheddar',     7000, '🧀', TRUE),
                (1, ${catMap['Bebidas']},      'Coca-Cola 400ml',  'Gaseosa',                            4500, '🥤', FALSE),
                (1, ${catMap['Bebidas']},      'Limonada Natural',  'Limonada fresca',                   5000, '🍋', FALSE),
                (1, ${catMap['Postres']},      'Brownie',          'Brownie con helado',                 8000, '🍫', FALSE),
                (1, ${catMap['Combos']},       'Combo Clásico',    'Burger + papas + bebida',           20000, '🍗', TRUE)
            ON CONFLICT DO NOTHING;
        `, { transaction: t });

        // Asignar ingredientes a las hamburguesas
        const [prods] = await sequelize.query(
            `SELECT id_producto, nombre FROM restaurante.carta_producto WHERE id_negocio = 1 AND id_categoria = ${catMap['Hamburguesas']}`,
            { transaction: t }
        );
        const [ings] = await sequelize.query(
            `SELECT id_ingrediente, nombre FROM restaurante.carta_ingrediente WHERE id_negocio = 1`,
            { transaction: t }
        );
        const ingMap = {};
        ings.forEach(i => { ingMap[i.nombre] = i.id_ingrediente; });

        // Relación producto-ingrediente (todas las hamburguesas con ingredientes base)
        const baseIngredients = ['Lechuga', 'Tomate', 'Cebolla', 'Queso cheddar', 'Mayonesa', 'Ketchup'];
        for (const prod of prods) {
            for (const ingName of baseIngredients) {
                if (ingMap[ingName]) {
                    await sequelize.query(`
                        INSERT INTO restaurante.carta_producto_ingred (id_producto, id_ingrediente, es_removible)
                        VALUES (${prod.id_producto}, ${ingMap[ingName]}, TRUE)
                        ON CONFLICT DO NOTHING;
                    `, { transaction: t });
                }
            }
        }

        console.log('   ✔ Datos de ejemplo insertados\n');

        // ====================================================
        // COMMIT
        // ====================================================
        await t.commit();
        console.log('════════════════════════════════════════════');
        console.log('  ✅ Migración completada exitosamente');
        console.log('════════════════════════════════════════════\n');

    } catch (err) {
        await t.rollback();
        console.error('❌ Error en migración:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
