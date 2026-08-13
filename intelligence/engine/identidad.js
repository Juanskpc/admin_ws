/**
 * Identity Resolver (F5-D) — quién es el que escribe, y con qué permiso opera.
 *
 * ## Por qué esto va ANTES que la FSM
 *
 * El Policy Gate no ejecuta ninguna capacidad sin un Principal, y hasta F5-C el único
 * productor de Principals era `resolverPrincipalUsuario`, que parte de un `id_usuario` de
 * `general.gener_usuario`. Un cliente final que escribe en el WebChat **no tiene usuario**:
 * es anónimo, no ha iniciado sesión y no debe hacerlo. `principal.js` ya reservaba el tipo
 * `contacto` para exactamente esto, con la nota «todavía sin productor». Este archivo es ese
 * productor, y sin él la FSM no podría invocar ni `consultar_servicios`.
 *
 * ## Dos identidades que no son la misma, y conviene no confundir
 *
 *   - **El Principal** responde a *«¿sobre qué negocio puede operar?»*. Es autorización, se
 *     construye en cada turno y no se guarda en ninguna parte.
 *   - **La `persona_negocio`** responde a *«¿a quién conocemos?»*: teléfono, nombre, historial.
 *     Es identidad de dominio, vive en la base y sobrevive a la conversación.
 *
 * Una conversación siempre tiene Principal; puede no tener persona todavía, porque en un canal
 * anónimo no sabemos quién es hasta que lo dice. Por eso `resolver()` devuelve las dos por
 * separado y la persona puede venir en `null`.
 *
 * ## El alcance del Principal `contacto`, que es la parte delicada
 *
 * Se le da **un solo negocio**: aquel en el que ocurre la conversación. Ni uno más. Es lo que
 * hace que la autorización multi-inquilino de F2 valga también aquí: si un mensaje intentara
 * operar sobre otro negocio, `puedeOperarEn()` dice que no, y lo dice en el mismo punto y con
 * el mismo código que para un usuario con sesión. No hay un camino paralelo para el público.
 *
 * Y sin rol: la lista de roles va vacía a propósito. Un contacto no es un empleado con menos
 * permisos, es otra cosa. Lo que puede hacer lo decide la capacidad (`tipo`, `feature`), no un
 * rol heredado que alguien podría ampliar sin darse cuenta.
 *
 * ## Lo que este resolver NO hace (F5-D, decisión consciente)
 *
 * No enlaza la cita con la persona. `reserva.reservar_turno` recibe `cliente_nombre` y
 * `cliente_telefono` como texto suelto, no un `id_persona_negocio`: `reserva` no ha adoptado
 * `persona` todavía. Así que la persona sirve para **no volver a preguntar** lo que ya
 * sabemos, no para relacionar la cita con nadie. Mientras esa costura siga abierta:
 *
 *   - no existe `consultar_mis_citas`, y la FSM tiene que guardarse el código de la cita;
 *   - la confirmación proactiva por outbox no tiene destino que resolver.
 *
 * Está documentado en `docs/ESTADO-Y-CONTINUACION.md`; no es un olvido.
 */
'use strict';

const Models = require('../../app_core/models/conection');
const { crearPrincipal, TIPO } = require('../../app_core/authz/principal');

/**
 * Construye el Principal de un cliente final en un canal público.
 *
 * No consulta la base: la pertenencia de un contacto a un negocio no es una membresía que
 * haya que comprobar, es un hecho del canal — el mensaje llegó por el WebChat de *este*
 * negocio. Verificar contra `gener_negocio_usuario` sería buscar una fila que por definición
 * no existe.
 *
 * @param {number} idNegocio — el negocio dueño del canal por el que entró el mensaje.
 */
function principalDeContacto(idNegocio) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error('principalDeContacto requiere un id_negocio válido.');
    }
    return crearPrincipal({
        tipo: TIPO.CONTACTO,
        idUsuario: null,
        esSuperAdmin: false,
        negocios: new Map([[id, []]]),
    });
}

/**
 * Normaliza un teléfono colombiano a E.164, que es como lo guarda `persona_negocio`.
 *
 * Devuelve `null` en vez de adivinar cuando no cuadra. Es deliberado: una persona creada a
 * partir de un teléfono mal normalizado es peor que no crearla, porque queda como un duplicado
 * silencioso que nadie va a limpiar. El backfill de F0 ya pagó esa lección — los cinco
 * formatos del mismo móvil que colapsan en una sola persona salen justo de aquí.
 */
function normalizarTelefono(entrada) {
    if (!entrada) return null;
    const digitos = String(entrada).replace(/\D/g, '');
    if (!digitos) return null;

    // Móvil nacional: 10 dígitos empezando por 3.
    if (digitos.length === 10 && digitos.startsWith('3')) return `+57${digitos}`;
    // Ya viene con indicativo país.
    if (digitos.length === 12 && digitos.startsWith('573')) return `+${digitos}`;
    // Fijo con indicativo de ciudad (Bogotá 601, etc.).
    if (digitos.length === 10 && /^[1-8]/.test(digitos)) return `+57${digitos}`;

    return null;
}

/**
 * Busca la persona del negocio por teléfono. No la crea.
 *
 * Crear personas es del **camino de escritura** de F0 (al crear la orden / la cita), no de
 * una conversación: si cada quien que saluda al bot generase una fila, `persona_negocio` se
 * llenaría de gente que nunca compró nada y las métricas del negocio dejarían de significar
 * algo. Aquí solo se reconoce a quien ya está.
 */
async function buscarPersonaPorTelefono(idNegocio, telefonoE164, opciones = {}) {
    if (!telefonoE164) return null;

    const filas = await Models.sequelize.query(
        `
        SELECT id_persona_negocio, id_persona, telefono_e164, nombre_mostrado,
               consentimiento_mensajeria
          FROM platform.persona_negocio
         WHERE id_negocio = :idNegocio
           AND telefono_e164 = :telefono
         LIMIT 1;
        `,
        {
            replacements: { idNegocio: Number(idNegocio), telefono: telefonoE164 },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction: opciones.transaction,
        }
    );

    return filas?.[0] ?? null;
}

/**
 * Resuelve la identidad de una conversación al empezar el turno.
 *
 * El teléfono no sale del canal —en WebChat el `id_externo` es una sesión de navegador, no un
 * número— sino de lo que la propia conversación haya ido aprendiendo y guardado en sus
 * variables. Por eso la persona aparece a mitad de la conversación y no al principio: es el
 * orden natural en un canal anónimo, y la FSM está escrita sabiéndolo.
 *
 * @param {Object} conversacion — la fila de `intelligence.conversacion`.
 * @returns {Promise<{principal, persona, telefono, nombre}>}
 */
async function resolver(conversacion, opciones = {}) {
    const idNegocio = Number(conversacion.id_negocio);
    const principal = principalDeContacto(idNegocio);

    const telefono = normalizarTelefono(conversacion.variables?.telefono);
    const persona = telefono
        ? await buscarPersonaPorTelefono(idNegocio, telefono, opciones)
        : null;

    return {
        principal,
        persona,
        telefono: persona?.telefono_e164 ?? telefono,
        // Lo que dijo en esta conversación manda sobre la ficha: si se corrige el nombre, la
        // corrección es más reciente que lo que hubiera guardado.
        nombre: conversacion.variables?.nombre ?? persona?.nombre_mostrado ?? null,
    };
}

module.exports = {
    resolver,
    principalDeContacto,
    normalizarTelefono,
    buscarPersonaPorTelefono,
};
