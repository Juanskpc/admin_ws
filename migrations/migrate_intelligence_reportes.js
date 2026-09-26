/**
 * `intelligence.reporte` — marcar a quien usa el asistente para nada.
 *
 * ## El problema que la obliga a existir
 *
 * Desde que el Nivel 4 contesta, cada turno cuesta tokens de verdad. Y un número de WhatsApp es
 * público: basta con que alguien descubra el del negocio para tener un modelo de lenguaje
 * gratis contestándole todo el día. No es malicia sofisticada —es aburrimiento con un teléfono—
 * y el negocio lo paga en la factura del mes.
 *
 * Lo que faltaba no era detectarlo: era **poder decirlo**. El dueño lo ve en su bandeja mucho
 * antes que cualquier métrica, y hasta ahora no tenía dónde ponerlo. Esta tabla es ese sitio.
 *
 * ## Por qué la fila guarda a la PERSONA y no solo el hilo
 *
 * La pregunta que se contesta es «¿esta persona vale la pena?», no «¿este hilo se torció?», y la
 * fila se escribe para contestar esa. Hoy las dos cuentas dan lo mismo —`uq_conversacion_canal`
 * garantiza una conversación por contacto y canal dentro de un negocio, y `asegurarConversacion`
 * reabre la que había en vez de crear otra—, así que esto no cambia ningún número todavía.
 *
 * Cambia dos cosas que sí importan: el conteo se pregunta **sin JOIN** (es lo que permite que la
 * lista traiga el contador en cada fila sin pagar una unión por conversación), y el día que un
 * contacto tenga más de un hilo —otro canal, hilos archivados— el número sigue significando
 * «esta persona» sin migrar nada.
 *
 * La identidad del contacto es `(id_negocio, canal, id_externo)` y **no** `id_persona_negocio`:
 * esa columna es NULL en la mayoría de las conversaciones (ADR-006 — todo funciona sin persona),
 * así que contar por ella sería contar casi siempre por NULL. Se guarda igualmente cuando la
 * hay, para que el día que exista el Portal del Cliente el histórico ya esté atado.
 *
 * Y el negocio va **dentro** de la identidad: dos inquilinos no comparten reputación. Que a
 * alguien lo reporte la barbería no puede ensuciarlo en el restaurante de al lado.
 *
 * ## Quién reporta: una persona o el propio asistente
 *
 * `origen` distingue las dos, y las dos cuentan igual de cara al total. El asistente reporta
 * cuando ve el patrón —mucho turno, ninguna acción, mucho costo— desde
 * `intelligence/engine/reporteAutomatico.js`. Lo que el asistente **no** hace nunca es bloquear:
 * un reporte es una opinión que alguien tendrá que mirar, no una sanción. Bloquear sigue siendo
 * `estado = 'bloqueada'`, sigue siendo cosa de un humano, y esta tabla no lo toca.
 *
 * ## Sin particionar, a propósito
 *
 * El resto del esquema (`turno`, `mensaje`, `paso`, `costo`) va particionado por mes porque
 * crece con cada mensaje. Un reporte es un acto deliberado: son unidades al mes, no miles. Y
 * particionarla impediría las dos UNIQUE parciales de abajo, que son lo que evita que diez clics
 * seguidos se conviertan en diez reportes.
 *
 * Idempotente: se puede reejecutar.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        // El esquema entero puede no existir en un entorno donde Intelligence no está montado.
        // Igual que el resto del módulo: no es una avería, es que aquí no toca.
        const [hay] = await sequelize.query(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'intelligence' AND table_name = 'conversacion' LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!hay) {
            console.log('El esquema intelligence no está en esta base. Nada que migrar.');
            await t.rollback();
            return;
        }

        console.log('1. Tabla intelligence.reporte...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.reporte (
                id_reporte       uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),

                -- Desde qué hilo se reportó. ON DELETE CASCADE: si la conversación se borra,
                -- el reporte pierde su contexto y no hay nada que revisar.
                id_conversacion  uuid NOT NULL
                                 REFERENCES intelligence.conversacion(id_conversacion)
                                 ON DELETE CASCADE,

                -- La identidad del contacto, denormalizada. Es por donde se cuenta, y por eso
                -- se copia en vez de leerse con un JOIN: la conversación puede cerrarse, y el
                -- conteo de la persona tiene que sobrevivirla.
                id_negocio       integer NOT NULL
                                 REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                canal            varchar(30) NOT NULL,
                id_externo       varchar(200) NOT NULL,

                -- Cuando la persona SÍ está identificada. NULL es lo normal (ADR-006).
                id_persona_negocio uuid
                                 REFERENCES platform.persona_negocio(id_persona_negocio)
                                 ON DELETE SET NULL,

                origen           varchar(12) NOT NULL,
                -- Quién lo puso, cuando lo puso una persona. NULL en los del asistente: nadie
                -- firma por él.
                id_usuario       integer
                                 REFERENCES general.gener_usuario(id_usuario) ON DELETE SET NULL,

                motivo           varchar(30) NOT NULL,
                nota             varchar(500),

                -- Lo que el asistente midió al reportar: turnos, costo, repeticiones. Es lo que
                -- se lee cuando alguien pregunta «¿y por qué dice el bot que este es un abuso?».
                -- Vacío en los reportes humanos: ahí la explicación es la nota.
                senales          jsonb NOT NULL DEFAULT '{}'::jsonb,

                estado           varchar(12) NOT NULL DEFAULT 'abierto',
                creado_en        timestamptz NOT NULL DEFAULT now(),
                revisado_en      timestamptz,
                id_usuario_revisor integer
                                 REFERENCES general.gener_usuario(id_usuario) ON DELETE SET NULL,

                CONSTRAINT chk_reporte_origen CHECK (origen IN ('humano', 'asistente')),
                CONSTRAINT chk_reporte_estado CHECK (estado IN ('abierto', 'revisado', 'descartado')),
                -- El catálogo vive en dos sitios y tiene que decir lo mismo: aquí y en
                -- app_admin_api/controllers/intelligenceBandejaController.js (MOTIVOS).
                -- 'sin_avance' y 'automatizado' son los que pone el asistente.
                CONSTRAINT chk_reporte_motivo CHECK (motivo IN (
                    'spam', 'abuso', 'fuera_de_tema', 'contenido_indebido',
                    'sin_avance', 'automatizado', 'otro'
                )),
                -- Un reporte humano lleva quién; uno del asistente, nadie. Si esto se relaja,
                -- el conteo deja de poder responder «¿quién dijo esto?».
                CONSTRAINT chk_reporte_autor CHECK (
                    (origen = 'humano'    AND id_usuario IS NOT NULL) OR
                    (origen = 'asistente' AND id_usuario IS NULL)
                )
            );
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        // La consulta que hace la bandeja en cada refresco: «¿cuántos lleva este contacto?».
        console.log('2. Índice del conteo por contacto...');
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_reporte_contacto
                ON intelligence.reporte (id_negocio, canal, id_externo);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_reporte_conversacion
                ON intelligence.reporte (id_conversacion);
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        // Dos clics en el botón son un reporte, no dos. La base lo garantiza en vez de fiarlo
        // al navegador: el refresco de cinco segundos ya hace que una petición repetida sea
        // normal, no excepcional.
        console.log('3. Un reporte abierto por autor y conversación...');
        await sequelize.query(
            `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reporte_humano_abierto
                ON intelligence.reporte (id_conversacion, id_usuario)
             WHERE estado = 'abierto' AND origen = 'humano';
            `,
            { transaction: t }
        );
        // Y el asistente no insiste: mientras su reporte siga abierto, no pone otro por el
        // mismo hilo aunque el patrón continúe. Lo contrario sería un contador de mensajes
        // disfrazado de reputación.
        await sequelize.query(
            `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reporte_asistente_abierto
                ON intelligence.reporte (id_conversacion)
             WHERE estado = 'abierto' AND origen = 'asistente';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await sequelize.query(
            `
            COMMENT ON TABLE intelligence.reporte IS
            'Reportes de mal uso del asistente. Se cuentan por contacto (id_negocio, canal, '
            'id_externo), no por conversación. origen=asistente los pone el motor; no bloquean.';
            `,
            { transaction: t }
        );

        // Regla fija del proyecto: tabla con estado → su trigger de auditoría en la MISMA
        // migración. Aquí además importa por sí misma: un reporte es una acusación, y quién la
        // puso, quién la revisó y cuándo cambió de estado es justo lo que habrá que mirar el día
        // que alguien discuta un bloqueo.
        console.log('4. Trigger de auditoría...');
        const [auditoria] = await sequelize.query(
            `SELECT 1 FROM information_schema.routines
              WHERE routine_schema = 'auditoria' AND routine_name = 'fn_audit' LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (auditoria) {
            await sequelize.query(
                `DROP TRIGGER IF EXISTS trg_audit ON intelligence.reporte;`,
                { transaction: t }
            );
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON intelligence.reporte
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_reporte');`,
                { transaction: t }
            );
            console.log('   ✓ trg_audit\n');
        } else {
            console.log('   (auditoria.fn_audit no está en esta base; se omite)\n');
        }

        await t.commit();
        console.log('✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

migrate()
    .then(() => sequelize.close())
    .catch(async (error) => {
        console.error('Falló la migración:', error.message);
        await sequelize.close();
        process.exit(1);
    });
