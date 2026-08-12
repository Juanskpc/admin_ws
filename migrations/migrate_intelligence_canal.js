/**
 * F5-C — Lo que la capa de canal le pide al Ledger: `opciones` y `enviado_en`.
 *
 * Ejecutar con:
 *   npm run migrate:intelligence-canal
 *
 * ## Por qué no estaban en F5-A
 *
 * F5-A diseñó el Ledger contra las doce preguntas de ADR-022, que son de observabilidad:
 * cuánto costó, qué falló, cuánto tardó. Estas dos columnas no responden a ninguna — son del
 * **contrato de canal** de [ADR-017](../docs/adr/ADR-017-channel-gateway.md), que solo se
 * concreta al escribir el primer adaptador. Añadirlas ahora es aditivo y sobre tablas vacías.
 *
 * ## `opciones`
 *
 * ADR-017: «las respuestas se expresan en términos abstractos (texto, y `opciones[]` para
 * elecciones), y **cada adaptador las renderiza según su canal**». En WhatsApp serán botones,
 * en el WebChat chips, en voz una enumeración hablada. El núcleo no sabe cómo se pinta una
 * opción, solo que la hay.
 *
 * Va en columna propia y no dentro de `crudo` porque son justo lo contrario: `crudo` guarda
 * lo que el canal traía y el Mensaje Canónico **no** representa; esto es Mensaje Canónico
 * puro. Y tiene que persistir porque la entrega es asíncrona: quien las renderiza lee la fila
 * mucho después de que el turno terminara.
 *
 * ## `enviado_en`
 *
 * Cuándo se envió el mensaje **según el canal**, que no es cuándo nos llegó. Sin esto, dos
 * mensajes reordenados por la red se agrupan en el turno en orden de llegada, y el asistente
 * lee «para mañana / quiero cita». [ADR-016](../docs/adr/ADR-016-webchat-hostil.md) pone
 * «reordenar dos mensajes» entre los fallos que el WebChat hostil inyecta a propósito: sin
 * esta columna, ese fallo no se puede ni detectar ni corregir.
 *
 * Es nullable y **no se confía en él a ciegas**: un canal que no lo aporte, o que mande una
 * marca absurda, cae de vuelta en `creado_en` (ver `repositorio.insertarMensajeEntrante`).
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F5-C: columnas de la capa de canal en intelligence.mensaje\n');

        const [tabla] = await sequelize.query(
            `
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'intelligence' AND table_name = 'mensaje';
            `,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!tabla) {
            throw new Error(
                'Falta intelligence.mensaje. Ejecuta antes: npm run migrate:intelligence-ledger'
            );
        }

        // `ADD COLUMN IF NOT EXISTS` sobre la tabla particionada padre se propaga a las 75
        // particiones en un solo enunciado. Con las tablas vacías es instantáneo; con 300M de
        // filas no lo sería, que es exactamente el argumento de freeze.md §C.5 para haber
        // particionado antes de tener datos.
        console.log('1. intelligence.mensaje.opciones...');
        await sequelize.query(
            `
            ALTER TABLE intelligence.mensaje
                ADD COLUMN IF NOT EXISTS opciones jsonb NOT NULL DEFAULT '[]'::jsonb;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. intelligence.mensaje.enviado_en...');
        await sequelize.query(
            `
            ALTER TABLE intelligence.mensaje
                ADD COLUMN IF NOT EXISTS enviado_en timestamptz;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON COLUMN intelligence.mensaje.opciones IS
            'Opciones de una respuesta, en abstracto (ADR-017). Cada adaptador las renderiza '
            'según su canal: botones en WhatsApp, chips en WebChat, enumeración en voz.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN intelligence.mensaje.enviado_en IS
            'Cuándo lo envió la persona SEGÚN EL CANAL, no cuándo llegó. Es lo que permite '
            'reconstruir el orden real de una ráfaga que la red entregó desordenada (ADR-016). '
            'Nullable y no fiable: fuera de una ventana razonable se ignora.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Columnas de canal añadidas.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
