/**
 * Migración: adiciones / toppings / extras ligados a un producto del restaurante.
 *
 * ## Qué resuelve
 *
 * Hasta hoy una adición («queso gratinado», «costilla») era un producto suelto de una categoría
 * ADICIONALES, cobrado como una línea más del pedido: nada decía a QUÉ plato iba. En una
 * heladería pasa lo mismo con los toppings. Con esto un producto puede ofrecer adiciones, y al
 * pedirlo quedan colgando de él.
 *
 * ## Por qué la adición ES un producto (y no una tabla nueva de «opciones»)
 *
 * Un producto ya trae todo lo que una adición necesita: precio, descripción, imagen, el
 * interruptor de agotado (`disponible`), los datos fiscales de la factura electrónica y, sobre
 * todo, **receta**: con `carta_producto_ingred` la adición descuenta su insumo del inventario por
 * el mismo camino que cualquier plato. Una tabla aparte habría duplicado cada una de esas piezas.
 *
 * ## Qué añade
 *
 *  1. `general.gener_negocio.permite_adiciones`  boolean NOT NULL DEFAULT false — opt-in, como
 *     los demás `permite_*`: nada cambia para un negocio hasta que lo encienda.
 *  2. `general.gener_negocio.termino_adiciones`  varchar(20) NOT NULL DEFAULT 'ADICION' — cómo
 *     las llama el negocio (Adiciones, Toppings, Extras…). Catálogo en
 *     `app_core/helpers/terminosAdicion.js`.
 *  3. `restaurante.carta_producto.es_adicion`    boolean NOT NULL DEFAULT false — el producto es
 *     una adición: no se vende solo en el POS ni en la carta, se ofrece dentro de otros.
 *  4. `restaurante.carta_producto_adicion`       qué adiciones ofrece cada producto.
 *  5. `restaurante.pedid_detalle.id_detalle_padre` — la línea del pedido que es una adición
 *     apunta a la del plato. Sigue siendo una línea normal (precio, cantidad, subtotal), así que
 *     totales, caja, reportes y factura electrónica la cuentan sin cambiar nada; solo cambia
 *     cómo se PINTA. Su `cantidad` es la total (2 hamburguesas con queso → queso × 2).
 *
 * Idempotente. npm run migrate:restaurante-adiciones
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

async function existeColumna(t, esquema, tabla, columna) {
    const [fila] = await sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;`,
        { replacements: { esquema, tabla, columna }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    return Boolean(fila);
}

async function anadirColumna(t, esquema, tabla, columna, definicion) {
    if (await existeColumna(t, esquema, tabla, columna)) {
        console.log(`   • ${esquema}.${tabla}.${columna} ya existía`);
        return;
    }
    await sequelize.query(`ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${definicion};`, {
        transaction: t,
    });
    console.log(`   ✓ ${esquema}.${tabla}.${columna}`);
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('1. Opciones del negocio...');
        await anadirColumna(t, 'general', 'gener_negocio', 'permite_adiciones', 'boolean NOT NULL DEFAULT false');
        await anadirColumna(
            t,
            'general',
            'gener_negocio',
            'termino_adiciones',
            "varchar(20) NOT NULL DEFAULT 'ADICION'"
        );

        console.log('2. carta_producto.es_adicion...');
        await anadirColumna(t, 'restaurante', 'carta_producto', 'es_adicion', 'boolean NOT NULL DEFAULT false');

        console.log('3. restaurante.carta_producto_adicion...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS restaurante.carta_producto_adicion (
                id_producto_adicion SERIAL PRIMARY KEY,
                -- El plato que ofrece la adición.
                id_producto  INTEGER  NOT NULL
                             REFERENCES restaurante.carta_producto(id_producto) ON DELETE CASCADE,
                -- La adición (otro producto, con es_adicion = true).
                id_adicion   INTEGER  NOT NULL
                             REFERENCES restaurante.carta_producto(id_producto) ON DELETE CASCADE,
                orden        SMALLINT NOT NULL DEFAULT 0,
                estado       CHAR(1)  NOT NULL DEFAULT 'A',
                fecha_creacion TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT ck_producto_adicion_distinta CHECK (id_producto <> id_adicion)
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS ux_producto_adicion
                 ON restaurante.carta_producto_adicion (id_producto, id_adicion);`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS ix_producto_adicion_adicion
                 ON restaurante.carta_producto_adicion (id_adicion);`,
            { transaction: t }
        );
        console.log('   OK');

        console.log('4. pedid_detalle.id_detalle_padre...');
        await anadirColumna(
            t,
            'restaurante',
            'pedid_detalle',
            'id_detalle_padre',
            'integer NULL REFERENCES restaurante.pedid_detalle(id_detalle) ON DELETE CASCADE'
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS ix_pedid_detalle_padre
                 ON restaurante.pedid_detalle (id_detalle_padre) WHERE id_detalle_padre IS NOT NULL;`,
            { transaction: t }
        );

        console.log('5. Trigger de auditoría de carta_producto_adicion...');
        const [fnAudit] = await sequelize.query(
            `SELECT 1 AS ok FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!fnAudit) {
            console.log('   ⚠️  auditoria.fn_audit no existe — se omite el trigger.');
        } else {
            await sequelize.query('DROP TRIGGER IF EXISTS trg_audit ON restaurante.carta_producto_adicion;', {
                transaction: t,
            });
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON restaurante.carta_producto_adicion
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_producto_adicion');`,
                { transaction: t }
            );
            console.log('   ✓');
        }

        await t.commit();
        console.log('\n✅ Migración de adiciones completada.');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en la migración (revertida):', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
