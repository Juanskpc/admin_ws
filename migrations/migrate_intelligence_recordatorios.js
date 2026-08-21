/**
 * F8-B — Lo que las reglas del canal le piden al Ledger: backoff, plantillas y recordatorios.
 *
 * Ejecutar con:
 *   npm run migrate:intelligence-recordatorios
 *
 * ## Por qué estas tres cosas van juntas
 *
 * Las tres salen de la misma frase del master-plan: «fuera de la ventana solo se pueden enviar
 * plantillas aprobadas. Un recordatorio de cita **es** una plantilla — hay que diseñarlo así desde
 * el principio, no descubrirlo después». El recordatorio necesita la plantilla, la plantilla
 * necesita saber si la ventana está abierta, y el primer canal remoto de verdad necesita que un
 * fallo no se reintente cinco veces en cinco segundos.
 *
 * ## `mensaje.proximo_intento_en`
 *
 * `gateway.js` dejó anotado desde F5-C que el backoff *no* se hacía, y por qué: «necesitaría una
 * columna `proximo_intento_en` en una tabla particionada de alto volumen, y hoy no compra nada: el
 * único canal es local y sus fallos son instantáneos. Cuando el primer canal remoto (WhatsApp)
 * empiece a devolver 429, esa columna será lo primero que haga falta». Ese día es hoy: con el
 * sondeo cada segundo y cinco intentos, un 429 de Meta agota el mensaje en cinco segundos y lo
 * manda a *dead letter* sin haber esperado nunca.
 *
 * ## `mensaje.plantilla`
 *
 * Un saliente con plantilla es el único que puede salir con la ventana de 24 h cerrada. Va en
 * columna propia —y no dentro de `crudo`— por el mismo motivo que `opciones` en F5-C: `crudo`
 * guarda lo que el canal traía y el Mensaje Canónico no representa; esto es una instrucción
 * nuestra de salida, y tiene que persistir porque la entrega es asíncrona y quien la renderiza lee
 * la fila mucho después de que se decidiera.
 *
 * Es `jsonb` y no un `varchar` con el nombre porque una plantilla de Meta es nombre + idioma +
 * parámetros posicionales: separarlos en tres columnas para volver a juntarlos al renderizar no
 * compra nada.
 *
 * ## `intelligence.recordatorio`
 *
 * Es la única tabla nueva, y estas son las tres cosas que ya existen y no servían:
 *
 *   - **No es un `mensaje`.** Un recordatorio programado para pasado mañana no es un saliente
 *     pendiente: el entregador no debe verlo, y el Ledger no debe contarlo como algo que ocurrió.
 *     Se convierte en `mensaje` cuando vence, y entonces sí atraviesa el camino de siempre.
 *   - **No es un evento del outbox.** El outbox transporta lo que *ya pasó*; esto es una promesa
 *     de futuro que además se puede **cancelar** (la cita se anula) o **mover** (se reagenda).
 *   - **No se puede derivar consultando la vertical.** Que `intelligence/` hiciera un `SELECT` a
 *     `reserva.reserva_cita` es exactamente la fuga que ADR-009 evita y que el canario de F9
 *     comprueba. Quien sabe leer una cita es el adaptador de la vertical, y lo que deja aquí es el
 *     hecho ya traducido: a quién, por qué canal, con qué plantilla y cuándo.
 *
 * `UNIQUE (id_negocio, referencia, plantilla)` es lo que hace idempotente la programación: el
 * outbox entrega **al menos una vez** (ADR-012), así que el mismo `cita.creada.v1` puede llegar
 * dos veces y no puede producir dos recordatorios.
 *
 * No se particiona, y es deliberado: F5-A partió `mensaje`, `turno` y `paso` porque crecen con
 * cada frase que alguien escribe. Aquí hay una fila por cita y deja de mirarse al enviarse.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F8-B: backoff, plantillas y recordatorios\n');

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

        // `ADD COLUMN IF NOT EXISTS` sobre la tabla particionada padre se propaga a todas las
        // particiones en un solo enunciado (ver la nota de la migración de F5-C).
        console.log('1. intelligence.mensaje.proximo_intento_en...');
        await sequelize.query(
            `
            ALTER TABLE intelligence.mensaje
                ADD COLUMN IF NOT EXISTS proximo_intento_en timestamptz;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. intelligence.mensaje.plantilla...');
        await sequelize.query(
            `
            ALTER TABLE intelligence.mensaje
                ADD COLUMN IF NOT EXISTS plantilla jsonb;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. intelligence.recordatorio...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.recordatorio (
                id_recordatorio uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                id_negocio      integer      NOT NULL
                                REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                canal           varchar(30)  NOT NULL,
                id_externo      varchar(200) NOT NULL,
                referencia      varchar(160) NOT NULL,
                plantilla       varchar(80)  NOT NULL,
                parametros      jsonb        NOT NULL DEFAULT '{}'::jsonb,
                enviar_en       timestamptz  NOT NULL,
                estado          varchar(20)  NOT NULL DEFAULT 'pendiente',
                intentos        integer      NOT NULL DEFAULT 0,
                id_mensaje      uuid,
                motivo          text,
                creado_en       timestamptz  NOT NULL DEFAULT now(),
                actualizado_en  timestamptz  NOT NULL DEFAULT now(),
                CONSTRAINT chk_recordatorio_estado
                    CHECK (estado IN ('pendiente', 'enviado', 'cancelado', 'fallido')),
                CONSTRAINT uq_recordatorio_referencia
                    UNIQUE (id_negocio, referencia, plantilla)
            );
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('4. Índice de los que vencen...');
        // Parcial sobre `pendiente`: a los dos días la inmensa mayoría está `enviado` y no se
        // vuelve a mirar nunca. Es el mismo criterio que `idx_mensaje_salida_pendiente`.
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_recordatorio_debido
                ON intelligence.recordatorio (enviar_en)
             WHERE estado = 'pendiente';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('5. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON COLUMN intelligence.mensaje.proximo_intento_en IS
            'No reintentar la entrega antes de este instante. NULL = ya. Existe porque Meta '
            'devuelve 429 y, con sondeo cada segundo, cinco intentos se agotan en cinco segundos.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN intelligence.mensaje.plantilla IS
            'Plantilla pre-aprobada con la que sale este mensaje: {nombre, idioma, parametros[]}. '
            'NULL = texto libre, que solo puede salir con la ventana de 24 h abierta (F8-B).';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN intelligence.mensaje.id_externo IS
            'Id del mensaje EN EL CANAL. En un entrante es el que llegó (deduplicación); en un '
            'saliente, el que devolvió el canal al aceptarlo — es lo que ata un acuse posterior '
            'a nuestra fila.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON TABLE intelligence.recordatorio IS
            'Mensajes proactivos programados: a quién, por qué canal, con qué plantilla y cuándo. '
            'Lo escribe el adaptador de la vertical al consumir un evento del outbox; lo drena el '
            'worker de recordatorios, que solo entonces crea el saliente (F8-B).';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON COLUMN intelligence.recordatorio.referencia IS
            'Qué lo originó, en el lenguaje de quien lo programó: "cita:<codigo_publico>". Junto '
            'con la plantilla es la clave de unicidad, y es lo que hace idempotente un evento que '
            'el outbox entrega al menos una vez.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ F8-B: columnas de entrega y tabla de recordatorios listas.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
