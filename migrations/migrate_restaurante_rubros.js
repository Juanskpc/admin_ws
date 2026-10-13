/**
 * Restaurante — rubros de ingreso por categoría de la carta (2026-10-10).
 *
 * ## El problema
 *
 * Un restaurante que maneja tres tipos de comida —parrilla, sushi, pizza— quiere saber cuánto
 * deja cada uno al final del día y del mes. Lo que YA existía para esto eran las cajas
 * (`rest_punto_caja`, ver `migrate_restaurante_cajas.js`), y no sirven para este caso por dos
 * razones duras:
 *
 *   1. `pedid_orden.id_punto_caja` es NOT NULL: **una orden pertenece a una sola caja**. La mesa
 *      que pide de los tres sectores y paga una vez no se puede representar; habría que partir la
 *      cuenta en tres y cobrar tres veces.
 *   2. Las cajas cuentan contra el tope del plan y se venden como complemento
 *      (`puntoCajaService.exigirCupoDeCaja`). Cobrarle dos complementos a quien solo quiere ver
 *      sus tipos de comida separados es cobrar por una pregunta, no por una función.
 *
 * ## La diferencia de fondo: dónde vive la atribución
 *
 * La caja es de la **orden** (nivel pedido: su turno, su arqueo, su cajón). El rubro tiene que ser
 * del **ítem** (nivel producto), porque es lo único que deja repartir solo un pedido mixto:
 *
 *     pedid_detalle.subtotal → carta_producto.id_categoria → carta_categoria.id_rubro
 *
 * `carta_producto.id_categoria` es NOT NULL, así que la cadena cubre el 100% de los ítems
 * vendidos, histórico incluido: **no hay datos que retro-llenar**. El día que alguien cree sus
 * rubros y marque las categorías, los informes de los meses anteriores ya salen partidos.
 *
 * ## Por categoría y no por producto
 *
 * Una sola fuente de verdad. Con columna en las dos tablas aparece el estado imposible (producto
 * del rubro Sushi dentro de una categoría de Parrilla) y alguien tiene que decidir cuál gana, en
 * cada consulta, para siempre. Además es como piensa el negocio: «la parrilla» es un bloque de
 * categorías, no una selección suelta de productos. Si una categoría de verdad está partida entre
 * dos rubros, la respuesta es partir la categoría.
 *
 * ## `id_rubro NULL` = «General»
 *
 * Es el valor con el que nace todo lo que ya existe, y es imprescindible: las bebidas y el mecato
 * son de los tres sectores a la vez. En los informes salen agrupadas en una fila «General».
 *
 * ## La tabla nace VACÍA, y eso es la función
 *
 * Sin rubros creados no aparece nada nuevo en ninguna pantalla: ni la pestaña de informes, ni el
 * desglose del cierre de caja. «Solo para negocios que separen sectores» no necesita un
 * interruptor en `gener_negocio` — lo dice el propio dato. El negocio que no los usa nunca se
 * entera de que existen.
 *
 * ## Permiso
 *
 * Se reusa `caja_gestionar`, el subnivel que ya siembra `migrate_restaurante_cajas.js`. Rubros y
 * cajas son la misma decisión (cómo se parte el ingreso del negocio), la toma la misma persona en
 * la misma pantalla, y un subnivel nuevo exigiría sembrarlo en TRUE y desplegarlo ANTES del
 * frontend para no dejar la pestaña inaccesible. Leer los rubros no exige nada: los informes y el
 * cierre de caja los necesitan para pintarse.
 *
 * ## Eliminar un negocio
 *
 * La FK nueva (`carta_categoria.id_rubro` → `rest_rubro`) no toca el ciclo que rompía el borrado
 * (ver el gotcha de `gener_negocio.id_metodo_pago_domicilio`): no sale de la fila del negocio,
 * sino de una tabla que cuelga de él hacia otra que también cuelga de él. `construirPlan` lo
 * resuelve con su orden topológico de siempre. Además va `ON DELETE SET NULL`, así que borrar un
 * rubro deja sus categorías en «General» en vez de fallar. El centinela es
 * `__tests__/negocios/eliminar_orden.test.js`.
 *
 * Idempotente: `IF NOT EXISTS` e `information_schema` antes de cada ALTER.
 * Ejecutar con: node scripts/migrar.js restaurante-rubros
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function existeColumna(esquema, tabla, columna, t) {
    const filas = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna
          LIMIT 1;`,
        { replacements: { esquema, tabla, columna }, transaction: t, type: sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: rubros de ingreso del restaurante\n');

        // ── 1. El rubro ──────────────────────────────────────────────────────────────────
        //
        // Sin tope de plan a propósito: el rubro no añade turnos ni arqueos ni cajones, solo
        // agrupa lo que ya se vende. Lo que se cobra aparte son las cajas, que son otra cosa.
        console.log('1. restaurante.rest_rubro...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS restaurante.rest_rubro (
                id_rubro       serial      PRIMARY KEY,
                id_negocio     integer     NOT NULL
                               REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre         varchar(60) NOT NULL,
                descripcion    varchar(160),
                color          varchar(9),
                orden          smallint    NOT NULL DEFAULT 0,
                estado         char(1)     NOT NULL DEFAULT 'A',
                creado_en      timestamp   NOT NULL DEFAULT now(),
                actualizado_en timestamp   NOT NULL DEFAULT now(),

                CONSTRAINT uq_rest_rubro_nombre UNIQUE (id_negocio, nombre),
                CONSTRAINT chk_rest_rubro_estado CHECK (estado IN ('A','I'))
            );`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS ix_rest_rubro_negocio
                 ON restaurante.rest_rubro (id_negocio, estado);`,
            { transaction: t }
        );
        await sequelize.query(
            `COMMENT ON TABLE restaurante.rest_rubro IS
               'Sector de ingreso del negocio (Parrilla, Sushi, Pizza). Se atribuye por item via la categoria de la carta, para que un pedido mixto con un solo pago se reparta solo. No es una caja: no lleva turno ni arqueo ni tope de plan.';`,
            { transaction: t }
        );
        await sequelize.query(
            `COMMENT ON COLUMN restaurante.rest_rubro.color IS
               'Color #RRGGBB para las graficas de informes. NULL = lo asigna la paleta por defecto.';`,
            { transaction: t }
        );
        console.log('   lista (vacía: sin rubros no aparece nada nuevo en pantalla).');

        // ── 2. La categoría de la carta dice de qué rubro es ─────────────────────────────
        //
        // Nullable y sin relleno: todo lo que ya existe queda en NULL = «General». Es lo que hace
        // que el negocio que no usa rubros no note la migración.
        console.log('2. carta_categoria.id_rubro...');
        if (await existeColumna('restaurante', 'carta_categoria', 'id_rubro', t)) {
            console.log('   ya existía.');
        } else {
            await sequelize.query(
                `ALTER TABLE restaurante.carta_categoria
                   ADD COLUMN id_rubro integer
                   REFERENCES restaurante.rest_rubro(id_rubro) ON DELETE SET NULL;`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN restaurante.carta_categoria.id_rubro IS
                   'Sector de ingreso al que pertenece esta categoria. NULL = General: se vende en todos los sectores (bebidas, mecato).';`,
                { transaction: t }
            );
            console.log('   añadida (todo en NULL = «General»).');
        }

        // Índice parcial: la consulta de informes solo busca las categorías que SÍ tienen rubro,
        // y mientras nadie use la función el índice está vacío y no cuesta nada.
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS ix_carta_categoria_rubro
                 ON restaurante.carta_categoria (id_rubro) WHERE id_rubro IS NOT NULL;`,
            { transaction: t }
        );
        console.log('   indexada.');

        // ── 3. Auditoría ─────────────────────────────────────────────────────────────────
        //
        // Un rubro lleva estado y decide de qué lado cae la plata en los informes: mover una
        // categoría de sector cambia un número que alguien va a comparar contra el mes pasado.
        console.log('3. Trigger de auditoría...');
        const [[fn]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.routines
                  WHERE routine_schema = 'auditoria' AND routine_name = 'fn_audit'
             ) AS ok;`,
            { transaction: t }
        );
        if (!fn.ok) {
            console.log('   ⚠️  auditoria.fn_audit no existe — trigger omitido.');
        } else {
            await sequelize.query('DROP TRIGGER IF EXISTS trg_audit ON restaurante.rest_rubro;', {
                transaction: t,
            });
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON restaurante.rest_rubro
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_rubro');`,
                { transaction: t }
            );
            console.log('   ✓ restaurante.rest_rubro');
        }

        await t.commit();
        console.log('\n✅ Rubros listos. Nada cambia hasta que el negocio cree el primero.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Migración revertida:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
