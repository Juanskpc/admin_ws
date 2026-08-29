'use strict';
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const { alcanceDeNegocios } = require('../../app_core/middleware/auth');

/**
 * Bandeja del inquilino — el dueño del negocio ve sus conversaciones y **responde**.
 *
 * ## Por qué existe, y por qué no bastaba la Consola
 *
 * [`intelligenceConsolaController`](./intelligenceConsolaController.js) ya enseña conversaciones,
 * hilos y métricas, pero es de **super admin** y de **solo lectura**. Su propia cabecera dejó
 * dicho que «un panel por inquilino es otra conversación». Esta es esa conversación, y la trae un
 * problema concreto de producto, no una idea bonita:
 *
 * El handoff funciona —el bot reconoce que no sabe, promete una persona y se calla (ADR-023)—
 * pero **la persona no tenía dónde contestar**. El número está conectado a la Cloud API, así que
 * deja de funcionar en la app de WhatsApp del móvil: el negocio no puede «coger el teléfono». El
 * cliente final recibía una promesa honesta y luego silencio, que es justo lo que el handoff se
 * escribió para evitar.
 *
 * ## Las tres decisiones que gobiernan este archivo
 *
 * 1. **El `id_negocio` de la petición no se cree nunca.** Se cruza contra
 *    `alcanceDeNegocios()`, y en el detalle se comprueba contra el negocio **de la fila**, no
 *    contra lo que venga en la URL. Es la frontera entre dos clientes: F2 ya cerró una fuga real
 *    aquí.
 * 2. **No se importa `intelligence/`.** Mismo patrón que la Consola y que la Ficha 360: se lee y
 *    se escribe el esquema con SQL. Así sigue en pie el test del apagón de ADR-005 — se borra el
 *    directorio y el backend arranca igual. Ver abajo cómo se envía sin importarlo.
 * 3. **Responder implica handoff.** Quien contesta a mano toma la conversación, y el bot se
 *    calla para siempre en ella. No es un efecto secundario: es la decisión 3 de ADR-023 («el bot
 *    no vuelve»), y hacerlo aquí evita el peor escenario posible, que es el asistente y una
 *    persona escribiendo encima del otro al mismo cliente.
 *
 * ## Cómo sale un mensaje sin importar el canal
 *
 * No se llama a la Cloud API desde aquí. Se **inserta la fila saliente en `estado_entrega =
 * 'pendiente'`** y el Channel Gateway, que ya recorre esa tabla cada pocos segundos
 * (`reclamarSalientesPendientes`), la entrega con sus reintentos y su backoff. Es la entrega
 * asíncrona de ADR-016 usada tal cual, y tiene una propiedad que un `fetch` directo no tendría:
 * si Intelligence está apagado, el mensaje no se pierde ni revienta la petición — se queda
 * esperando, y el endpoint ya avisó de que el canal no está activo.
 */

const LIMITE_POR_DEFECTO = 30;
const LIMITE_MAXIMO = 100;

/** Las 24 h de Meta. La fuente de verdad es `intelligence/channels/whatsapp/ventana.js`. */
const VENTANA_HORAS = Number(process.env.WHATSAPP_VENTANA_HORAS || 24);

/** Estado en el que el motor deja de contestar. Está en el CHECK de `intelligence.conversacion`. */
const ESTADO_HANDOFF = 'handoff_humano';

/**
 * El negocio atado al único número configurado, o `null` si no hay canal configurado aquí.
 *
 * ## Por qué esto existe, y por qué es temporal
 *
 * Hasta F8-C el canal tiene **un solo número global** (`WHATSAPP_PHONE_NUMBER_ID`) y `entregar()`
 * compone la URL con él sin mirar de quién es la conversación. Con dos inquilinos eso significa
 * que una respuesta escrita para el cliente del negocio B **sale por el número del negocio A**, y
 * al cliente le contesta una empresa que no es la suya. No es hipotético: el 2026-08-28 un
 * recordatorio de la peluquería salió por el número del restaurante, la persona contestó «No
 * puedo ir» y le respondió el asistente del restaurante ofreciéndole domicilio.
 *
 * La bandeja no puede arreglar eso —el arreglo es el punto 6 de F8-C— pero sí puede **negarse a
 * causarlo**. Fail-closed: si el número configurado es de otro negocio, no se envía.
 *
 * Cuando no hay canal configurado (desarrollo), devuelve `null` y no estorba: sin número no hay
 * envío equivocado posible.
 */
function negocioDelNumero() {
    const valor = process.env.WHATSAPP_NEGOCIO_ID;
    if (!valor || !process.env.WHATSAPP_PHONE_NUMBER_ID) return null;
    const n = Number(valor);
    return Number.isInteger(n) && n > 0 ? n : null;
}

const SELECT = { type: Models.sequelize.QueryTypes.SELECT };

async function hayEsquemaIntelligence() {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'intelligence' AND table_name = 'conversacion' LIMIT 1;`,
        SELECT
    );
    return filas.length > 0;
}

function sinEsquema(res) {
    return Respuesta.success(res, 'El módulo de conversaciones no está instalado', {
        disponible: false,
        conversaciones: [],
    });
}

function revisar(req, res) {
    const errores = validationResult(req);
    if (errores.isEmpty()) return true;
    Respuesta.error(res, 'Datos de entrada inválidos', 400, errores.array());
    return false;
}

/**
 * Traduce el alcance del usuario a un fragmento de SQL y sus parámetros.
 *
 * Devolver el filtro en vez de la lista de ids evita el error clásico de construir un `IN ()`
 * vacío —que en Postgres es un error de sintaxis, no una lista vacía— cuando el usuario no
 * tiene ningún negocio.
 */
function filtroDeNegocio(alcance, idNegocioPedido) {
    if (alcance.superAdmin) {
        return idNegocioPedido
            ? { sql: 'c.id_negocio = :idNegocio', repl: { idNegocio: idNegocioPedido } }
            : { sql: 'TRUE', repl: {} };
    }
    if (alcance.idNegocios.length === 0) return { sql: 'FALSE', repl: {} };

    // Si pide uno concreto tiene que estar entre los suyos; si no pide ninguno, se ven todos
    // los suyos. En ningún caso se usa el valor de la URL sin cruzarlo.
    if (idNegocioPedido) {
        if (!alcance.idNegocios.includes(idNegocioPedido)) return { sql: 'FALSE', repl: {} };
        return { sql: 'c.id_negocio = :idNegocio', repl: { idNegocio: idNegocioPedido } };
    }
    // `IN` y no `ANY()`: Sequelize expande un array de reemplazo a una lista separada por
    // comas, que es lo que `IN` espera y lo que `ANY()` rechaza.
    return { sql: 'c.id_negocio IN (:idNegocios)', repl: { idNegocios: alcance.idNegocios } };
}

/**
 * Estado de la ventana de 24 h de una conversación.
 *
 * Es la misma regla que `intelligence/channels/whatsapp/ventana.js` —el mayor de los últimos
 * entrantes, tomando el **menor** entre el reloj de Meta (`enviado_en`) y el nuestro
 * (`creado_en`), porque equivocarse hacia «abierta» es el error peligroso—, reescrita aquí porque
 * este controlador no puede importar `intelligence/` (ADR-005). Si aquella cambia, esta cambia.
 *
 * El acotado por `creado_en` no es decorativo: es la clave de partición y sin él la consulta
 * barre las quince particiones.
 */
async function estadoVentana(idConversacion) {
    const margen = VENTANA_HORAS + 24;
    const [fila] = await Models.sequelize.query(
        `
        SELECT max(LEAST(COALESCE(enviado_en, creado_en), creado_en)) AS ultimo
          FROM intelligence.mensaje
         WHERE id_conversacion = :id
           AND direccion = 'entrante'
           AND creado_en > now() - (:margen || ' hours')::interval;
        `,
        { replacements: { id: idConversacion, margen: String(margen) }, ...SELECT }
    );

    const ultimo = fila?.ultimo ? new Date(fila.ultimo) : null;
    if (!ultimo) return { abierta: false, ultimo_entrante_en: null, expira_en: null };

    const expira = new Date(ultimo.getTime() + VENTANA_HORAS * 3600 * 1000);
    return {
        abierta: expira > new Date(),
        ultimo_entrante_en: ultimo,
        expira_en: expira,
    };
}

/**
 * GET /admin/intelligence/bandeja/conversaciones
 *
 * Ordenadas por lo último que pasó, no por cuándo empezaron: una bandeja se lee por arriba.
 * `escalada` sube a columna propia porque es la única razón por la que alguien abre esto con
 * prisa.
 */
async function listarConversaciones(req, res) {
    try {
        if (!revisar(req, res)) return;
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const alcance = await alcanceDeNegocios(req.usuario.id_usuario);
        const idNegocio = req.query.id_negocio ? Number(req.query.id_negocio) : null;
        const filtro = filtroDeNegocio(alcance, idNegocio);

        const limite = Math.min(Number(req.query.limite) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
        const soloEscaladas = String(req.query.solo_escaladas || '') === 'true';

        const conversaciones = await Models.sequelize.query(
            `
            SELECT c.id_conversacion, c.id_negocio, c.estado, c.canal, c.id_externo,
                   c.creado_en, c.ultimo_mensaje_en,
                   n.nombre AS negocio,
                   pn.nombre_mostrado AS persona,
                   pn.telefono_e164,
                   (c.estado = :handoff AND c.atendida_en IS NULL) AS escalada,
                   (SELECT m.contenido
                      FROM intelligence.mensaje m
                     WHERE m.id_conversacion = c.id_conversacion
                     ORDER BY m.creado_en DESC
                     LIMIT 1) AS ultimo_texto
              FROM intelligence.conversacion c
              LEFT JOIN general.gener_negocio n      ON n.id_negocio = c.id_negocio
              LEFT JOIN platform.persona_negocio pn  ON pn.id_persona_negocio = c.id_persona_negocio
             WHERE ${filtro.sql}
               ${soloEscaladas ? 'AND c.estado = :handoff AND c.atendida_en IS NULL' : ''}
             ORDER BY COALESCE(c.ultimo_mensaje_en, c.creado_en) DESC
             LIMIT :limite;
            `,
            {
                replacements: { ...filtro.repl, handoff: ESTADO_HANDOFF, limite },
                ...SELECT,
            }
        );

        // Los negocios que de verdad tienen conversaciones. NO se sacan de la sesión del
        // usuario: ahí están TODOS sus negocios —parqueadero, gimnasio, tienda— y ninguno de
        // esos va a tener nunca una conversación, así que eran filtros que no filtran nada.
        //
        // Tampoco se consulta el plan: eso vive en `intelligence/core/features.js` y este
        // controlador no puede importar `intelligence/` (ADR-005). Derivarlo de lo que hay es
        // además más honesto — un negocio con el plan pero sin una sola conversación no
        // necesita una pastilla que no filtra nada, y le aparece sola en cuanto reciba la
        // primera.
        //
        // Se calcula sin el filtro de negocio ni el de escaladas: si no, al pulsar una
        // pastilla desaparecerían las demás.
        const alcanceTodo = filtroDeNegocio(alcance, null);
        const negocios = await Models.sequelize.query(
            `
            SELECT DISTINCT c.id_negocio, n.nombre
              FROM intelligence.conversacion c
              LEFT JOIN general.gener_negocio n ON n.id_negocio = c.id_negocio
             WHERE ${alcanceTodo.sql}
             ORDER BY n.nombre;
            `,
            { replacements: { ...alcanceTodo.repl }, ...SELECT }
        );

        return Respuesta.success(res, 'Conversaciones', {
            disponible: true,
            conversaciones,
            negocios,
        });
    } catch (err) {
        console.error('Error en bandeja.listarConversaciones:', err);
        return Respuesta.error(res, 'Error al listar las conversaciones');
    }
}

/**
 * Busca la conversación y comprueba que el usuario puede verla.
 *
 * Se resuelve contra el `id_negocio` **de la fila**, nunca contra el de la URL. Y una
 * conversación de otro negocio contesta **404, no 403**: un 403 confirmaría que ese id existe,
 * que es filtrar información entre inquilinos por la puerta de atrás.
 */
async function cargarConversacionPermitida(idConversacion, idUsuario) {
    const [conversacion] = await Models.sequelize.query(
        `
        SELECT c.*, n.nombre AS negocio, pn.nombre_mostrado AS persona, pn.telefono_e164
          FROM intelligence.conversacion c
          LEFT JOIN general.gener_negocio n      ON n.id_negocio = c.id_negocio
          LEFT JOIN platform.persona_negocio pn  ON pn.id_persona_negocio = c.id_persona_negocio
         WHERE c.id_conversacion = :id;
        `,
        { replacements: { id: idConversacion }, ...SELECT }
    );
    if (!conversacion) return null;

    const alcance = await alcanceDeNegocios(idUsuario);
    if (alcance.superAdmin) return conversacion;
    if (alcance.idNegocios.includes(Number(conversacion.id_negocio))) return conversacion;
    return null;
}

/** GET /admin/intelligence/bandeja/conversaciones/:id */
async function detalleConversacion(req, res) {
    try {
        if (!revisar(req, res)) return;
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const conversacion = await cargarConversacionPermitida(
            req.params.id,
            req.usuario.id_usuario
        );
        if (!conversacion) return Respuesta.error(res, 'Conversación no encontrada', 404);

        const mensajes = await Models.sequelize.query(
            `
            SELECT id_mensaje, direccion, canal, contenido, estado_entrega,
                   enviado_en, entregado_en, creado_en
              FROM intelligence.mensaje
             WHERE id_conversacion = :id
             ORDER BY creado_en ASC;
            `,
            { replacements: { id: req.params.id }, ...SELECT }
        );

        return Respuesta.success(res, 'Conversación', {
            disponible: true,
            conversacion,
            mensajes,
            ventana: await estadoVentana(req.params.id),
        });
    } catch (err) {
        console.error('Error en bandeja.detalleConversacion:', err);
        return Respuesta.error(res, 'Error al leer la conversación');
    }
}

/**
 * POST /admin/intelligence/bandeja/conversaciones/:id/responder
 *
 * Escribe una respuesta humana y **toma la conversación**: el bot deja de contestar en ella.
 *
 * Se rechaza fuera de la ventana de 24 h en vez de dejar que falle al entregar. La Cloud API
 * rechazaría el envío igualmente, pero varias capas más abajo y de forma asíncrona: el usuario
 * habría visto su mensaje aceptado y nunca sabría que no llegó. Un 409 con el instante en que
 * expiró es la única respuesta honesta.
 */
async function responder(req, res) {
    const t = await Models.sequelize.transaction();
    try {
        if (!revisar(req, res)) {
            await t.rollback();
            return;
        }
        if (!(await hayEsquemaIntelligence())) {
            await t.rollback();
            return Respuesta.error(res, 'El módulo de conversaciones no está instalado', 503);
        }

        const conversacion = await cargarConversacionPermitida(
            req.params.id,
            req.usuario.id_usuario
        );
        if (!conversacion) {
            await t.rollback();
            return Respuesta.error(res, 'Conversación no encontrada', 404);
        }

        // Antes que nada, el cerrojo del número: o sale por el del negocio dueño, o no sale.
        const numeroDe = negocioDelNumero();
        if (numeroDe !== null && numeroDe !== Number(conversacion.id_negocio)) {
            await t.rollback();
            return Respuesta.error(
                res,
                'Este negocio todavía no tiene su propio número de WhatsApp conectado. Responder ahora enviaría el mensaje desde el número de otro negocio.',
                409,
                [{ codigo: 'NUMERO_DE_OTRO_NEGOCIO', id_negocio: conversacion.id_negocio }]
            );
        }

        const ventana = await estadoVentana(req.params.id);
        if (!ventana.abierta) {
            await t.rollback();
            return Respuesta.error(
                res,
                ventana.ultimo_entrante_en
                    ? 'La ventana de 24 horas se cerró: WhatsApp ya no permite texto libre en esta conversación.'
                    : 'Esta persona todavía no ha escrito: WhatsApp no permite iniciar la conversación con texto libre.',
                409,
                [{ codigo: 'VENTANA_CERRADA', expiro_en: ventana.expira_en }]
            );
        }

        const texto = String(req.body.texto).trim();

        // Nace `pendiente` a propósito: quien lo entrega es el Channel Gateway, con sus
        // reintentos. Ver la cabecera de este archivo.
        // `crudo.origen = 'humano'` no es telemetría: es lo que impide que el asistente lea lo
        // que dijo una persona **como si lo hubiera dicho él**. Sin la marca, al devolverle la
        // conversación sostendría compromisos que nunca hizo — el hueco 1 de ADR-023 entrando
        // por la puerta de atrás. Ver la Enmienda 1, condición 2.
        const [fila] = await Models.sequelize.query(
            `
            INSERT INTO intelligence.mensaje
                (id_conversacion, id_negocio, direccion, canal, contenido, opciones, estado_entrega,
                 crudo)
            VALUES (:idConversacion, :idNegocio, 'saliente', :canal, :texto, '[]'::jsonb, 'pendiente',
                    CAST(:crudo AS jsonb))
            RETURNING id_mensaje, creado_en;
            `,
            {
                replacements: {
                    idConversacion: conversacion.id_conversacion,
                    idNegocio: conversacion.id_negocio,
                    canal: conversacion.canal,
                    texto,
                    crudo: JSON.stringify({ origen: 'humano', id_usuario: req.usuario.id_usuario }),
                },
                type: Models.sequelize.QueryTypes.INSERT,
                transaction: t,
            }
        );

        // El bot se calla, y la conversación deja de estar esperando: contestar es exactamente
        // ocuparse de ella.
        //
        // Las dos cosas van juntas y en el mismo UPDATE porque son la misma decisión humana.
        // Sin `atendida_en`, responder dejaba la conversación marcada como pendiente PARA
        // SIEMPRE —`handoff_humano` es lo que la marcaba, y responder es lo que lo pone—, así
        // que la lista de lo que espera solo podía crecer.
        await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET estado = :handoff, atendida_en = now()
              WHERE id_conversacion = :id;`,
            {
                replacements: { id: conversacion.id_conversacion, handoff: ESTADO_HANDOFF },
                transaction: t,
            }
        );

        await Audit.registrarEvento({
            modulo: 'intelligence',
            accion: 'respuesta_humana',
            idUsuario: req.usuario.id_usuario,
            idNegocio: conversacion.id_negocio,
            detalle: {
                id_conversacion: conversacion.id_conversacion,
                estado_anterior: conversacion.estado,
                caracteres: texto.length,
            },
            transaction: t,
        });

        await t.commit();

        return Respuesta.success(res, 'Respuesta encolada', {
            id_mensaje: fila?.[0]?.id_mensaje ?? null,
            estado_conversacion: ESTADO_HANDOFF,
            // Que quede claro en la respuesta: aceptada no es entregada.
            estado_entrega: 'pendiente',
        });
    } catch (err) {
        await t.rollback();
        console.error('Error en bandeja.responder:', err);
        return Respuesta.error(res, 'Error al enviar la respuesta');
    }
}

/**
 * POST /admin/intelligence/bandeja/conversaciones/:id/atender
 *
 * «Ya me ocupé de esto» — sin escribir nada.
 *
 * Hace falta porque no todo lo que el bot escala se resuelve por el chat: se llama al cliente,
 * se le atiende en el local, o simplemente no había nada que contestar. Sin esto, la única
 * forma de quitar algo de la lista era mandarle un mensaje a alguien que ya no lo necesitaba.
 *
 * ⚠️ **No devuelve la conversación al bot**, y eso es deliberado. `estado` sigue en
 * `handoff_humano`: la decisión 3 de ADR-023 —«el bot no vuelve»— se tomó para no contradecir
 * lo que ya se le prometió al cliente, y esto no la toca. Lo único que cambia es si a una
 * persona le queda algo por hacer.
 *
 * Si el cliente vuelve a escribir, la ingesta pone `atendida_en` a NULL y reaparece.
 */
async function atender(req, res) {
    try {
        if (!revisar(req, res)) return;
        if (!(await hayEsquemaIntelligence())) {
            return Respuesta.error(res, 'El módulo de conversaciones no está instalado', 503);
        }

        const conversacion = await cargarConversacionPermitida(
            req.params.id,
            req.usuario.id_usuario
        );
        if (!conversacion) return Respuesta.error(res, 'Conversación no encontrada', 404);

        await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET atendida_en = now()
              WHERE id_conversacion = :id AND atendida_en IS NULL;`,
            { replacements: { id: conversacion.id_conversacion } }
        );

        await Audit.registrarEvento({
            modulo: 'intelligence',
            accion: 'conversacion_atendida',
            idUsuario: req.usuario.id_usuario,
            idNegocio: conversacion.id_negocio,
            detalle: { id_conversacion: conversacion.id_conversacion, sin_responder: true },
        });

        return Respuesta.success(res, 'Marcada como atendida', { escalada: false });
    } catch (err) {
        console.error('Error en bandeja.atender:', err);
        return Respuesta.error(res, 'Error al marcar la conversación');
    }
}

/**
 * POST /admin/intelligence/bandeja/conversaciones/:id/devolver-al-asistente
 *
 * «Ya terminé de hablar con esta persona: que siga el asistente.»
 *
 * ## Esto toca un ADR, y por eso lleva tanto comentario
 *
 * [ADR-023](../../docs/adr/ADR-023-guardarrailes.md) decidió que **el bot no vuelve**. La
 * **Enmienda 1 (2026-08-29)** acota qué prohibía esa frase: no que el bot vuelva nunca, sino que
 * vuelva **solo**. La promesa que se le hizo al cliente era «le responde una persona», y esa
 * promesa se cumple en cuanto una persona responde; lo que pase después ya no la contradice.
 *
 * Las tres condiciones que hacen que esto no sea revocar el ADR:
 *
 * 1. **Nace de un clic, nunca de un temporizador.** No hay caducidad. Si nadie pulsa, la
 *    conversación sigue siendo del humano para siempre — el comportamiento anterior.
 * 2. **El asistente hereda el contexto sabiendo que era de otro**: los mensajes escritos a mano
 *    llevan `crudo.origen = 'humano'` y el historial se los da marcados.
 * 3. **Si vuelve a no saber, vuelve a escalar.** Aquí no se desactiva nada del handoff; el
 *    segundo escalado se comporta igual que el primero.
 *
 * Y `atendida_en` se deja puesta: la conversación vuelve al asistente **y** deja de esperar a
 * nadie. Son las dos cosas a la vez y las dos las decide la misma persona en el mismo clic.
 */
async function devolverAlAsistente(req, res) {
    try {
        if (!revisar(req, res)) return;
        if (!(await hayEsquemaIntelligence())) {
            return Respuesta.error(res, 'El módulo de conversaciones no está instalado', 503);
        }

        const conversacion = await cargarConversacionPermitida(
            req.params.id,
            req.usuario.id_usuario
        );
        if (!conversacion) return Respuesta.error(res, 'Conversación no encontrada', 404);

        if (conversacion.estado !== ESTADO_HANDOFF) {
            // No es un error: el asistente ya la lleva. Contestar 200 evita que el panel enseñe
            // un fallo por pulsar dos veces.
            return Respuesta.success(res, 'El asistente ya lleva esta conversación', {
                estado: conversacion.estado,
            });
        }

        await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET estado = 'activa', atendida_en = now()
              WHERE id_conversacion = :id AND estado = :handoff;`,
            {
                replacements: { id: conversacion.id_conversacion, handoff: ESTADO_HANDOFF },
            }
        );

        // Se audita con nombre propio y no como una edición cualquiera: es el único camino del
        // sistema que devuelve una conversación al asistente, y si algún día el bot dice algo
        // raro después de un handoff, esta fila es la que lo explica.
        await Audit.registrarEvento({
            modulo: 'intelligence',
            accion: 'conversacion_devuelta_al_asistente',
            idUsuario: req.usuario.id_usuario,
            idNegocio: conversacion.id_negocio,
            detalle: {
                id_conversacion: conversacion.id_conversacion,
                adr: 'ADR-023 Enmienda 1',
            },
        });

        return Respuesta.success(res, 'El asistente retoma la conversación', { estado: 'activa' });
    } catch (err) {
        console.error('Error en bandeja.devolverAlAsistente:', err);
        return Respuesta.error(res, 'Error al devolver la conversación al asistente');
    }
}

module.exports = {
    listarConversaciones,
    detalleConversacion,
    responder,
    atender,
    devolverAlAsistente,
};
