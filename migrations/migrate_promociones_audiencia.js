/**
 * Migración: a quién se le puede mandar una promoción (F0 de `docs/promociones-masivas.md`).
 *
 * ## El modelo: lista por defecto con exclusiones, NO lista de autorizados
 *
 * Decisión del dueño, 2026-10-12, y es la que da forma a todo lo demás: **al cliente final no se
 * le pregunta nada**. Los clientes de un negocio son los que están en su base —gente que pidió y
 * dejó su teléfono, o a la que se le abrió una cuenta a mano— y la promoción se les manda salvo
 * que hayan pedido que no. Es como funciona la publicidad que recibe cualquiera: nadie le preguntó
 * primero, y la ignora o se da de baja.
 *
 * La consecuencia de diseño es que **lo que hay que guardar es la salida, no la entrada**:
 *
 *   · `promos_excluido` — pidió no recibir promociones. Es lo único que bloquea un envío.
 *   · `promos_excluido_en` — cuándo. Para poder contestar «desde cuándo» si alguien reclama.
 *   · `consentimiento_prueba` — con qué palabras lo pidió (el `wamid` y el texto). La Ley 1581
 *     deja al titular pedir prueba de lo que se hizo con sus datos, y «dijo que no» es justo lo
 *     que hay que poder demostrar que se respetó.
 *   · `consentimiento_origen` — por dónde llegó la decisión (el asistente, el mostrador, la
 *     vitrina). Una baja dicha por WhatsApp y una marcada a mano por el cajero no valen lo mismo
 *     el día que haya que explicarla.
 *
 * ## ⚠️ Esto NO toca `consentimiento_mensajeria`
 *
 * Esa columna es de ADR-006 y sigue significando lo que significaba: **el cliente dijo
 * explícitamente que sí**. Hoy nadie la pone en `true` y la promoción no la mira — por eso existe
 * `promos_excluido` y no se reutiliza aquella al revés. Mezclarlas sería peor: una columna que a
 * veces significa «autorizó» y a veces «no se ha negado» no se puede consultar sin saber quién la
 * escribió. Si algún día hay una casilla en la vitrina, ahí volverá a servir, y sumará — nunca
 * restará.
 *
 * ## `timestamptz` y no `timestamp`
 *
 * `CLAUDE.md` fija `timestamp without time zone` = hora de pared de Bogotá para el dominio, pero
 * toda `platform.persona_negocio` es `timestamptz` (`creado_en`, `consentimiento_actualizado_en`).
 * Una columna con otro tipo en la misma tabla es el tipo de incoherencia que luego se compara mal
 * en un `WHERE`. Manda la tabla.
 *
 * ## Lo que limpia de la versión anterior de esta misma migración
 *
 * El primer diseño preguntaba al cliente por el chat, y para eso añadió
 * `persona_negocio.consentimiento_pedido_en` y `gener_negocio.pide_consentimiento_promos`. La
 * pregunta se eliminó el mismo día y las dos columnas quedaron muertas, así que **esta migración
 * las quita** si están. Nunca llegaron a producción: lo normal es que no existan y estos dos pasos
 * no hagan nada.
 *
 * ## Lo que NO lleva: un trigger de auditoría
 *
 * La regla fija de `CLAUDE.md` pide `trg_audit` en una tabla nueva con dinero o estado, y esta no
 * es nueva: `persona_negocio` no tiene trigger hoy, y ponerle uno audita de paso cada cambio de
 * nombre de cada cliente de cada inquilino. El historial de las bajas —que es lo que de verdad hay
 * que poder reconstruir— se lleva por **eventos de aplicación** (`auditHelper.registrarEvento`,
 * módulo `promociones`), que es el camino ya instrumentado para `auth` y `caja`. La fila guarda el
 * estado y la prueba; el evento, la historia.
 *
 * Idempotente: consulta `information_schema` antes de cada `ALTER`, todo en una transacción.
 * Registrada como `npm run migrate:promociones-audiencia`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;

async function columnaExiste(esquema, tabla, columna, transaction) {
    const [fila] = await sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;`,
        {
            replacements: { esquema, tabla, columna },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    return Boolean(fila);
}

async function tablaExiste(esquema, tabla, transaction) {
    const [fila] = await sequelize.query(
        `SELECT 1 AS hay FROM information_schema.tables
          WHERE table_schema = :esquema AND table_name = :tabla;`,
        {
            replacements: { esquema, tabla },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    return Boolean(fila);
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        // `platform.persona_negocio` la crea `migrate:platform-persona`. Si no está, esta
        // migración no puede hacer su trabajo y decirlo claro ahorra media hora de desconcierto.
        if (!(await tablaExiste('platform', 'persona_negocio', t))) {
            throw new Error(
                'Falta platform.persona_negocio. Corre primero `npm run migrate:platform-persona`.'
            );
        }

        console.log('1. platform.persona_negocio.promos_excluido ...');
        if (!(await columnaExiste('platform', 'persona_negocio', 'promos_excluido', t))) {
            await sequelize.query(
                `ALTER TABLE platform.persona_negocio
                     ADD COLUMN promos_excluido boolean NOT NULL DEFAULT false,
                     ADD COLUMN promos_excluido_en timestamptz;`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN platform.persona_negocio.promos_excluido IS
                 'Pidió no recibir promociones. Es LO ÚNICO que bloquea un envío: al cliente no '
                 'se le pregunta nada, se le manda salvo que se haya dado de baja. No confundir '
                 'con consentimiento_mensajeria (ADR-006), que es el sí explícito y que esto no '
                 'toca.';`,
                { transaction: t }
            );
            console.log('   añadidas (por defecto false = se le puede escribir).');
        } else {
            console.log('   ya existían.');
        }

        console.log('2. platform.persona_negocio.consentimiento_origen ...');
        if (!(await columnaExiste('platform', 'persona_negocio', 'consentimiento_origen', t))) {
            await sequelize.query(
                `ALTER TABLE platform.persona_negocio
                     ADD COLUMN consentimiento_origen varchar(30),
                     ADD CONSTRAINT chk_persona_negocio_consentimiento_origen
                         CHECK (consentimiento_origen IS NULL OR consentimiento_origen IN
                             ('asistente', 'mostrador', 'vitrina', 'importado', 'negocio'));`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN platform.persona_negocio.consentimiento_origen IS
                 'Por dónde llegó la decisión del cliente sobre las promociones: asistente (lo '
                 'escribió por WhatsApp), mostrador, vitrina, importado, negocio (lo marcó el '
                 'personal). NULL = no ha dicho nada.';`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        console.log('3. platform.persona_negocio.consentimiento_prueba ...');
        if (!(await columnaExiste('platform', 'persona_negocio', 'consentimiento_prueba', t))) {
            await sequelize.query(
                `ALTER TABLE platform.persona_negocio ADD COLUMN consentimiento_prueba jsonb;`,
                { transaction: t }
            );
            await sequelize.query(
                `COMMENT ON COLUMN platform.persona_negocio.consentimiento_prueba IS
                 'La prueba de lo que dijo el cliente: wamid, texto literal y canal. Hoy se usa '
                 'para las bajas, que es lo que hay que poder demostrar que se respetó.';`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        // El índice de la pregunta que hará el simulador mil veces: «¿a cuántos puedo escribirle
        // en este negocio?». Parcial sobre los contactables, que son la mayoría — pero el filtro
        // deja fuera a los excluidos y a los que no tienen teléfono, que es justo lo que no hay
        // que recorrer en cada conteo.
        console.log('4. Índice de contactables ...');
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_persona_negocio_promocionables
                 ON platform.persona_negocio (id_negocio)
              WHERE NOT promos_excluido AND telefono_e164 IS NOT NULL;`,
            { transaction: t }
        );
        // El de la versión anterior contaba autorizados, que ya no es el criterio.
        await sequelize.query(
            `DROP INDEX IF EXISTS platform.idx_persona_negocio_autorizados;`,
            { transaction: t }
        );
        console.log('   listo.');

        // ── Limpieza de la versión anterior (ver la cabecera) ────────────────────────────
        console.log('5. Columnas muertas de la pregunta que se eliminó ...');
        if (await columnaExiste('platform', 'persona_negocio', 'consentimiento_pedido_en', t)) {
            await sequelize.query(
                `ALTER TABLE platform.persona_negocio DROP COLUMN consentimiento_pedido_en;`,
                { transaction: t }
            );
            console.log('   persona_negocio.consentimiento_pedido_en: quitada.');
        } else {
            console.log('   persona_negocio.consentimiento_pedido_en: no estaba (lo normal).');
        }
        if (await columnaExiste('general', 'gener_negocio', 'pide_consentimiento_promos', t)) {
            await sequelize.query(
                `ALTER TABLE general.gener_negocio DROP COLUMN pide_consentimiento_promos;`,
                { transaction: t }
            );
            console.log('   gener_negocio.pide_consentimiento_promos: quitada.');
        } else {
            console.log('   gener_negocio.pide_consentimiento_promos: no estaba (lo normal).');
        }

        await t.commit();
        console.log('\n✓ Audiencia de promociones lista.');
        console.log('  Todos los clientes con teléfono son contactables; la baja los saca.');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
