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
const GENERICO = { id: null, nombre: null, tratamiento: 'el negocio', atencion: null, tipoNegocio: null };

/**
 * Horario de atención del negocio — hoy **siempre `null`**, y es un estado correcto.
 *
 * Lo usa el handoff para decir *cuándo* habrá alguien en vez de prometer un «en un momento» que a
 * las once de la noche no cumple nadie. Con `null`, el mensaje cae a «en el transcurso del día»,
 * que es la decisión del dueño del 2026-08-18: si el negocio no tiene horario, no inventarse uno.
 *
 * ## Por qué no se lee de ningún sitio todavía
 *
 * Porque el sitio correcto no existe aún. [ADR-020](../../docs/adr/ADR-020-knowledge.md) lista
 * los **horarios** como *Business Context* —configuración del inquilino, pequeña, escrita a mano,
 * parte del prefijo estable del prompt— y `platform.business_context` está sin crear.
 *
 * Los dos atajos disponibles se descartaron a propósito:
 *
 * - **Leer `reserva.reserva_horario`.** Es el esquema de una vertical, e `intelligence/` no lo
 *   toca: el acoplamiento con el dominio vive en los adaptadores y en ningún otro sitio
 *   ([ADR-005](../../docs/adr/ADR-005-independencia-verticales.md)). Además esas filas son el
 *   horario **de cada profesional**, no el de atención del negocio: parecido no es lo mismo, y
 *   usarlo diría una hora que nadie prometió.
 * - **Una capacidad `consultar_horario`.** Contradice la categoría que ADR-020 congeló: el
 *   horario es configuración que va **siempre** en el prefijo, no un dato que se consulta por
 *   turno. Y una capacidad para componer una frase es un viaje al Gate por nada.
 *
 * Cuando exista `business_context`, esto se rellena **aquí dentro** y ni el handoff ni el motor
 * se enteran. La forma que espera quien lo consume: `{ desde: 'HH:MM', hasta: 'HH:MM' }`.
 */
function leerAtencion(/* fila */) {
    return null;
}

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
        `SELECT n.id_negocio, n.nombre, t.nombre AS tipo_negocio
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
          WHERE n.id_negocio = :id AND n.estado = 'A'`,
        { replacements: { id }, type: Models.sequelize.QueryTypes.SELECT }
    );

    const fila = filas[0];
    // Un negocio inactivo o inexistente no revienta la conversación: el asistente sigue
    // sirviendo, solo que sin nombre. Quién puede hablar con quién lo decide el Policy Gate,
    // no este módulo — aquí se resuelve identidad, no autorización.
    if (!fila) return GENERICO;

    const nombre = String(fila.nombre || '').trim() || null;
    return {
        id,
        nombre,
        tratamiento: nombre || GENERICO.tratamiento,
        atencion: leerAtencion(fila),
        // Qué CLASE de negocio es. No se traduce aquí a una vertical: este módulo no sabe qué
        // verticales existen y no debe saberlo (ADR-009). Devuelve el nombre del tipo tal como
        // está en el catálogo —`RESTAURANTE`, `RESERVA`— y quien enruta lo traduce con lo que
        // los adaptadores hayan declarado.
        tipoNegocio: String(fila.tipo_negocio || '').trim().toUpperCase() || null,
    };
}

module.exports = { obtener, GENERICO };
