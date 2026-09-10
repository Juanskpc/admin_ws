/**
 * País del negocio — `general.gener_negocio.pais`.
 *
 *   npm run migrate:pais-negocio
 *
 * ## Por qué hace falta una columna y no basta con deducirlo
 *
 * Hasta ahora EscalApp era, sin decirlo, una plataforma colombiana: `app_core/helpers/telefono.js`
 * solo sabía normalizar móviles de Colombia y devolvía `null` para todo lo demás. Como ese `null`
 * es un resultado *legítimo* («el teléfono no sirve»), un número perfectamente válido de otro país
 * no producía ningún error: la cita se guardaba con `id_persona_negocio = NULL`, el cliente nunca
 * se enlazaba con su ficha y el recordatorio no salía. Silencioso, otra vez.
 *
 * El primer cliente de reserva es chileno (2026-09-09), así que el país dejó de ser una constante.
 * No se puede deducir de ningún dato que ya tengamos —el NIT es opcional, la dirección es texto
 * libre y el prefijo del teléfono del negocio tampoco está normalizado—, de modo que se guarda.
 *
 * `DEFAULT 'CO'` y `NOT NULL`: los negocios existentes son todos colombianos y la columna no
 * cambia el comportamiento de ninguno. Es ISO 3166-1 alfa-2 en mayúsculas.
 *
 * Idempotente: comprueba `information_schema` antes del ALTER.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: país del negocio\n');

        console.log('1. Añadiendo general.gener_negocio.pais...');
        const [existe] = await sequelize.query(`
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'general' AND table_name = 'gener_negocio'
               AND column_name = 'pais';
        `, { transaction: t });

        if (existe.length === 0) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN pais CHAR(2) NOT NULL DEFAULT 'CO'
                CHECK (pais = upper(pais));
            `, { transaction: t });
            console.log('   Columna creada (todos los negocios quedan en CO).\n');
        } else {
            console.log('   Ya existe, omitiendo.\n');
        }

        await t.commit();
        console.log('✓ Migración país del negocio completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
