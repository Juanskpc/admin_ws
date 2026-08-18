/**
 * Contexto del negocio — quién es el inquilino para el que habla el asistente.
 *
 * ## Por qué existe esto y no un JOIN en el motor
 *
 * El asistente saludaba sin decir dónde estaba: «¿Qué servicio quieres agendar?», igual en una
 * barbería que en un consultorio. Para arreglarlo hace falta el nombre del negocio, y el sitio
 * fácil habría sido añadir un JOIN a `general.gener_negocio` en la consulta que el motor ya
 * hace. Eso funciona hoy y estorba mañana: [ADR-020](../../docs/adr/ADR-020-knowledge.md) dice
 * que la **configuración** del negocio —nombre, horarios, instrucciones para el asistente— es
 * *Business Context*, va **siempre** en el prefijo estable del prompt y es lo que consume el
 * Prompt Builder de F6. Con el JOIN cableado en el motor, F6 tendría que deshacerlo primero.
 *
 * Así que esto es una **costura, no una tabla**: un único sitio que responde «¿quién es este
 * negocio?». Hoy lee `general.gener_negocio`; el día que exista `platform.business_context`
 * cambia aquí dentro y ni el motor ni la FSM se enteran.
 *
 * ## Lo que NO es
 *
 * No es Knowledge (ADR-020 §tabla): el menú en PDF, el reglamento o las FAQ son otra cosa, con
 * propiedades opuestas —grandes, ingeridas, recuperadas por turno y **después** del corte de
 * caché—. Meterlas aquí sería el error de categoría que ese ADR describe, y se pagaría en la
 * factura del primer mes con volumen.
 *
 * No cachea. Es un `SELECT` por clave primaria y el test de simplicidad no admite una caché
 * sin evidencia de que haga falta; cuando la haya, se añade aquí y en ningún otro sitio.
 */
'use strict';

const Models = require('../../app_core/models/conection');

/** Lo que se enseña cuando el negocio no se puede leer. Neutro y sin mentir. */
const GENERICO = { id: null, nombre: null, tratamiento: 'el negocio' };

/**
 * @param {number} idNegocio
 * @returns {Promise<{id: number|null, nombre: string|null, tratamiento: string}>}
 *   `tratamiento` es cómo referirse al negocio en una frase: su nombre si se conoce, y una
 *   fórmula neutra si no. Que la decida esta capa evita que cada mensaje de la FSM tenga que
 *   acordarse de comprobar si hay nombre — el olvido saldría como «te comunicas con null».
 */
async function obtener(idNegocio) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id) || id < 1) return GENERICO;

    const filas = await Models.sequelize.query(
        `SELECT id_negocio, nombre
           FROM general.gener_negocio
          WHERE id_negocio = :id AND estado = 'A'`,
        { replacements: { id }, type: Models.sequelize.QueryTypes.SELECT }
    );

    const fila = filas[0];
    // Un negocio inactivo o inexistente no revienta la conversación: el asistente sigue
    // sirviendo, solo que sin nombre. Quién puede hablar con quién lo decide el Policy Gate,
    // no este módulo — aquí se resuelve identidad, no autorización.
    if (!fila) return GENERICO;

    const nombre = String(fila.nombre || '').trim() || null;
    return { id, nombre, tratamiento: nombre || GENERICO.tratamiento };
}

module.exports = { obtener, GENERICO };
