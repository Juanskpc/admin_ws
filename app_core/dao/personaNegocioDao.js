/**
 * DAO de `platform.persona_negocio` — la relación de una persona con UN negocio.
 *
 * Vive en `app_core` porque `platform` es un contexto compartido: todas las verticales
 * lo usarán (bounded-contexts.md). La flecha es vertical → platform, nunca hacia
 * `intelligence`: este DAO no sabe que la IA existe, y el test del apagón sigue pasando.
 *
 * Reglas que implementa:
 *   ADR-006  las verticales referencian persona_negocio, con FK SIEMPRE nullable.
 *            Una vertical funciona sin persona.
 *   ADR-025  mientras el nivel global esté vacío, la resolución es por
 *            (id_negocio, telefono_e164). Jamás cruza inquilinos.
 */
const db = require('../models/conection');
const { normalizarE164Colombia } = require('../helpers/telefono');

const sequelize = db.sequelize;

/**
 * Resuelve la persona_negocio de un teléfono dentro de un negocio, creándola si no existe.
 *
 * `nombre_mostrado` se refresca con cada aparición, de modo que siempre refleja el nombre
 * más reciente — la misma regla que usó el backfill histórico. Si en esta ocasión no viene
 * nombre, se conserva el que hubiera; nunca se borra un nombre conocido.
 *
 * @param {Object}  datos
 * @param {number}  datos.idNegocio
 * @param {string}  datos.telefono   — en crudo, tal como lo capturó el formulario.
 * @param {string}  [datos.nombre]
 * @param {Object}  [opciones]
 * @param {Object}  [opciones.transaction]
 * @returns {Promise<string|null>} id_persona_negocio, o null si el teléfono no es utilizable.
 */
async function resolverOCrear({ idNegocio, telefono, nombre = null }, { transaction } = {}) {
    const telefonoE164 = normalizarE164Colombia(telefono);
    if (!telefonoE164) return null;

    const nombreLimpio = nombre ? String(nombre).trim() || null : null;

    const [fila] = await sequelize.query(
        `
        INSERT INTO platform.persona_negocio (id_negocio, telefono_e164, nombre_mostrado)
        VALUES (:idNegocio, :telefonoE164, :nombre)
        ON CONFLICT (id_negocio, telefono_e164) WHERE telefono_e164 IS NOT NULL
        DO UPDATE SET
            nombre_mostrado = COALESCE(EXCLUDED.nombre_mostrado, platform.persona_negocio.nombre_mostrado),
            actualizado_en  = now()
        RETURNING id_persona_negocio;
        `,
        {
            replacements: { idNegocio, telefonoE164, nombre: nombreLimpio },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );

    return fila ? fila.id_persona_negocio : null;
}

/**
 * Igual que `resolverOCrear`, pero **no puede hacer fallar a quien la llama**.
 *
 * Es la forma en que las verticales deben invocarla. Materializa el invariante de ADR-006
 * ("una vertical funciona sin persona"): si la identidad falla, la operación de negocio
 * —tomar un pedido, agendar una cita— continúa con `id_persona_negocio = NULL`. La caja de
 * un restaurante no puede caerse porque el módulo de identidad tenga un problema.
 *
 * El SAVEPOINT es imprescindible, no decorativo: en PostgreSQL cualquier error aborta la
 * transacción entera. Sin savepoint, un `try/catch` alrededor de esta llamada atraparía el
 * error pero dejaría la transacción envenenada, y el commit de la orden fallaría igualmente.
 */
async function resolverOCrearBestEffort(datos, { transaction } = {}) {
    try {
        // Con `transaction` presente, Sequelize abre un SAVEPOINT en lugar de una
        // transacción nueva: si esto revienta, solo se deshace este trozo.
        return await sequelize.transaction({ transaction }, async (tx) =>
            resolverOCrear(datos, { transaction: tx })
        );
    } catch (error) {
        console.error(
            `[personaNegocio] No se pudo resolver la identidad (negocio ${datos.idNegocio}); ` +
                `la operación continúa sin persona. Motivo: ${error.message}`
        );
        return null;
    }
}

module.exports = { resolverOCrear, resolverOCrearBestEffort };
