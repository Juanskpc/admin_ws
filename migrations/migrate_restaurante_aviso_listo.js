/**
 * Migración: el aviso de «tu pedido ya está listo».
 *
 *  - restaurante.pedid_orden.aviso_listo_en  (TIMESTAMP NULL)
 *      Cuándo se INTENTÓ avisarle al cliente. NULL = todavía no se ha intentado.
 *  - restaurante.pedid_orden.aviso_listo_mensaje  (UUID NULL)
 *      Qué mensaje fue ese aviso, para poder mirar si de verdad salió.
 *
 * ## Por qué son dos columnas y no una
 *
 * Añadida el 2026-09-08, tras verlo fallar en producción: la marca dice «se intentó», y eso NO
 * es lo mismo que «llegó». El primer aviso real quedó marcado, el botón se apagó, y el mensaje
 * murió en dead letter porque la plantilla todavía no existía en Meta — así que el negocio creyó
 * haber avisado a alguien que nunca recibió nada. Guardando cuál fue el mensaje, la pantalla
 * puede leer su estado de entrega y decir la verdad: avisado, en camino, o no se pudo.
 *
 * ## Por qué una columna y no un contador en otro sitio
 *
 * Porque lo que hay que impedir es **apretar el botón dos veces**, y cada envío de plantilla se
 * le cobra al negocio: dos clics son dos cobros y dos mensajes al cliente. La marca tiene que
 * vivir donde vive la decisión —la orden— y escribirse en la MISMA transacción que crea el
 * saliente, o el candado no cierra nada.
 *
 * Es un instante y no un booleano por la razón de siempre: «sí» no dice cuándo, y la primera
 * pregunta que hace alguien mirando un pedido que no recogieron es a qué hora le avisaron.
 * Cuesta lo mismo guardarlo.
 *
 * Timestamp sin huso, como todo en este esquema: la sesión de Postgres está en `America/Bogota`
 * y estas columnas son hora de pared de Bogotá (ver `app_core/models/conection.js`).
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-aviso-listo
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Agrega una columna solo si aún no existe (guarda por information_schema). */
async function agregarColumna({ esquema, tabla, columna, definicion, transaction }) {
    const [existe] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction });

    if (existe.length > 0) {
        console.log(`   • ${esquema}.${tabla}.${columna} ya existía, se omite`);
        return;
    }

    await sequelize.query(
        `ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${definicion};`,
        { transaction }
    );
    console.log(`   ✓ ${esquema}.${tabla}.${columna} creada`);
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Aviso de pedido listo\n');

        console.log('1. Marca del aviso en la orden...');
        await agregarColumna({
            esquema: 'restaurante', tabla: 'pedid_orden', columna: 'aviso_listo_en',
            definicion: 'TIMESTAMP NULL', transaction: t,
        });
        await agregarColumna({
            esquema: 'restaurante', tabla: 'pedid_orden', columna: 'aviso_listo_mensaje',
            definicion: 'UUID NULL', transaction: t,
        });

        // pedid_orden ya lleva su trigger trg_audit desde migrate_auditoria_*: una columna
        // nueva entra sola en el snapshot JSONB.

        await t.commit();
        console.log('\n✓ Migración Aviso de pedido listo completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
