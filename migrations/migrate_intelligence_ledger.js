/**
 * F5-A — Esquema `intelligence`: Conversation Engine + Ledger de decisiones y costos.
 *
 * Ejecutar con:
 *   npm run migrate:intelligence-ledger
 *
 * ## Por qué esto va primero, antes que una línea de motor
 *
 * [ADR-022](../docs/adr/ADR-022-observabilidad.md): «El Ledger es de escritura única e
 * **irreversible**: su esquema debe nacer completo en F5 porque los datos no registrados no
 * se recuperan». Lo que hoy no se guarde, ninguna consulta futura lo podrá responder.
 *
 * Por eso el esquema no se diseña «a ver qué hará falta», sino contra una especificación
 * literal: **las doce preguntas** que el Ledger debe poder contestar. Están escritas como
 * SQL ejecutable en `scripts/ledger_doce_preguntas.js` y como test en
 * `__tests__/intelligence/ledger.test.js`. Si el esquema no las responde, está mal.
 *
 * ## Decisiones que implementa (no las toma — ver los ADRs)
 *
 *   ADR-004  `intelligence` es extraíble: **cero FK hacia esquemas de vertical**. Las
 *            referencias a una entidad de negocio son lógicas: `(vertical, entidad, id)`.
 *   ADR-014  la estructura es Contacto → Conversación → Turno → Pasos.
 *   ADR-022  el Ledger se escribe con estándar contable, no de telemetría.
 *   ADR-024  PK en UUID v7; `timestamptz` en UTC (aquí NO se usa el wall-time de las
 *            verticales: son datos de máquina, críticos en ordenamiento); particionado
 *            declarativo mensual de las tablas de alto volumen, con las tablas vacías.
 *   freeze.md §C.5  particionar 300M de filas en caliente es brutal; hacerlo hoy es gratis.
 *
 * ## Una contradicción entre ADRs, resuelta aquí
 *
 * ADR-022 llama `tool_call` a uno de los componentes del Ledger. ADR-008 prohíbe la palabra
 * «tool» fuera del adaptador del `ModelPort` — «si aparece en el núcleo, es síntoma de que
 * una abstracción se filtró». Un nombre de tabla es para siempre, así que gana ADR-008, que
 * es una regla de vocabulario explícita y con enforcement declarado, frente a un nombre que
 * ADR-022 usa de pasada. La tabla es **`intelligence.invocacion_capacidad`**.
 *
 * ## Por qué casi no hay claves foráneas entre estas tablas
 *
 * Las tablas del Ledger son particionadas y de alto volumen. Una FK entre dos tablas
 * particionadas exige una clave compuesta con la columna de partición y añade contención de
 * locks en el camino más caliente del sistema, a cambio de una integridad que aquí no
 * compra nada: nadie edita un Ledger, solo se le añade. Las FK se quedan donde sí valen:
 * hacia `general.gener_negocio` y hacia `conversacion`, que no está particionada.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Meses de particiones que se crean por adelantado. Ver el aviso del final. */
const MESES_POR_ADELANTADO = 15;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F5-A: esquema intelligence (Conversation Engine + Ledger)\n');

        const [platform] = await sequelize.query(
            `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!platform) {
            throw new Error('Falta el esquema platform. Ejecuta antes: npm run migrate:platform-persona');
        }

        console.log('1. Esquema intelligence...');
        await sequelize.query('CREATE SCHEMA IF NOT EXISTS intelligence;', { transaction: t });
        console.log('   OK\n');

        // ── Conversación ────────────────────────────────────────────────────────────────
        console.log('2. intelligence.conversacion...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.conversacion (
                id_conversacion   uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                id_negocio        integer NOT NULL
                                  REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                canal             varchar(30) NOT NULL,
                -- Quién es, del lado del canal: el número de WhatsApp, el id de sesión del
                -- WebChat. Es la identidad DEL CANAL, no la de la plataforma.
                id_externo        varchar(200) NOT NULL,

                -- Quién es, del lado de la plataforma. Nullable a propósito: una conversación
                -- empieza antes de saber con quién se habla, y ADR-006 dice que todo funciona
                -- sin persona.
                --
                -- Apunta a persona_negocio y no a persona aunque bounded-contexts.md
                -- nombre esta última: ADR-025 es posterior y deja persona VACÍA hasta el
                -- Portal del Cliente, así que apuntar ahí sería apuntar a una tabla vacía
                -- para siempre. persona_negocio es la tabla operativa. La regla que importa
                -- —intelligence no referencia verticales— se respeta igual: esto es platform.
                id_persona_negocio uuid REFERENCES platform.persona_negocio(id_persona_negocio)
                                   ON DELETE SET NULL,

                estado            varchar(20) NOT NULL DEFAULT 'activa',
                -- Variables de sesión del motor (a qué paso del menú va, qué ya preguntó).
                -- JSONB y no columnas porque su forma cambia con cada flujo y no se consulta
                -- por ellas: se leen enteras al retomar el turno.
                variables         jsonb NOT NULL DEFAULT '{}'::jsonb,

                -- Tarea en curso (ADR-014: la conversación es infinita, la tarea es acotada y
                -- retomable días después). Es lo que permite «lo dejamos a medias el martes».
                tarea_actual      varchar(60),
                tarea_datos       jsonb NOT NULL DEFAULT '{}'::jsonb,

                creado_en         timestamptz NOT NULL DEFAULT now(),
                ultimo_mensaje_en timestamptz,
                cerrado_en        timestamptz,

                CONSTRAINT chk_conversacion_estado CHECK (estado IN (
                    'activa', 'dormida', 'handoff_humano', 'bloqueada', 'suspendida', 'cerrada'
                )),
                -- Una conversación por interlocutor y canal dentro de un negocio. Es lo que
                -- hace que el segundo mensaje de alguien caiga en su hilo y no abra otro.
                CONSTRAINT uq_conversacion_canal UNIQUE (id_negocio, canal, id_externo)
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_conversacion_activas
                ON intelligence.conversacion (id_negocio, ultimo_mensaje_en DESC)
                WHERE estado IN ('activa', 'dormida');
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Deduplicación de ingesta ────────────────────────────────────────────────────
        console.log('3. intelligence.ingesta_recibida (deduplicación)...');
        // Sin partición A PROPÓSITO. Una UNIQUE sobre una tabla particionada obliga a incluir
        // la columna de partición, y entonces el mismo `id_externo` en dos meses distintos no
        // colisionaría: justo lo contrario de lo que hace falta. La deduplicación necesita
        // una garantía GLOBAL, así que vive en su propia tabla pequeña y acotada por retención.
        //
        // ADR-016 lista «duplicar un mensaje entrante» entre los fallos que el WebChat hostil
        // inyecta: esta tabla es lo que hace que ese fallo se cace en vez de crear dos mensajes.
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.ingesta_recibida (
                id_negocio   integer NOT NULL
                             REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                canal        varchar(30) NOT NULL,
                id_externo   varchar(200) NOT NULL,
                id_mensaje   uuid NOT NULL,
                recibido_en  timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (id_negocio, canal, id_externo)
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_ingesta_recibida_purga ON intelligence.ingesta_recibida (recibido_en);`,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Turno ───────────────────────────────────────────────────────────────────────
        console.log('4. intelligence.turno (particionada)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.turno (
                id_turno        uuid NOT NULL DEFAULT platform.uuid_generate_v7(),
                id_conversacion uuid NOT NULL,
                -- Denormalizado a propósito: «costo por negocio» no debe pagar un JOIN contra
                -- una tabla no particionada por cada fila de un mes entero.
                id_negocio      integer NOT NULL,
                secuencia       integer NOT NULL,

                -- PREGUNTA 12: ratio determinista-vs-IA. Es la columna que la responde, y es
                -- la razón por la que existe desde el día uno aunque hoy todo sea 'determinista'.
                nivel           varchar(20) NOT NULL DEFAULT 'determinista',

                estado          varchar(20) NOT NULL DEFAULT 'procesando',
                -- PREGUNTA 11: tasa de resolución. PREGUNTA 8: errores.
                resultado       varchar(20),
                error_codigo    varchar(60),
                error_detalle   text,
                -- PREGUNTA 9: reintentos.
                intentos        integer NOT NULL DEFAULT 1,

                -- PREGUNTA 5: latencia. Se guarda calculada y no se deriva al consultar:
                -- un turno que muere sin terminar no tiene fin, y su latencia es un dato
                -- distinto de «todavía no ha acabado».
                latencia_ms     integer,

                creado_en       timestamptz NOT NULL DEFAULT now(),
                terminado_en    timestamptz,

                PRIMARY KEY (id_turno, creado_en),
                CONSTRAINT chk_turno_nivel CHECK (nivel IN ('determinista', 'llm', 'humano')),
                CONSTRAINT chk_turno_estado CHECK (estado IN ('procesando', 'terminado', 'abandonado')),
                CONSTRAINT chk_turno_resultado CHECK (
                    resultado IS NULL OR resultado IN ('resuelto', 'error', 'handoff', 'sin_respuesta')
                )
            ) PARTITION BY RANGE (creado_en);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_turno_conversacion ON intelligence.turno (id_conversacion, secuencia);`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_turno_negocio ON intelligence.turno (id_negocio, creado_en DESC);`,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Mensaje ─────────────────────────────────────────────────────────────────────
        console.log('5. intelligence.mensaje (particionada)...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.mensaje (
                id_mensaje      uuid NOT NULL DEFAULT platform.uuid_generate_v7(),
                id_conversacion uuid NOT NULL,
                id_negocio      integer NOT NULL,
                -- Nullable: un mensaje entrante existe antes de que el debounce decida a qué
                -- turno pertenece, y un turno agrupa varios mensajes.
                id_turno        uuid,

                direccion       varchar(10) NOT NULL,
                canal           varchar(30) NOT NULL,
                -- Id del mensaje en el canal de origen. La deduplicación dura vive en
                -- ingesta_recibida; aquí se guarda para poder rastrear.
                id_externo      varchar(200),
                contenido       text NOT NULL,
                -- Lo que el canal traía y el Mensaje Canónico no representa (ADR-017). Caduca
                -- rápido: es lo primero que la retención tira.
                crudo           jsonb,

                -- Entrega asíncrona (ADR-016): un mensaje saliente se encola y se entrega
                -- después, con reintentos. PREGUNTA 9.
                estado_entrega  varchar(20),
                intentos_entrega integer NOT NULL DEFAULT 0,
                entregado_en    timestamptz,

                creado_en       timestamptz NOT NULL DEFAULT now(),

                PRIMARY KEY (id_mensaje, creado_en),
                CONSTRAINT chk_mensaje_direccion CHECK (direccion IN ('entrante', 'saliente')),
                CONSTRAINT chk_mensaje_entrega CHECK (
                    estado_entrega IS NULL OR estado_entrega IN ('pendiente', 'entregado', 'fallido')
                )
            ) PARTITION BY RANGE (creado_en);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_mensaje_conversacion ON intelligence.mensaje (id_conversacion, creado_en);`,
            { transaction: t }
        );
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_mensaje_salida_pendiente
                ON intelligence.mensaje (creado_en)
                WHERE direccion = 'saliente' AND estado_entrega = 'pendiente';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Paso ────────────────────────────────────────────────────────────────────────
        console.log('6. intelligence.paso (particionada)...');
        // El cuarto nivel de ADR-014 y la «decision» del Ledger de ADR-022: qué decidió el
        // motor y por qué. Un turno determinista tiene un paso; uno con LLM tendrá varios
        // (pensar → invocar → pensar → responder). Se modela en plural desde hoy porque
        // añadir la tabla después obligaría a inventarse los pasos que no se registraron.
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.paso (
                id_paso     uuid NOT NULL DEFAULT platform.uuid_generate_v7(),
                id_turno    uuid NOT NULL,
                id_negocio  integer NOT NULL,
                secuencia   integer NOT NULL,

                tipo        varchar(30) NOT NULL,
                -- Qué se decidió, en lenguaje del motor: la regla que casó, la intención
                -- detectada, el estado al que se transitó.
                decision    varchar(80),
                -- Por qué. Es lo que se lee cuando «el bot hizo algo raro».
                motivo      jsonb NOT NULL DEFAULT '{}'::jsonb,

                latencia_ms integer,
                creado_en   timestamptz NOT NULL DEFAULT now(),

                PRIMARY KEY (id_paso, creado_en),
                CONSTRAINT chk_paso_tipo CHECK (tipo IN (
                    'clasificacion', 'regla', 'capacidad', 'respuesta', 'handoff', 'error'
                ))
            ) PARTITION BY RANGE (creado_en);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_paso_turno ON intelligence.paso (id_turno, secuencia);`,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Invocación de capacidad ─────────────────────────────────────────────────────
        console.log('7. intelligence.invocacion_capacidad (particionada)...');
        // Lo que ADR-022 llama `tool_call`. Se llama así por ADR-008: «tool» solo existe en
        // el adaptador del proveedor de modelos.
        //
        // Duplica información del rastro que el Policy Gate ya deja en `auditoria.audit_evento`,
        // y es a propósito: aquello es auditoría de plataforma (quién hizo qué) y esto es el
        // Ledger conversacional (qué pasó dentro de este turno y cuánto costó). Cruzarlos
        // obligaría a que el Ledger dependiera del esquema de auditoría, que no es suyo.
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.invocacion_capacidad (
                id_invocacion uuid NOT NULL DEFAULT platform.uuid_generate_v7(),
                id_turno      uuid NOT NULL,
                id_conversacion uuid NOT NULL,
                id_negocio    integer NOT NULL,

                -- PREGUNTAS 6 y 7: cuántas invocaciones y qué capacidades.
                capacidad     varchar(80) NOT NULL,
                vertical      varchar(30) NOT NULL,
                argumentos    jsonb NOT NULL DEFAULT '{}'::jsonb,

                -- PREGUNTA 8: errores.
                resultado     varchar(20) NOT NULL,
                error_codigo  varchar(60),
                dry_run       boolean NOT NULL DEFAULT false,

                latencia_ms   integer,
                creado_en     timestamptz NOT NULL DEFAULT now(),

                PRIMARY KEY (id_invocacion, creado_en),
                CONSTRAINT chk_invocacion_resultado CHECK (resultado IN ('ok', 'error', 'denegado'))
            ) PARTITION BY RANGE (creado_en);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_invocacion_turno ON intelligence.invocacion_capacidad (id_turno);`,
            { transaction: t }
        );
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_invocacion_negocio
                ON intelligence.invocacion_capacidad (id_negocio, capacidad, creado_en DESC);
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Costo ───────────────────────────────────────────────────────────────────────
        console.log('8. intelligence.costo (particionada)...');
        // Nace VACÍA y se queda vacía durante toda F5: sin LLM no hay costo. Se crea igual
        // porque ADR-022 lo exige — el Ledger es irreversible y lo que no se registre hoy no
        // se recupera — y porque F5 debe poder demostrar que el costo es $0.00, que es un
        // criterio de aceptación de la fase, no una ausencia de dato.
        //
        // Es la única tabla del proyecto que se salta el test de simplicidad, y lo hace con
        // un ADR explícito detrás.
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS intelligence.costo (
                id_costo        uuid NOT NULL DEFAULT platform.uuid_generate_v7(),
                id_turno        uuid NOT NULL,
                id_conversacion uuid NOT NULL,
                id_negocio      integer NOT NULL,

                -- PREGUNTA 3: modelo usado.
                proveedor       varchar(40) NOT NULL,
                modelo          varchar(80) NOT NULL,

                -- PREGUNTA 4: tokens. Las dos columnas de caché existen desde hoy porque la
                -- tasa de acierto de caché es la métrica que más dinero mueve (ADR-019) y
                -- añadirlas después dejaría un agujero en el histórico.
                tokens_entrada        integer NOT NULL DEFAULT 0,
                tokens_salida         integer NOT NULL DEFAULT 0,
                tokens_cache_lectura  integer NOT NULL DEFAULT 0,
                tokens_cache_escritura integer NOT NULL DEFAULT 0,

                -- PREGUNTAS 1 y 2: costo por conversación y por negocio.
                --
                -- numeric(14,8) y no float: esto factura. Un céntimo perdido por redondeo en
                -- coma flotante, multiplicado por millones de turnos, es un descuadre que
                -- nadie sabe explicar. Ocho decimales porque el precio por token es minúsculo.
                costo_usd       numeric(14,8) NOT NULL DEFAULT 0,

                latencia_ms     integer,
                creado_en       timestamptz NOT NULL DEFAULT now(),

                PRIMARY KEY (id_costo, creado_en)
            ) PARTITION BY RANGE (creado_en);
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_costo_turno ON intelligence.costo (id_turno);`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_costo_negocio ON intelligence.costo (id_negocio, creado_en DESC);`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_costo_conversacion ON intelligence.costo (id_conversacion);`,
            { transaction: t }
        );
        console.log('   OK\n');

        // ── Particiones ─────────────────────────────────────────────────────────────────
        console.log('9. Función intelligence.asegurar_particiones()...');
        // Una tabla particionada SIN la partición del mes en curso rechaza todo INSERT con
        // «no partition of relation found for row». Es un fallo de producción a medianoche
        // del día 1, silencioso hasta que ocurre, y por eso la función existe desde la misma
        // migración que crea las tablas y no «cuando haga falta».
        await sequelize.query(
            `
            CREATE OR REPLACE FUNCTION intelligence.asegurar_particiones(
                p_meses integer DEFAULT 3,
                p_desde date DEFAULT NULL
            )
            RETURNS integer
            LANGUAGE plpgsql
            AS $func$
            DECLARE
                v_tabla     text;
                v_inicio    date;
                v_fin       date;
                v_nombre    text;
                v_creadas   integer := 0;
                v_base      date := date_trunc('month', COALESCE(p_desde, current_date))::date;
            BEGIN
                FOREACH v_tabla IN ARRAY ARRAY['turno', 'mensaje', 'paso', 'invocacion_capacidad', 'costo']
                LOOP
                    FOR i IN 0..(p_meses - 1) LOOP
                        v_inicio := (v_base + (i || ' months')::interval)::date;
                        v_fin    := (v_inicio + interval '1 month')::date;
                        v_nombre := format('%s_%s', v_tabla, to_char(v_inicio, 'YYYY_MM'));

                        IF NOT EXISTS (
                            SELECT 1 FROM pg_class c
                              JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = 'intelligence' AND c.relname = v_nombre
                        ) THEN
                            EXECUTE format(
                                'CREATE TABLE intelligence.%I PARTITION OF intelligence.%I '
                                'FOR VALUES FROM (%L) TO (%L)',
                                v_nombre, v_tabla, v_inicio, v_fin
                            );
                            v_creadas := v_creadas + 1;
                        END IF;
                    END LOOP;
                END LOOP;

                RETURN v_creadas;
            END
            $func$;
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log(`10. Creando particiones (mes actual + ${MESES_POR_ADELANTADO - 1})...`);
        const [[creadas]] = await sequelize.query(
            `SELECT intelligence.asegurar_particiones(:meses) AS n;`,
            { replacements: { meses: MESES_POR_ADELANTADO }, transaction: t }
        );
        console.log(`   ${creadas.n} particiones creadas\n`);

        console.log('11. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON SCHEMA intelligence IS
            'Conversaciones, turnos y Ledger de decisiones y costos (ADR-004, ADR-022). '
            'Alto volumen, retención corta, particionado mensual. SIN FK hacia esquemas de '
            'vertical: es la única garantía de que se pueda extraer a su propio servicio.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON TABLE intelligence.costo IS
            'Ledger de costos. Estándar CONTABLE, no de telemetría (ADR-022): se escribe en la '
            'misma transacción que el turno y no se pierde, porque este número factura.';
            `,
            { transaction: t }
        );
        await sequelize.query(
            `
            COMMENT ON TABLE intelligence.invocacion_capacidad IS
            'Lo que ADR-022 llama tool_call. Se nombra así por ADR-008: la palabra "tool" solo '
            'existe en el adaptador del proveedor de modelos.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ Esquema intelligence creado.\n');
        console.log('  Las doce preguntas del Ledger:  node scripts/ledger_doce_preguntas.js\n');
        console.log(`  AVISO: hay particiones hasta ${MESES_POR_ADELANTADO} meses vista. Una tabla`);
        console.log('  particionada sin la partición del mes rechaza TODO INSERT. Antes de que se');
        console.log('  agoten:  SELECT intelligence.asegurar_particiones(12);\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
