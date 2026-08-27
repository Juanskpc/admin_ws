/**
 * Migración: a dónde se paga, y métodos por defecto para quien no tiene ninguno.
 *
 *  1. Agrega restaurante.rest_metodo_pago.datos_pago — el número de Nequi, la cuenta del banco,
 *     lo que el cliente necesita para poder pagar. Texto libre y no columnas por banco: cada
 *     negocio lo dice a su manera y ninguna estructura sobrevive al segundo cliente.
 *  2. Siembra «Efectivo» y «Transferencia» en los restaurantes que no tienen ni uno.
 *
 * ## Por qué el sembrado es una migración y no un valor por defecto en el código
 *
 * Porque un valor por defecto escondido en el bot es **invisible y no se puede editar**. Un
 * negocio que ofrece efectivo y transferencia y no lo sabe no puede quitar la transferencia el
 * día que deje de aceptarla, ni ponerle su número de cuenta. Sembrando filas de verdad, el dueño
 * las ve en su pantalla de configuración, las cambia y las borra — y la orden guarda un
 * `id_metodo_pago` real en vez de un nulo con significado.
 *
 * El caso que lo motivó: el 2026-08-27 el asistente saltó el paso del pago en seis pedidos
 * seguidos, correctamente, porque el negocio tenía cero métodos configurados. Correcto y
 * malísimo — un pedido a domicilio en el que nadie dice cómo se paga es una discusión en la
 * puerta.
 *
 * Idempotente. Ejecutar con: npm run migrate:restaurante-datos-pago
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Lo que se siembra. `datos_pago` va vacío: nadie puede adivinar el número de cuenta ajeno. */
const POR_DEFECTO = [
    { nombre: 'Efectivo', datos: null },
    { nombre: 'Transferencia', datos: null },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Datos de pago y métodos por defecto\n');

        // ── 1. La columna ────────────────────────────────────────────────────────────────
        console.log('1. Agregando restaurante.rest_metodo_pago.datos_pago...');
        const [cols] = await sequelize.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema='restaurante' AND table_name='rest_metodo_pago'
                AND column_name='datos_pago';`,
            { transaction: t }
        );
        if (cols.length === 0) {
            await sequelize.query(
                `ALTER TABLE restaurante.rest_metodo_pago ADD COLUMN datos_pago VARCHAR(200);`,
                { transaction: t }
            );
            console.log('   OK — columna creada.\n');
        } else {
            console.log('   Ya existía, no se toca.\n');
        }

        // ── 2. Los métodos por defecto ───────────────────────────────────────────────────
        //
        // Solo a los restaurantes que no tienen NINGUNO. A quien ya configuró los suyos no se
        // le añade nada: sembrar «Efectivo» en un negocio que solo acepta transferencia sería
        // ponerle en la boca al bot algo que el dueño no dijo.
        console.log('2. Sembrando métodos por defecto donde no hay ninguno...');
        const [restaurantes] = await sequelize.query(
            `SELECT n.id_negocio, n.nombre
               FROM general.gener_negocio n
               JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
              WHERE UPPER(TRIM(tn.nombre)) = 'RESTAURANTE'
                AND NOT EXISTS (
                    SELECT 1 FROM restaurante.rest_metodo_pago m
                     WHERE m.id_negocio = n.id_negocio AND m.estado = 'A'
                )
              ORDER BY n.id_negocio;`,
            { transaction: t }
        );

        if (restaurantes.length === 0) {
            console.log('   Ninguno lo necesita.\n');
        } else {
            for (const negocio of restaurantes) {
                for (const metodo of POR_DEFECTO) {
                    // El índice único es parcial (`WHERE estado = 'A'`), así que `ON CONFLICT`
                    // no lo puede usar como árbitro. Se comprueba a mano, que además respeta el
                    // caso de un método inactivo con el mismo nombre: reactivarlo no es cosa de
                    // una migración.
                    const [existe] = await sequelize.query(
                        `SELECT 1 FROM restaurante.rest_metodo_pago
                          WHERE id_negocio = :id AND LOWER(nombre) = LOWER(:nombre);`,
                        { replacements: { id: negocio.id_negocio, nombre: metodo.nombre }, transaction: t }
                    );
                    if (existe.length > 0) continue;

                    await sequelize.query(
                        `INSERT INTO restaurante.rest_metodo_pago (id_negocio, nombre, datos_pago, estado)
                         VALUES (:id, :nombre, :datos, 'A');`,
                        {
                            replacements: {
                                id: negocio.id_negocio,
                                nombre: metodo.nombre,
                                datos: metodo.datos,
                            },
                            transaction: t,
                        }
                    );
                }
                console.log(`   → negocio ${negocio.id_negocio} (${negocio.nombre}): sembrado.`);
            }
            console.log(`   OK — ${restaurantes.length} negocio(s).\n`);
        }

        await t.commit();
        console.log('✔ Migración completada.');
    } catch (error) {
        await t.rollback();
        console.error('✘ Migración fallida:', error.message);
        throw error;
    } finally {
        await sequelize.close();
    }
}

migrate().catch(() => process.exit(1));
