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
 * ## Tres identidades, no dos (añadido el 2026-08-24)
 *
 * A las dos de arriba se sumó una tercera, y es la que da seguridad: el **teléfono verificado**
 * —el que el propio canal probó—. Vive en el Principal (`telefono_verificado`) porque es
 * autorización, no dato de dominio, y se distingue del teléfono que la persona *dijo*, que
 * sigue viniendo de `conversacion.variables`. Decir no es probar: de esa distinción cuelga que
 * un cliente pueda cancelar su cita y no la de otro. Ver `registrarCanalConIdentidad`.
 *
 * ## Lo que este resolver sigue SIN hacer (F5-D, decisión consciente)
 *
 * Este resolver no pasa `id_persona_negocio`: `reserva.reservar_turno` sigue recibiendo
 * `cliente_nombre` y `cliente_telefono` como texto suelto. Lo que cambió el 2026-09-09 es que
 * eso **ya no deja la cita huérfana**: `citaService.crearCita` resuelve el teléfono contra
 * `platform.persona_negocio` por su cuenta (el mismo `personaNegocioDao` que usa `restaurante`)
 * y guarda el enlace. La costura de datos está cerrada; venga la cita del asistente, del portal
 * público o del mostrador, queda atada a la misma persona.
 *
 * Lo que sigue sin existir es la **capacidad**: no hay `consultar_mis_citas`, así que la FSM
 * tiene que seguir guardándose el código de la cita, y la confirmación proactiva por outbox
 * sigue sin destino que resolver. Añadirla es declararla en el Registry, decidir su política
 * y escribir su adaptador — ver la cabecera de `intelligence/adapters/reserva/index.js`.
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
function principalDeContacto(idNegocio, { telefonoVerificado = null } = {}) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error('principalDeContacto requiere un id_negocio válido.');
    }
    return crearPrincipal({
        tipo: TIPO.CONTACTO,
        idUsuario: null,
        esSuperAdmin: false,
        negocios: new Map([[id, []]]),
        telefonoVerificado,
    });
}

// ── Canales cuyo `id_externo` ES una identidad probada ──────────────────────────────────────
//
// La diferencia importa y no es cosmética:
//
//   · **WhatsApp**: el `id_externo` es el `from` del webhook, que llega dentro de un cuerpo
//     firmado por Meta (HMAC-SHA256, ver `channels/whatsapp/firma.js`). Nadie puede afirmar ser
//     otro número sin falsificar esa firma. Es una identidad **autenticada**.
//   · **WebChat**: el `id_externo` es una sesión de navegador que se inventa el propio cliente.
//     No prueba nada de nadie.
//
// Se registra desde la composición (`intelligence/index.js`) y no se deduce aquí con un
// `if (canal === 'whatsapp')`, por la misma regla que el resto del motor: **el núcleo no sabe
// qué canales existen**. Si lo supiera, añadir un canal obligaría a editar el motor, que es
// justo lo que ADR-017 evita.
const CANALES_CON_IDENTIDAD = new Set();

/**
 * Declara que en este canal el `id_externo` es un teléfono probado por el propio canal.
 *
 * **Solo debe llamarse para canales que autentican de verdad.** Registrar aquí un canal que no
 * lo hace convierte «lo que alguien escribió» en «lo que la plataforma probó», y a partir de
 * ahí las comprobaciones de pertenencia dejan de valer nada sin que nada falle a la vista.
 */
function registrarCanalConIdentidad(canal) {
    if (!canal || typeof canal !== 'string') {
        throw new Error('registrarCanalConIdentidad requiere el nombre del canal.');
    }
    CANALES_CON_IDENTIDAD.add(canal);
}

/** Para los tests y el arranque en frío. */
function limpiarCanalesConIdentidad() {
    CANALES_CON_IDENTIDAD.clear();
}

/**
 * El teléfono que el canal probó para esta conversación, o `null`.
 *
 * Nunca mira `conversacion.variables`: eso es lo que la persona **dijo**, y decir no es probar.
 */
function telefonoVerificadoDe(conversacion) {
    if (!conversacion || !CANALES_CON_IDENTIDAD.has(conversacion.canal)) return null;
    return normalizarTelefono(conversacion.id_externo);
}

/**
 * Normaliza un teléfono a E.164, que es como lo guarda `persona_negocio`.
 *
 * Devuelve `null` en vez de adivinar cuando no cuadra. Es deliberado: una persona creada a
 * partir de un teléfono mal normalizado es peor que no crearla, porque queda como un duplicado
 * silencioso que nadie va a limpiar. El backfill de F0 ya pagó esa lección — los cinco
 * formatos del mismo móvil que colapsan en una sola persona salen justo de aquí.
 *
 * ## ⚠️ Era solo colombiano, y eso tapió a un cliente entero (corregido 2026-09-29)
 *
 * Las tres reglas de abajo cubren Colombia y **nada más**. El `from` de un webhook de WhatsApp
 * llega siempre con indicativo de país y sin `+` (`56912345678` para un móvil chileno), así que
 * para el primer cliente fuera de Colombia —D'ALEX BARBERIA, Chile— esta función devolvía
 * `null` para todos sus clientes. Y como devuelve el **teléfono verificado**, del que cuelga
 * toda la identidad, el efecto en cadena era:
 *
 *   · el Principal se quedaba sin `telefono_verificado`;
 *   · no se encontraba su `persona_negocio`, así que el bot no reconocía a quien ya había ido;
 *   · y `buscarCitaPorCodigo` —que falla cerrada a propósito— **denegaba cancelar o mover
 *     cualquier cita**, porque no podía comprobar de quién era.
 *
 * Nada de eso daba un error: simplemente el bot trataba a todo cliente chileno como a un
 * desconocido y le decía que llamara al negocio.
 *
 * La corrección **no** intenta adivinar el país: acepta tal cual lo que ya viene en formato
 * internacional, que es lo que manda el canal, y deja las reglas colombianas para los números
 * sin indicativo (que es de donde vienen, por ejemplo, los que teclea una persona).
 */
function normalizarTelefono(entrada) {
    if (!entrada) return null;
    const digitos = String(entrada).replace(/\D/g, '');
    if (!digitos) return null;

    // ── Colombia sin indicativo: lo que escribe una persona ──
    // Móvil nacional: 10 dígitos empezando por 3.
    if (digitos.length === 10 && digitos.startsWith('3')) return `+57${digitos}`;
    // Ya viene con indicativo país.
    if (digitos.length === 12 && digitos.startsWith('573')) return `+${digitos}`;
    // Fijo con indicativo de ciudad (Bogotá 601, etc.).
    if (digitos.length === 10 && /^[1-8]/.test(digitos)) return `+57${digitos}`;

    // ── Cualquier país, ya con indicativo ──
    // Es la forma en que WhatsApp entrega el remitente, y la única que permite atender a un
    // negocio fuera de Colombia. El rango 11–15 es el de E.164 con indicativo incluido: por
    // debajo de 11 se solaparía con los casos colombianos de arriba, que son más específicos y
    // por eso van primero.
    if (digitos.length >= 11 && digitos.length <= 15) return `+${digitos}`;

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
 * @param {Object} [opciones]
 * @param {string} [opciones.nombrePerfil] — el nombre que el canal trae del perfil de la persona
 *        (en WhatsApp, `contacts[].profile.name`). Es la **última** opción y por eso llega aparte:
 *        no lo dijo en esta conversación ni lo registró el negocio, lo tiene puesto en su teléfono.
 *        Sirve para no preguntar lo que ya se sabe; `nombreEsPista` dice que conviene poder
 *        corregirlo antes de escribirlo en una cita.
 * @returns {Promise<{principal, persona, telefono, nombre, nombreEsPista}>}
 */
async function resolver(conversacion, opciones = {}) {
    const idNegocio = Number(conversacion.id_negocio);

    // Lo que el canal PROBÓ. Va al Principal porque es autorización, no dato de dominio.
    const telefonoVerificado = telefonoVerificadoDe(conversacion);
    const principal = principalDeContacto(idNegocio, { telefonoVerificado });

    // Lo que la persona DIJO. Sigue sirviendo para no volver a preguntar, y en WebChat es lo
    // único que hay. Cuando el canal probó un número, ese manda: nadie se identifica a sí
    // mismo mejor que la red por la que escribe.
    const telefonoDicho = normalizarTelefono(conversacion.variables?.telefono);
    const telefono = telefonoVerificado ?? telefonoDicho;

    const persona = telefono
        ? await buscarPersonaPorTelefono(idNegocio, telefono, opciones)
        : null;

    // Tres orígenes, de más fiable a menos. Lo que dijo en esta conversación manda sobre la ficha
    // —si se corrige el nombre, la corrección es más reciente—, y la ficha manda sobre el perfil
    // del canal, que no lo escribió para nosotros.
    const dicho = conversacion.variables?.nombre ?? null;
    const registrado = persona?.nombre_mostrado ?? null;
    const delPerfil = nombreLegible(opciones.nombrePerfil);
    const nombre = dicho ?? registrado ?? delPerfil;

    return {
        principal,
        persona,
        telefonoVerificado,
        telefono: persona?.telefono_e164 ?? telefono,
        nombre,
        // Solo el del perfil es una pista: quien lo consuma tiene que dejar corregirlo antes de
        // escribirlo en una cita o una orden.
        nombreEsPista: Boolean(!dicho && !registrado && delPerfil),
    };
}

/**
 * El nombre del perfil, si sirve como nombre de una persona.
 *
 * Lo pone el cliente en su propio teléfono, así que llega de todo: un emoji, un apodo de empresa,
 * un número. Se exige **algo de letra y dos caracteres**, que es lo que separa «Juan» de «🔥» sin
 * entrar a juzgar cómo se llama la gente. Lo que no pase por aquí se trata como si no hubiera
 * nombre, y el asistente pregunta como siempre.
 */
function nombreLegible(valor) {
    const limpio = String(valor ?? '').trim().replace(/\s+/g, ' ');
    if (limpio.length < 2 || limpio.length > 80) return null;
    return /\p{L}{2}/u.test(limpio) ? limpio : null;
}

module.exports = {
    resolver,
    principalDeContacto,
    registrarCanalConIdentidad,
    limpiarCanalesConIdentidad,
    telefonoVerificadoDe,
    normalizarTelefono,
    buscarPersonaPorTelefono,
    nombreLegible,
};
