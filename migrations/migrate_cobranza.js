/**
 * Cobranza F0 — el modelo de datos del cobro de NUESTRAS mensualidades.
 *
 * Ver `docs/cobro-mensualidades.md` (el diseño completo), `docs/precios-y-planes.md` §5
 * (de dónde salen los precios) y `docs/obligaciones-escalapp.md` §1–§3 (por qué esto es
 * más tributario que técnico).
 *
 * ## Qué hace, y qué NO hace
 *
 * Esto **no cobra nada todavía**. Crea el sitio donde vive lo que hoy no existe en ninguna
 * parte: quién nos paga, cuánto, en qué moneda, por qué medio, si ya pagó este mes y cuánto
 * llegó de verdad al banco. Hoy esa información vive en la cabeza del dueño y en el extracto
 * de Bancolombia.
 *
 * No crea el adaptador de dLocal ni el de Wompi: eso es F1 y F2, y hacen falta credenciales
 * que todavía no tenemos. Lo que sí queda listo es **el hueco donde enchufan** — la columna
 * `pasarela` y la tabla `cob_transaccion` no cambian cuando lleguen.
 *
 * ## La decisión que gobierna todo lo de aquí: el período de servicio NO se muda
 *
 * Quién tiene plan activo y hasta cuándo lo sigue diciendo `general.gener_negocio_plan`, igual
 * que hoy, y `planHelper` no se toca. `cob_suscripcion` responde otra pregunta —«¿este negocio
 * nos paga, cómo y cuándo?»— y **empuja** la fecha de `gener_negocio_plan` cuando entra un pago.
 *
 * Mezclar las dos habría sido lo natural y es justo lo que no hay que hacer: el plan es
 * permiso de uso y lo consulta cada request de cada inquilino; la suscripción es dinero y la
 * consulta el dueño una vez al mes. Además hay negocios con plan y sin suscripción (cortesías,
 * el trial) y los habrá con suscripción sin plan (el que canceló y quedó debiendo).
 *
 * ## El modo `manual` no es el caso degradado
 *
 * Es el que usan HOY todos los clientes, y va a seguir siendo el de las empresas: un cliente
 * persona jurídica **retiene en la fuente**, así que un débito automático del 100% le crea un
 * saldo a favor que nadie pidió (docs/obligaciones-escalapp.md §3). Por eso `es_retenedor` es
 * una columna y no una nota, y por eso `manual` es una fila de `cob_pasarela` como las otras
 * dos: para que el servicio no tenga un `if` especial regado por todas partes.
 *
 * ## Por qué `referencia` es UNIQUE y no un consecutivo
 *
 * `EA-<id_negocio>-<AAAAMM>` es la llave de idempotencia del cobro. Que la BD la rechace por
 * duplicada es la única garantía real de que un cron que se ejecuta dos veces —o que muere
 * después de cobrar y antes de marcar— no le cobre dos veces el mismo mes a un cliente.
 * Un `serial` no protege de nada: dos filas distintas son dos cobros distintos.
 *
 * ## Backfill
 *
 * Cada negocio con plan activo estrena una suscripción en modo `manual`, porque eso es
 * literalmente lo que es hoy. Sin esto la vista de cartera nace vacía y el dueño tendría que
 * teclear a mano los clientes que ya tiene.
 *
 * Idempotente: `IF NOT EXISTS` en todo, seeds con `ON CONFLICT`, backfill con `NOT EXISTS`,
 * triggers con `DROP ... IF EXISTS` antes del `CREATE`. Se puede correr dos veces seguidas.
 * Ejecutar con: npm run migrate:cobranza
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/**
 * Las tres formas de cobrar. `manual` es la única que funciona hoy; las otras dos quedan
 * sembradas e INACTIVAS para que aparezcan en el selector el día que haya credenciales, sin
 * necesidad de otra migración.
 *
 * `paises` y `monedas` son los que filtran el selector del inquilino: un negocio chileno no
 * tiene por qué ver PSE. Wompi es solo Colombia; dLocal cubre los 15 países de su cobertura,
 * de los que aquí solo se siembran los dos que nos importan hoy.
 */
const PASARELAS = [
    {
        codigo: 'manual',
        nombre: 'Transferencia bancaria',
        descripcion: 'El cliente transfiere y un administrador marca la factura como pagada. '
            + 'Único modo compatible con clientes que practican retención en la fuente.',
        paises: '{CO,CL}',
        monedas: '{COP,CLP,USD}',
        soporta_recurrente: false,
        estado: 'A',
        orden: 1,
    },
    {
        codigo: 'dlocal',
        nombre: 'dLocal Go',
        descripcion: 'Cobro con medios locales en Colombia, Chile y 13 países más. '
            + 'CO 1,99% + USD 0,20 · CL 2,99%. Pendiente de credenciales (F1).',
        paises: '{CO,CL}',
        monedas: '{COP,CLP,USD}',
        soporta_recurrente: true,
        estado: 'I',
        orden: 2,
    },
    {
        codigo: 'wompi',
        nombre: 'Wompi (Bancolombia)',
        descripcion: 'PSE, Nequi, botón Bancolombia y tarjetas. 2,65% + $700 + IVA, misma '
            + 'tarifa para todos los métodos. Solo Colombia. Pendiente de credenciales (F2).',
        paises: '{CO}',
        monedas: '{COP}',
        soporta_recurrente: true,
        estado: 'I',
        orden: 3,
    },
];

/**
 * Tablas que se auditan. Regla fija del proyecto: toda tabla con dinero o estado lleva su
 * `trg_audit` en la MISMA migración que la crea.
 *
 * `cob_transaccion` y `cob_evento_webhook` quedan fuera a propósito: son alta rotación y bajo
 * valor —el log crudo de lo que dijo la pasarela— y ya son inmutables por diseño. Auditar un
 * log de auditoría es duplicar el almacenamiento para no aprender nada.
 */
const TABLAS_AUDITADAS = [
    { tabla: 'cob_suscripcion', pk: 'id_suscripcion' },
    { tabla: 'cob_factura', pk: 'id_factura' },
    { tabla: 'cob_metodo_pago', pk: 'id_metodo_pago' },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Cobranza F0 (cobro de mensualidades)\n');

        // ── 1. Esquema ───────────────────────────────────────────────────────────────────
        console.log('1. Esquema cobranza...');
        await sequelize.query('CREATE SCHEMA IF NOT EXISTS cobranza;', { transaction: t });

        // ── 2. Catálogo de pasarelas ─────────────────────────────────────────────────────
        //
        // Es una tabla y no un ENUM ni una constante en JS porque hay que poder APAGAR una
        // pasarela un martes a las 3 de la tarde —se cayó, subió tarifas, se venció el
        // contrato— sin desplegar código.
        console.log('2. cobranza.cob_pasarela...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_pasarela (
                codigo             varchar(20) PRIMARY KEY,
                nombre             varchar(80) NOT NULL,
                descripcion        text,

                -- Filtran el selector del inquilino: códigos ISO de país y de moneda.
                paises             text[]      NOT NULL DEFAULT '{}',
                monedas            text[]      NOT NULL DEFAULT '{}',

                -- ¿Puede cobrar sola contra un token, sin que el pagador esté delante?
                -- 'manual' no puede: por eso queda fuera del cron de cobro.
                soporta_recurrente boolean     NOT NULL DEFAULT false,

                estado             char(1)     NOT NULL DEFAULT 'A',
                orden              smallint    NOT NULL DEFAULT 0,

                CONSTRAINT chk_cob_pasarela_estado CHECK (estado IN ('A','I'))
            );
            `,
            { transaction: t }
        );

        for (const p of PASARELAS) {
            await sequelize.query(
                `INSERT INTO cobranza.cob_pasarela
                     (codigo, nombre, descripcion, paises, monedas, soporta_recurrente, estado, orden)
                 VALUES (:codigo, :nombre, :descripcion, :paises, :monedas, :soporta_recurrente, :estado, :orden)
                 ON CONFLICT (codigo) DO UPDATE
                     SET nombre             = EXCLUDED.nombre,
                         descripcion        = EXCLUDED.descripcion,
                         paises             = EXCLUDED.paises,
                         monedas            = EXCLUDED.monedas,
                         soporta_recurrente = EXCLUDED.soporta_recurrente,
                         orden              = EXCLUDED.orden;`,
                { replacements: p, transaction: t }
            );
        }
        console.log(`   ${PASARELAS.length} pasarelas (solo 'manual' activa).`);

        // ── 3. Precios por moneda ────────────────────────────────────────────────────────
        //
        // `gener_plan.precio` es un solo número en COP y con un cliente en Chile deja de
        // alcanzar. Aquí NO se convierte con la tasa del día: un precio que se mueve cada mes
        // con el dólar es una factura impredecible, que es justo lo que odia un negocio
        // pequeño (docs/precios-y-planes.md §3). Se fijan cifras redondas a mano.
        //
        // `gener_plan.precio` se conserva como está y sigue siendo la fuente para COP mensual:
        // borrarlo habría roto la consola de planes por nada.
        console.log('3. cobranza.cob_precio_plan...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_precio_plan (
                id_precio  serial       PRIMARY KEY,
                id_plan    integer      NOT NULL REFERENCES general.gener_plan(id_plan) ON DELETE CASCADE,
                moneda     char(3)      NOT NULL,
                ciclo      varchar(10)  NOT NULL DEFAULT 'mensual',
                precio     numeric(12,2) NOT NULL,
                estado     char(1)      NOT NULL DEFAULT 'A',

                CONSTRAINT chk_cob_precio_ciclo  CHECK (ciclo IN ('mensual','anual')),
                CONSTRAINT chk_cob_precio_estado CHECK (estado IN ('A','I')),
                CONSTRAINT chk_cob_precio_valor  CHECK (precio >= 0),
                CONSTRAINT uq_cob_precio_plan    UNIQUE (id_plan, moneda, ciclo)
            );
            `,
            { transaction: t }
        );

        // Semilla: el precio COP mensual que ya existe en gener_plan. Nada de Chile todavía —
        // ese número es una decisión comercial del dueño, no una que deba inventar una migración.
        // `RETURNING` + QueryTypes.SELECT en vez de leer el `rowCount` de la metadata: para un
        // INSERT..SELECT esa metadata no es fiable en Sequelize y el log acaba diciendo «0
        // filas» sobre una migración que sí insertó. Un contador que miente es peor que no
        // tenerlo: la siguiente persona lo cree y va a buscar el problema donde no está.
        const precios = await sequelize.query(
            `INSERT INTO cobranza.cob_precio_plan (id_plan, moneda, ciclo, precio)
             SELECT p.id_plan, 'COP', 'mensual', p.precio
               FROM general.gener_plan p
              WHERE p.estado = 'A'
             ON CONFLICT DO NOTHING
             RETURNING id_precio;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(`   ${precios.length} precio(s) COP sembrados desde gener_plan.`);

        // ── 4. Métodos de pago tokenizados ───────────────────────────────────────────────
        //
        // Aquí NUNCA entra un PAN. Solo el token que devuelve la pasarela y lo justo para que
        // el cliente reconozca su tarjeta en pantalla («Visa ···4242»). Eso mantiene el alcance
        // PCI en SAQ-A, que es el único realista para un equipo de dos.
        //
        // La tabla nace vacía y seguirá vacía hasta F1: el modo manual no tokeniza nada.
        console.log('4. cobranza.cob_metodo_pago...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_metodo_pago (
                id_metodo_pago serial      PRIMARY KEY,
                id_negocio     integer     NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                pasarela       varchar(20) NOT NULL REFERENCES cobranza.cob_pasarela(codigo),

                -- El identificador que devuelve la pasarela. Es un puntero, no un secreto,
                -- pero solo sirve con nuestras llaves privadas.
                token_externo  varchar(255) NOT NULL,

                -- Solo para que el humano reconozca su medio de pago.
                tipo           varchar(20),
                marca          varchar(30),
                ultimos4       char(4),
                mes_exp        smallint,
                anio_exp       smallint,

                estado         char(1)     NOT NULL DEFAULT 'A',
                creado_en      timestamp   NOT NULL DEFAULT now(),

                CONSTRAINT chk_cob_metodo_estado CHECK (estado IN ('A','I')),
                CONSTRAINT uq_cob_metodo_token   UNIQUE (pasarela, token_externo)
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_cob_metodo_negocio
                 ON cobranza.cob_metodo_pago (id_negocio) WHERE estado = 'A';`,
            { transaction: t }
        );

        // ── 5. Suscripción ───────────────────────────────────────────────────────────────
        //
        // UNA por negocio (unique). Cambiar de plan o de pasarela actualiza esta fila; el
        // historial de lo que pasó vive en las facturas, que es donde de verdad importa.
        console.log('5. cobranza.cob_suscripcion...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_suscripcion (
                id_suscripcion serial       PRIMARY KEY,
                id_negocio     integer      NOT NULL UNIQUE
                               REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_plan        integer      NOT NULL REFERENCES general.gener_plan(id_plan),

                ciclo          varchar(10)  NOT NULL DEFAULT 'mensual',
                moneda         char(3)      NOT NULL DEFAULT 'COP',
                pasarela       varchar(20)  NOT NULL DEFAULT 'manual'
                               REFERENCES cobranza.cob_pasarela(codigo),
                id_metodo_pago integer      REFERENCES cobranza.cob_metodo_pago(id_metodo_pago) ON DELETE SET NULL,

                -- trial → activa → en_gracia → suspendida → cancelada
                -- 'en_gracia' es el estado que evita el error caro: el pago falló pero el
                -- servicio SIGUE funcionando mientras se reintenta. Cortarle la caja a un
                -- restaurante un viernes por una tarjeta vencida es perder al cliente, no cobrarle.
                estado         varchar(15)  NOT NULL DEFAULT 'activa',

                -- Fecha del próximo cobro. NULL = no se cobra sola (todo lo manual).
                proximo_cobro  date,
                -- Día del mes que le queda cómodo al cliente. 29–31 se ajustan al último día.
                dia_cobro      smallint,
                reintentos     smallint     NOT NULL DEFAULT 0,

                -- ⚠️ El cliente que retiene en la fuente NO se puede debitar por el 100%.
                -- Ver docs/obligaciones-escalapp.md §3. Con esto en true, el cron no lo toca
                -- aunque tenga método de pago guardado.
                es_retenedor   boolean      NOT NULL DEFAULT false,

                notas          text,
                creado_en      timestamp    NOT NULL DEFAULT now(),
                actualizado_en timestamp    NOT NULL DEFAULT now(),

                CONSTRAINT chk_cob_susc_ciclo  CHECK (ciclo IN ('mensual','anual')),
                CONSTRAINT chk_cob_susc_estado CHECK (estado IN ('trial','activa','en_gracia','suspendida','cancelada')),
                CONSTRAINT chk_cob_susc_dia    CHECK (dia_cobro IS NULL OR (dia_cobro BETWEEN 1 AND 31))
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_cob_susc_proximo_cobro
                 ON cobranza.cob_suscripcion (proximo_cobro)
              WHERE estado IN ('activa','en_gracia') AND proximo_cobro IS NOT NULL;`,
            { transaction: t }
        );

        // ── 6. Factura ───────────────────────────────────────────────────────────────────
        //
        // El corazón del módulo: un período de servicio cobrado (o por cobrar) a un negocio.
        //
        // Tres columnas que parecen redundantes y no lo son:
        //   total            — lo que facturamos
        //   comision_pasarela — lo que se queda la pasarela
        //   retencion_declarada — lo que retiene el cliente empresa
        //   neto_recibido    — lo que de verdad llegó al banco
        // La diferencia entre la primera y la última es exactamente lo que descuadra la
        // conciliación de cualquiera que revise las cuentas sin saber esto
        // (docs/obligaciones-escalapp.md §3). Guardarlo como cuatro números es lo que
        // convierte «no me cuadra el banco» en un dato.
        console.log('6. cobranza.cob_factura...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_factura (
                id_factura     serial       PRIMARY KEY,
                id_suscripcion integer      NOT NULL REFERENCES cobranza.cob_suscripcion(id_suscripcion) ON DELETE CASCADE,

                -- Desnormalizado a propósito: la vista de cartera y el scoping multi-tenant
                -- filtran por negocio en cada consulta, y un JOIN por eso es puro peaje.
                id_negocio     integer      NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,

                -- Llave de idempotencia: EA-<id_negocio>-<AAAAMM>. Ver cabecera.
                referencia     varchar(40)  NOT NULL UNIQUE,

                periodo_inicio date         NOT NULL,
                periodo_fin    date         NOT NULL,

                moneda         char(3)      NOT NULL DEFAULT 'COP',
                subtotal       numeric(12,2) NOT NULL DEFAULT 0,
                impuestos      numeric(12,2) NOT NULL DEFAULT 0,
                total          numeric(12,2) NOT NULL,

                -- pendiente → pagada | fallida | anulada
                estado         varchar(12)  NOT NULL DEFAULT 'pendiente',
                pasarela       varchar(20)  NOT NULL REFERENCES cobranza.cob_pasarela(codigo),

                fecha_pago          timestamp,
                comision_pasarela   numeric(12,2) NOT NULL DEFAULT 0,
                retencion_declarada numeric(12,2) NOT NULL DEFAULT 0,
                neto_recibido       numeric(12,2),

                -- Modo manual: «Transferencia Bancolombia 12/09», «Nequi», lo que sea.
                medio_pago_texto varchar(120),

                -- El hueco de la factura electrónica NUESTRA (docs/obligaciones-escalapp.md §1).
                -- Se llena a mano hasta que exista la habilitación ante la DIAN; que la columna
                -- exista desde hoy es lo que evita migrar datos históricos después.
                numero_factura varchar(40),
                cufe           varchar(120),

                nota           text,
                creado_en      timestamp    NOT NULL DEFAULT now(),
                actualizado_en timestamp    NOT NULL DEFAULT now(),

                CONSTRAINT chk_cob_factura_estado  CHECK (estado IN ('pendiente','pagada','fallida','anulada')),
                CONSTRAINT chk_cob_factura_total   CHECK (total >= 0),
                CONSTRAINT chk_cob_factura_periodo CHECK (periodo_fin >= periodo_inicio)
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_cob_factura_negocio
                 ON cobranza.cob_factura (id_negocio, periodo_inicio DESC);`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_cob_factura_pendientes
                 ON cobranza.cob_factura (estado, periodo_fin) WHERE estado = 'pendiente';`,
            { transaction: t }
        );

        // ── 7. Transacciones contra la pasarela ──────────────────────────────────────────
        //
        // Un intento = una fila, incluso los fallidos. Sobre todo los fallidos: el día que un
        // cliente jure que pagó, esto es lo único que puede darle la razón o quitársela.
        console.log('7. cobranza.cob_transaccion...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_transaccion (
                id_transaccion   serial      PRIMARY KEY,
                id_factura       integer     NOT NULL REFERENCES cobranza.cob_factura(id_factura) ON DELETE CASCADE,
                pasarela         varchar(20) NOT NULL REFERENCES cobranza.cob_pasarela(codigo),

                -- El id de la transacción EN la pasarela. Lo que se le dice al soporte de ellos.
                id_externo       varchar(120),
                estado           varchar(20) NOT NULL,
                codigo_respuesta varchar(40),
                mensaje          text,

                -- Respuesta cruda, SIN datos sensibles: el adaptador la limpia antes de guardar.
                payload          jsonb,
                creado_en        timestamp   NOT NULL DEFAULT now()
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_cob_transaccion_factura
                 ON cobranza.cob_transaccion (id_factura, creado_en DESC);`,
            { transaction: t }
        );

        // ── 8. Eventos de webhook ────────────────────────────────────────────────────────
        //
        // Se guarda el evento CRUDO antes de interpretarlo y se responde 200 en milisegundos.
        // Una pasarela que no recibe 200 rápido reintenta, y un reintento sin idempotencia es
        // un plan activado dos veces.
        //
        // El UNIQUE (pasarela, id_evento_externo) ES la idempotencia: el segundo INSERT del
        // mismo evento choca contra la BD, no contra un `if` que alguien puede olvidar.
        console.log('8. cobranza.cob_evento_webhook...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS cobranza.cob_evento_webhook (
                id_evento          serial       PRIMARY KEY,
                pasarela           varchar(20)  NOT NULL,
                id_evento_externo  varchar(160) NOT NULL,
                tipo               varchar(60),

                -- Un evento con firma inválida se GUARDA igual (con false) y no se procesa:
                -- una ráfaga de estos es la señal de que alguien está probando la puerta.
                firma_valida       boolean      NOT NULL DEFAULT false,

                payload            jsonb,
                recibido_en        timestamp    NOT NULL DEFAULT now(),
                procesado_en       timestamp,
                error              text,

                CONSTRAINT uq_cob_evento_externo UNIQUE (pasarela, id_evento_externo)
            );
            `,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_cob_evento_sin_procesar
                 ON cobranza.cob_evento_webhook (recibido_en)
              WHERE procesado_en IS NULL AND firma_valida = true;`,
            { transaction: t }
        );

        // ── 9. Auditoría ─────────────────────────────────────────────────────────────────
        console.log('9. Triggers de auditoría...');
        const [[infra]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.routines
                  WHERE routine_schema = 'auditoria' AND routine_name = 'fn_audit'
             ) AS ok;`,
            { transaction: t }
        );

        if (!infra.ok) {
            // No se tumba la migración por esto: el módulo funciona sin auditoría, y en una BD
            // local recién creada es normal que falte. En producción sí está.
            console.log('   ⚠️  auditoria.fn_audit no existe — triggers omitidos.');
            console.log('       Ejecute: npm run migrate:auditoria-base && npm run migrate:cobranza');
        } else {
            for (const { tabla, pk } of TABLAS_AUDITADAS) {
                await sequelize.query(
                    `DROP TRIGGER IF EXISTS trg_audit ON cobranza.${tabla};`,
                    { transaction: t }
                );
                await sequelize.query(
                    `CREATE TRIGGER trg_audit
                         AFTER INSERT OR UPDATE OR DELETE ON cobranza.${tabla}
                         FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                    { transaction: t }
                );
                console.log(`   ✓ cobranza.${tabla} (pk: ${pk})`);
            }
        }

        // ── 10. Backfill ─────────────────────────────────────────────────────────────────
        //
        // Todo negocio con plan activo hoy nos paga por transferencia, así que eso es
        // exactamente lo que se registra. `proximo_cobro` queda en NULL: el modo manual no lo
        // usa, y ponerle una fecha sería prometer un cobro automático que nadie va a ejecutar.
        //
        // Se toma el plan vigente MÁS RECIENTE de cada negocio (un negocio puede arrastrar
        // filas viejas en gener_negocio_plan).
        console.log('10. Backfill de suscripciones existentes...');
        const backfill = await sequelize.query(
            `
            INSERT INTO cobranza.cob_suscripcion
                   (id_negocio, id_plan, ciclo, moneda, pasarela, estado, notas)
            SELECT DISTINCT ON (np.id_negocio)
                   np.id_negocio,
                   np.id_plan,
                   'mensual',
                   COALESCE(p.moneda, 'COP'),
                   'manual',
                   'activa',
                   'Creada por la migración de cobranza F0 a partir del plan vigente.'
              FROM general.gener_negocio_plan np
              JOIN general.gener_plan p ON p.id_plan = np.id_plan
             WHERE np.estado = 'A'
               AND np.fecha_inicio <= now()
               AND (np.fecha_fin IS NULL OR np.fecha_fin >= now())
               AND NOT EXISTS (
                     SELECT 1 FROM cobranza.cob_suscripcion s
                      WHERE s.id_negocio = np.id_negocio
               )
             ORDER BY np.id_negocio, np.fecha_inicio DESC
             RETURNING id_suscripcion;
            `,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(`   ${backfill.length} suscripción(es) creadas en modo manual.`);

        await t.commit();
        console.log('\n✅ Cobranza F0 lista. Ninguna pasarela cobra todavía: eso es F1 (dLocal).');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
