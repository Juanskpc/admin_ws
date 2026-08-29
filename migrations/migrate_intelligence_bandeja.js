/**
 * `intelligence.conversacion.atendida_en` — la marca de «ya me ocupé de esto».
 *
 * ## El fallo que la obliga a existir
 *
 * La Bandeja marcaba «espera respuesta» con `estado = 'handoff_humano'`. Y responder **pone**
 * ese estado, porque el bot tiene que callarse (ADR-023). O sea que al contestar, la
 * conversación seguía apareciendo como pendiente **para siempre**: la lista de lo que espera
 * solo podía crecer, y justo la acción de atenderla la dejaba marcada. Se vio a la primera
 * usándola en producción.
 *
 * ## Por qué una columna y no un estado nuevo
 *
 * La tentación era añadir `atendida` al CHECK de `estado`. Se descartó: `handoff_humano`
 * significa **«el bot no habla aquí»** y el motor lo trata como pasivo desde F5-B. Un estado
 * nuevo obligaría a enseñarle al motor que ése también es pasivo, y el día que a alguien se le
 * olvide, el asistente vuelve a hablar encima de una persona — que es el peor fallo que este
 * módulo puede tener.
 *
 * Son dos preguntas distintas y por eso son dos columnas:
 *   · `estado`      → ¿puede hablar el bot?        (lo decide el motor)
 *   · `atendida_en` → ¿le queda algo por hacer a una persona?  (lo decide la persona)
 *
 * Así ADR-023 queda intacto: marcar como atendida **no** devuelve la conversación al bot.
 *
 * ## Se rearma sola
 *
 * Si el cliente vuelve a escribir, `atendida_en` se pone a NULL en la ingesta y la conversación
 * reaparece en la bandeja. Sin eso, atender una vez la escondería para siempre y el siguiente
 * mensaje de esa persona no lo vería nadie.
 *
 * Idempotente: se puede reejecutar.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. Añadiendo intelligence.conversacion.atendida_en...');
        await Models.sequelize.query(
            `ALTER TABLE intelligence.conversacion
                 ADD COLUMN IF NOT EXISTS atendida_en timestamptz;`,
            { transaction: t }
        );

        // Índice parcial: la bandeja pregunta siempre por «lo que espera», que es la minoría de
        // las filas. Un índice sobre toda la tabla costaría escritura en cada mensaje para
        // acelerar una consulta que solo mira un puñado.
        console.log('2. Índice de lo que espera respuesta...');
        await Models.sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_conversacion_espera
                 ON intelligence.conversacion (id_negocio)
              WHERE estado = 'handoff_humano' AND atendida_en IS NULL;`,
            { transaction: t }
        );

        // Las que ya estaban escaladas ANTES de esto se dan por atendidas: son de antes de que
        // existiera la bandeja, nadie las va a contestar ya, y arrancar con una lista de
        // pendientes falsos enseña a ignorarla. Las nuevas empiezan en NULL y sí cuentan.
        console.log('3. Dando por atendidas las escaladas anteriores a la bandeja...');
        const [, meta] = await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET atendida_en = now()
              WHERE estado = 'handoff_humano' AND atendida_en IS NULL;`,
            { transaction: t }
        );
        console.log(`   ${meta?.rowCount ?? 0} conversación(es) marcadas.`);

        await t.commit();
        console.log('\n✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

migrate()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('Falló la migración:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
