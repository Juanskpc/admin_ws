/**
 * El **código público de una cita** deja de ser un UUID.
 *
 * `ed59d79c-195e-4e5a-b5de-e08bae99c2ac` es imposible de dictar por teléfono, de apuntar en un
 * papel o de teclear sin fallar, así que en la práctica el cliente solo podía consultar su cita
 * si conservaba el enlace. Los nuevos son 8 caracteres del alfabeto Base32 de Crockford, que se
 * enseñan partidos en dos (`K3M7-9QXP`); el detalle del formato y el porqué del alfabeto están
 * en `app_reserva_api/services/codigoCita.js`.
 *
 * ## Qué hace exactamente
 *
 *   1. Crea `reserva.fn_codigo_cita()`, que devuelve un código nuevo con el mismo alfabeto.
 *   2. Cambia el tipo de la columna de `UUID` a `VARCHAR(36)`.
 *   3. Sustituye el `DEFAULT gen_random_uuid()` por esa función.
 *
 * El camino normal es el de la aplicación —`citaService.generarCodigoLibre`, que además
 * comprueba que el código esté libre antes de insertar—, pero el DEFAULT se conserva a
 * propósito: hay inserciones por SQL crudo (las pruebas, y cualquier carga puntual) que no
 * pasan por el servicio, y sin default fallarían contra el NOT NULL. Usa `gen_random_bytes`
 * de pgcrypto, no `random()`: el código es la credencial con la que un cliente consulta y
 * cancela su cita, así que ni siquiera el camino de respaldo puede ser adivinable.
 *
 * ## Lo que NO hace: tocar las citas que ya existen
 *
 * Sus códigos se quedan como están. Un UUID cabe de sobra en `VARCHAR(36)` y el backend los
 * sigue aceptando, así que el enlace que un cliente recibió por WhatsApp la semana pasada sigue
 * funcionando. Reescribirlos habría sido romper justo eso —y también la referencia
 * `cita:<codigo_publico>` con la que el módulo de recordatorios identifica lo que ya envió— a
 * cambio de nada: son citas que ya pasaron o están a punto.
 *
 * El índice único `uq_reserva_cita_codigo` se conserva; PostgreSQL lo reconstruye solo al
 * cambiar el tipo de la columna.
 *
 * Idempotente: mira `information_schema` y no hace nada si la columna ya es de texto. Debe
 * correr ANTES de desplegar el backend nuevo — con la columna todavía en UUID, insertar un
 * código de 8 caracteres falla.
 *
 *   npm run migrate:reserva-codigo-corto
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: código público corto en reserva.reserva_cita ===\n');

        const [[columna]] = await sequelize.query(`
            SELECT data_type, character_maximum_length AS largo, column_default AS por_defecto
            FROM information_schema.columns
            WHERE table_schema = 'reserva' AND table_name = 'reserva_cita'
              AND column_name = 'codigo_publico';
        `, { transaction: t });

        if (!columna) throw new Error('No existe reserva.reserva_cita.codigo_publico.');

        console.log('1. Creando reserva.fn_codigo_cita()...');
        await sequelize.query(`
            CREATE EXTENSION IF NOT EXISTS pgcrypto;

            -- 8 símbolos del Base32 de Crockford. El módulo 32 no sesga porque 256 es
            -- múltiplo exacto de 32: cada símbolo sale de ocho valores de byte.
            CREATE OR REPLACE FUNCTION reserva.fn_codigo_cita() RETURNS VARCHAR
            LANGUAGE sql VOLATILE AS $fn$
                SELECT string_agg(
                           substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                                  1 + (get_byte(s.bytes, i) % 32), 1),
                           '' ORDER BY i)
                FROM (SELECT gen_random_bytes(8) AS bytes) s,
                     generate_series(0, 7) AS i;
            $fn$;
        `, { transaction: t });
        console.log('   OK\n');

        if (columna.data_type === 'character varying') {
            console.log('2. La columna ya es VARCHAR — no se toca el tipo.\n');
        } else {
            console.log(`2. Tipo actual: ${columna.data_type}. Cambiando a VARCHAR(36)...`);
            // El DEFAULT viejo se quita primero: gen_random_uuid() devuelve UUID y bloquearía
            // el cambio de tipo de la columna.
            await sequelize.query(`
                ALTER TABLE reserva.reserva_cita ALTER COLUMN codigo_publico DROP DEFAULT;
                ALTER TABLE reserva.reserva_cita
                    ALTER COLUMN codigo_publico TYPE VARCHAR(36) USING codigo_publico::text;
            `, { transaction: t });
            console.log('   OK — los códigos existentes se conservan tal cual.\n');
        }

        console.log('3. Fijando el DEFAULT nuevo...');
        await sequelize.query(`
            ALTER TABLE reserva.reserva_cita
                ALTER COLUMN codigo_publico SET DEFAULT reserva.fn_codigo_cita();
        `, { transaction: t });
        console.log('   OK\n');

        await t.commit();

        const [[estado]] = await sequelize.query(`
            SELECT c.data_type, c.character_maximum_length AS largo, c.column_default AS por_defecto,
                   (SELECT count(*) FROM reserva.reserva_cita) AS citas,
                   (SELECT count(*) FROM reserva.reserva_cita WHERE length(codigo_publico) = 8) AS cortos
            FROM information_schema.columns c
            WHERE c.table_schema = 'reserva' AND c.table_name = 'reserva_cita'
              AND c.column_name = 'codigo_publico';
        `);

        const [indices] = await sequelize.query(`
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'reserva' AND tablename = 'reserva_cita'
              AND indexname = 'uq_reserva_cita_codigo';
        `);

        console.log('=== Resultado ===');
        console.log(`   tipo: ${estado.data_type}(${estado.largo})`);
        console.log(`   default: ${estado.por_defecto || 'ninguno (lo pone la aplicación)'}`);
        console.log(`   índice único presente: ${indices.length ? 'sí' : 'NO — revísalo'}`);
        console.log(`   citas: ${estado.citas} (${estado.cortos} ya con código corto)`);
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
