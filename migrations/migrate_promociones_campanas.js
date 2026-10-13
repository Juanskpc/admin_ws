/**
 * Migración: las campañas (F2 de `docs/promociones-masivas.md`).
 *
 * Tres tablas, y la decisión de diseño está en lo que **no** llevan.
 *
 * ## `campana_destinatario` NO guarda el estado de entrega
 *
 * Guarda `id_mensaje`, que apunta a `intelligence.mensaje`. La entrega —si salió, si llegó, si
 * Meta la rechazó y con qué código— ya la lleva esa tabla: la escribe el entregador y la corrige
 * el acuse del webhook (`repositorio.marcarAcuseDelCanal`). Copiarla aquí sería **una segunda
 * verdad sobre la misma cosa**, y la primera vez que divergieran —un reintento, un acuse tardío—
 * no habría forma de saber cuál miente. Es la misma razón por la que el medidor de cuota cuenta
 * sobre `intelligence.mensaje` y no sobre un contador propio (`whatsapp-costo-mensajes.md` §3).
 *
 * Lo que sí es de esta tabla es lo que el Ledger no sabe: **por qué a alguien no se le mandó
 * nada** (`motivo_omision`) y si su crédito se cobró o se devolvió.
 *
 * ## `campana.segmento` guarda la DEFINICIÓN, no la lista
 *
 * Qué segmentos se eligieron, no quiénes eran. Así la campaña se puede repetir el mes siguiente
 * —cuando «en riesgo» ya es otra gente— y se puede auditar a quién se decidió escribir y por qué.
 * La lista concreta vive en `campana_destinatario`, congelada al armarla.
 *
 * ## `plantilla_promocion` es el espejo de lo que Meta aprobó
 *
 * El **texto** vive en el código (`intelligence/core/plantillas.js`), igual que el de
 * `recordatorio_cita`: es parte del programa, no configuración de un inquilino. Lo que es por
 * inquilino es si **su** WABA ya la tiene aprobada, y eso es lo único que guarda esta tabla. Sin
 * ella habría que preguntárselo a Meta en cada envío.
 *
 * ## Auditoría
 *
 * `trg_audit` en `campana`: lleva dinero y estado, y es la regla fija de `CLAUDE.md`. **No** en
 * `campana_destinatario` —alta rotación y bajo valor, cientos de filas por campaña— ni en
 * `plantilla_promocion`, que es un espejo de algo que decide Meta.
 *
 * Idempotente. Registrada como `npm run migrate:promociones-campanas`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;

async function unaFila(sql, replacements, transaction) {
    const filas = await sequelize.query(sql, {
        replacements,
        type: sequelize.QueryTypes.SELECT,
        transaction,
    });
    return filas?.[0] ?? null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Promociones — campañas\n');

        console.log('1. platform.plantilla_promocion ...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS platform.plantilla_promocion (
                 id_plantilla_promocion uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                 id_negocio      integer NOT NULL
                                 REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                 -- El nombre del catálogo de código, que es el mismo con el que se crea en la
                 -- WABA del inquilino. Meta busca por nombre + idioma, exactos.
                 nombre          varchar(80) NOT NULL,
                 idioma          varchar(10) NOT NULL,
                 -- Lo que dice Meta. 'PENDIENTE' es nuestro: se pidió y aún no contesta.
                 estado_meta     varchar(20) NOT NULL DEFAULT 'PENDIENTE',
                 id_meta         varchar(60),
                 motivo_rechazo  text,
                 -- El handle del ejemplo de imagen que se le dio a Meta al crearla, para no
                 -- volver a subirlo si hay que recrearla.
                 ejemplo_handle  text,
                 creado_en       timestamptz NOT NULL DEFAULT now(),
                 revisado_en     timestamptz,
                 CONSTRAINT uq_plantilla_promocion UNIQUE (id_negocio, nombre, idioma),
                 CONSTRAINT chk_plantilla_promocion_estado
                     CHECK (estado_meta IN ('PENDIENTE', 'APPROVED', 'REJECTED', 'PAUSED',
                                            'DISABLED', 'IN_APPEAL'))
             );`,
            { transaction: t }
        );
        console.log('   ✓');

        console.log('2. platform.campana ...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS platform.campana (
                 id_campana      uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                 id_negocio      integer NOT NULL
                                 REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                 vertical        varchar(20) NOT NULL,
                 nombre          varchar(120) NOT NULL,
                 estado          varchar(20) NOT NULL DEFAULT 'BORRADOR',

                 -- Qué plantilla del catálogo y con qué huecos rellenos.
                 plantilla       varchar(80) NOT NULL,
                 parametros      jsonb NOT NULL DEFAULT '{}'::jsonb,
                 imagen_url      text,

                 -- La DEFINICIÓN de a quién, no la lista (ver la cabecera).
                 segmento        jsonb NOT NULL DEFAULT '{}'::jsonb,

                 destinatarios   integer NOT NULL DEFAULT 0,
                 -- Lo que dijo el simulador al aprobarla. Se congela para poder comparar después
                 -- lo estimado con lo real, que es la única forma de que la próxima estimación
                 -- sea mejor.
                 costo_estimado  jsonb NOT NULL DEFAULT '{}'::jsonb,

                 -- Hora de pared de Bogotá, como el resto del dominio (CLAUDE.md).
                 programada_para timestamp,
                 enviando_desde  timestamptz,
                 terminada_en    timestamptz,
                 motivo_corte    text,

                 -- La prueba al dueño: sin esto no se puede enviar (ver elegibilidad).
                 id_mensaje_prueba uuid,
                 prueba_en       timestamptz,

                 id_usuario_creo integer REFERENCES general.gener_usuario(id_usuario) ON DELETE SET NULL,
                 creado_en       timestamptz NOT NULL DEFAULT now(),
                 actualizado_en  timestamptz,

                 CONSTRAINT chk_campana_estado CHECK (estado IN (
                     'BORRADOR', 'PENDIENTE_PLANTILLA', 'LISTA', 'PROGRAMADA',
                     'ENVIANDO', 'PAUSADA', 'ENVIADA', 'CANCELADA', 'FALLIDA'
                 ))
             );`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_campana_negocio
                 ON platform.campana (id_negocio, creado_en DESC);`,
            { transaction: t }
        );
        // La consulta del despachador: «¿qué campaña toca mover ahora?». Parcial, porque las
        // terminadas son la mayoría y no se vuelven a mirar nunca.
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_campana_en_curso
                 ON platform.campana (estado, programada_para)
              WHERE estado IN ('PROGRAMADA', 'ENVIANDO');`,
            { transaction: t }
        );
        console.log('   ✓');

        console.log('3. platform.campana_destinatario ...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS platform.campana_destinatario (
                 id_campana_destinatario uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
                 id_campana      uuid NOT NULL
                                 REFERENCES platform.campana(id_campana) ON DELETE CASCADE,
                 id_persona_negocio uuid NOT NULL
                                 REFERENCES platform.persona_negocio(id_persona_negocio) ON DELETE CASCADE,
                 -- Congelado al armar la campaña: si el cliente cambia de número después, lo que
                 -- hay que poder explicar es a dónde se mandó, no a dónde se mandaría hoy.
                 telefono_e164   varchar(20) NOT NULL,
                 segmento        varchar(30),

                 -- Nuestro ciclo de vida, NO el de la entrega (ver la cabecera).
                 estado          varchar(20) NOT NULL DEFAULT 'PENDIENTE',
                 motivo_omision  varchar(40),

                 -- El puente al Ledger. De aquí sale el estado de entrega real.
                 id_mensaje      uuid,
                 encolado_en     timestamptz,

                 -- Un crédito por mensaje encolado; se devuelve si Meta no lo entrega.
                 credito_cobrado boolean NOT NULL DEFAULT false,
                 credito_devuelto_en timestamptz,

                 creado_en       timestamptz NOT NULL DEFAULT now(),

                 CONSTRAINT uq_campana_destinatario UNIQUE (id_campana, id_persona_negocio),
                 CONSTRAINT chk_campana_destinatario_estado CHECK (estado IN (
                     'PENDIENTE', 'ENCOLADO', 'OMITIDO'
                 ))
             );`,
            { transaction: t }
        );
        // La consulta caliente del despachador: los que faltan de esta campaña.
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_campana_destinatario_pendientes
                 ON platform.campana_destinatario (id_campana)
              WHERE estado = 'PENDIENTE';`,
            { transaction: t }
        );
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_campana_destinatario_mensaje
                 ON platform.campana_destinatario (id_mensaje)
              WHERE id_mensaje IS NOT NULL;`,
            { transaction: t }
        );
        console.log('   ✓');

        console.log('4. Auditoría de platform.campana ...');
        const fnAudit = await unaFila(
            `SELECT 1 AS hay FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';`,
            {},
            t,
        );
        if (fnAudit) {
            await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON platform.campana;`, {
                transaction: t,
            });
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON platform.campana
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_campana');`,
                { transaction: t }
            );
            console.log('   ✓');
        } else {
            console.log('   ! auditoria.fn_audit no existe; se omite (corre migrate:auditoria-base)');
        }

        await t.commit();
        console.log('\n✓ Campañas listas. Nada se envía hasta que una campaña pase a ENVIANDO.');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
