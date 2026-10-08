'use strict';
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const { alcanceDeNegocios } = require('../../app_core/middleware/auth');
// Quién ve la Bandeja: administrador siempre, cajero si el plan incluye WhatsApp (2026-10-04).
const { alcanceBandeja } = require('../services/accesoBandejaService');
const PreparacionAsistente = require('../services/preparacionAsistenteService');
const { Readable } = require('stream');

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

        const alcance = await alcanceBandeja(req.usuario.id_usuario);
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
             -- Por fecha. Anclar arriba las que esperan respuesta se probó y se retiró el mismo día
             -- (2026-10-02): muchas solo «esperaban» un «gracias». Están en el filtro «Esperan respuesta».
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
        SELECT c.*, n.nombre AS negocio, n.reactivar_asistente_min,
               pn.nombre_mostrado AS persona, pn.telefono_e164
          FROM intelligence.conversacion c
          LEFT JOIN general.gener_negocio n      ON n.id_negocio = c.id_negocio
          LEFT JOIN platform.persona_negocio pn  ON pn.id_persona_negocio = c.id_persona_negocio
         WHERE c.id_conversacion = :id;
        `,
        { replacements: { id: idConversacion }, ...SELECT }
    );
    if (!conversacion) return null;

    const alcance = await alcanceBandeja(idUsuario);
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
                   enviado_en, entregado_en, creado_en,
                   -- Si trae archivo (foto, sticker, audio…): qué es, para que la Bandeja lo pida
                   -- a /archivo. El id de Meta no sale: no le sirve al navegador.
                   CASE WHEN direccion = 'entrante' AND crudo -> 'media' ->> 'id' IS NOT NULL
                        THEN jsonb_build_object(
                                 'tipo', crudo ->> 'tipo',
                                 'mime', crudo -> 'media' ->> 'mime',
                                 'caption', crudo -> 'media' ->> 'caption',
                                 'nombre', crudo -> 'media' ->> 'nombre')
                   END AS media,
                   -- Lo editó o lo borró quien lo escribió (el cliente o el negocio, desde WhatsApp).
                   COALESCE((crudo ->> 'editado')::boolean, false) AS editado,
                   COALESCE((crudo ->> 'eliminado')::boolean, false) AS eliminado
              FROM intelligence.mensaje
             WHERE id_conversacion = :id
             ORDER BY creado_en ASC;
            `,
            { replacements: { id: req.params.id }, ...SELECT }
        );

        // Cuándo el asistente retomó la conversación, y quién lo decidió: el sistema (por el plazo
        // del negocio) o una persona (el botón). Va en el hilo para que quien lea entienda por
        // qué el asistente vuelve a contestar. Se lee de la auditoría, que ya lo guarda.
        const retomadas = await Models.sequelize.query(
            `
            SELECT e.fecha, e.accion,
                   CASE WHEN e.accion = 'asistente_retomo_automatico' THEN 'automatico'
                        ELSE 'manual' END AS origen,
                   TRIM(COALESCE(u.primer_nombre, '') || ' ' || COALESCE(u.primer_apellido, '')) AS quien
              FROM auditoria.audit_evento e
              LEFT JOIN general.gener_usuario u ON u.id_usuario = e.id_usuario
             WHERE e.modulo = 'intelligence'
               AND e.accion IN ('asistente_retomo_automatico', 'conversacion_devuelta_al_asistente')
               AND e.id_negocio = :idNegocio
               AND e.detalle ->> 'id_conversacion' = :id
             ORDER BY e.fecha ASC
             LIMIT 100;
            `,
            { replacements: { id: req.params.id, idNegocio: conversacion.id_negocio }, ...SELECT }
        );

        return Respuesta.success(res, 'Conversación', {
            disponible: true,
            conversacion,
            mensajes,
            retomadas,
            ventana: await estadoVentana(req.params.id),
        });
    } catch (err) {
        console.error('Error en bandeja.detalleConversacion:', err);
        return Respuesta.error(res, 'Error al leer la conversación');
    }
}

/**
 * GET /admin/intelligence/bandeja/conversaciones/:id/mensajes/:idMensaje/archivo
 *
 * La foto, sticker, audio o documento que mandó el cliente, pedido a Meta en el momento y pasado
 * tal cual al navegador. **No se guarda copia** (decisión del dueño, 2026-10-02: muchos son
 * comprobantes con datos personales). Meta lo conserva 7 días; después contesta 410.
 *
 * Mismos permisos que el detalle: la conversación se resuelve con `cargarConversacionPermitida`
 * (ajena → 404) y el mensaje tiene que ser DE esa conversación.
 */
async function archivoDeMensaje(req, res) {
    try {
        if (!revisar(req, res)) return;
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);

        const conversacion = await cargarConversacionPermitida(req.params.id, req.usuario.id_usuario);
        if (!conversacion) return Respuesta.error(res, 'Conversación no encontrada', 404);

        const [fila] = await Models.sequelize.query(
            `
            SELECT crudo -> 'media' AS media
              FROM intelligence.mensaje
             WHERE id_conversacion = :id AND id_mensaje = :idMensaje AND direccion = 'entrante';
            `,
            { replacements: { id: req.params.id, idMensaje: req.params.idMensaje }, ...SELECT }
        );
        const idArchivo = fila?.media?.id;
        if (!idArchivo) return Respuesta.error(res, 'Ese mensaje no trae un archivo', 404);

        // El mapa número → token del negocio se carga perezoso; sin esto, un servidor recién
        // arrancado usaría el token global y Meta rechazaría la WABA de un cliente con Embedded Signup.
        // Carga DIFERIDA, como hace Despacho con el aviso de «listo»: el panel tiene que cargar
        // aunque Intelligence esté apagado (el espíritu de ADR-005); solo esta ruta lo necesita.
        await require('../../intelligence/channels/whatsapp/numeros').asegurarCargado();
        const WhatsappApi = require('../../intelligence/channels/whatsapp/api');
        let archivo;
        try {
            archivo = await WhatsappApi.obtenerArchivo({ idArchivo, idNegocio: Number(conversacion.id_negocio) });
        } catch (err) {
            if (err.code === 'ARCHIVO_NO_DISPONIBLE') {
                return Respuesta.error(res, 'Este archivo ya no está disponible (WhatsApp lo guarda 7 días).', 410, { code: err.code });
            }
            if (err.code === 'ARCHIVO_DEMASIADO_GRANDE') {
                return Respuesta.error(res, err.message, 413, { code: err.code });
            }
            throw err;
        }

        res.setHeader('Content-Type', archivo.mime || fila.media.mime || 'application/octet-stream');
        if (archivo.bytes) res.setHeader('Content-Length', String(archivo.bytes));
        // Privado y breve: que el navegador no lo vuelva a pedir mientras se mira el chat, pero
        // que ningún intermediario lo guarde.
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        Readable.fromWeb(archivo.respuesta.body).on('error', (e) => {
            console.error('Error en bandeja.archivoDeMensaje (transmisión):', e.message);
            res.destroy(e);
        }).pipe(res);
    } catch (err) {
        console.error('Error en bandeja.archivoDeMensaje:', err.message);
        if (res.headersSent) return res.destroy(err);
        return Respuesta.error(res, 'No se pudo traer el archivo');
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
                SET estado = :handoff, atendida_en = now(), humano_ultimo_en = now()
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
                SET atendida_en = COALESCE(atendida_en, now()), humano_ultimo_en = now()
              WHERE id_conversacion = :id;`,
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

// ── Reactivación del asistente (ADR-023, Enmienda 2) ────────────────────────────────────────

/** ¿Puede este usuario CAMBIAR la configuración de ESE negocio? Administrador de él, o super admin. */
async function esAdministradorDelNegocio(idUsuario, idNegocio) {
    const alcance = await alcanceDeNegocios(idUsuario);
    if (alcance.superAdmin) return true;

    const filas = await Models.sequelize.query(
        `SELECT 1
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          WHERE ur.id_usuario = :idUsuario
            AND ur.id_negocio = :idNegocio
            AND ur.estado = 'A'
            AND UPPER(r.descripcion) LIKE '%ADMINISTRADOR%'
          LIMIT 1;`,
        { replacements: { idUsuario, idNegocio }, ...SELECT }
    );
    return filas.length > 0;
}

/** El negocio que se pide, comprobado contra lo que el usuario puede ver. Nunca se cree el id. */
async function negocioVisible(idUsuario, idNegocio) {
    const alcance = await alcanceBandeja(idUsuario);
    return alcance.superAdmin || alcance.idNegocios.includes(Number(idNegocio));
}

/**
 * GET /admin/intelligence/bandeja/configuracion?id_negocio=
 *
 * Los minutos tras los cuales el asistente vuelve solo a una conversación que atendió una persona
 * (0 = nunca) y si este usuario puede cambiarlos. Un negocio ajeno contesta 404, no 403: un 403
 * confirmaría que existe.
 */
async function leerConfiguracion(req, res) {
    try {
        if (!revisar(req, res)) return;
        const idNegocio = Number(req.query.id_negocio);
        if (!(await negocioVisible(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }
        const [fila] = await Models.sequelize.query(
            `SELECT id_negocio, nombre, reactivar_asistente_min,
                    tiempo_estimado_min, tiempo_estimado_max, info_asistente,
                    domicilio_valor_min, domicilio_valor_max, domicilio_nota,
                    asistente_pausado, asistente_pausado_en,
                    asistente_mira_stock, controla_inventario
               FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, ...SELECT }
        );
        if (!fila) return Respuesta.error(res, 'Negocio no encontrado', 404);

        return Respuesta.success(res, 'Configuración', {
            id_negocio: fila.id_negocio,
            reactivar_asistente_min: fila.reactivar_asistente_min,
            // Lo que el asistente contesta a «¿cuánto se demora?». null = sin configurar.
            tiempo_estimado_min: fila.tiempo_estimado_min,
            tiempo_estimado_max: fila.tiempo_estimado_max,
            // Lo que el asistente le dice al cliente sobre pagos, domicilio, etc. null = nada.
            info_asistente: fila.info_asistente ?? null,
            // Cuánto vale el domicilio, como rango («entre $7.000 y $9.000») + una nota corta.
            domicilio_valor_min: fila.domicilio_valor_min ?? null,
            domicilio_valor_max: fila.domicilio_valor_max ?? null,
            domicilio_nota: fila.domicilio_nota ?? null,
            // Pausa de emergencia: el asistente no contesta a nadie hasta que se reanude.
            asistente_pausado: fila.asistente_pausado === true,
            asistente_pausado_en: fila.asistente_pausado_en ?? null,
            // ¿El asistente deja de ofrecer lo que no tiene insumos? Decisión propia, aparte
            // del control de inventario de caja (que viaja solo para que la pantalla avise).
            asistente_mira_stock: fila.asistente_mira_stock === true,
            controla_inventario: fila.controla_inventario !== false,
            puede_editar: await esAdministradorDelNegocio(req.usuario.id_usuario, idNegocio),
        });
    } catch (err) {
        console.error('Error en bandeja.leerConfiguracion:', err);
        return Respuesta.error(res, 'Error al leer la configuración');
    }
}

/**
 * PUT /admin/intelligence/bandeja/configuracion
 *   { id_negocio, reactivar_asistente_min?, tiempo_estimado_min?, tiempo_estimado_max?,
 *     info_asistente?, domicilio_valor_min?, domicilio_valor_max?, domicilio_nota?,
 *     asistente_mira_stock? }
 *   (cada ajuste es independiente; el tiempo estimado es lo que el asistente contesta a
 *   «¿cuánto se demora?», y null lo borra)
 *
 * Es la decisión EXPLÍCITA del negocio de la Enmienda 2: el asistente vuelve solo a una
 * conversación que atendió una persona, pasados N minutos desde su última intervención. 0 = nunca
 * (el valor de fábrica). Exige ser ADMINISTRADOR de ese negocio: un administrador de otro recibe
 * 403, y queda auditado quién lo cambió y de cuánto a cuánto.
 */
async function guardarConfiguracion(req, res) {
    try {
        if (!revisar(req, res)) return;
        const idNegocio = Number(req.body.id_negocio);

        // Cada ajuste es independiente: el cuerpo trae uno, otro o los dos. Distinguir «no vino» de
        // «vino vacío» es lo que permite borrar el tiempo estimado (null) sin tocar la reactivación.
        const traeReactivacion = req.body.reactivar_asistente_min !== undefined;
        const traeTiempo =
            req.body.tiempo_estimado_min !== undefined || req.body.tiempo_estimado_max !== undefined;
        // Notas libres para el asistente (Nequi, valor del domicilio…). '' o null las borra.
        const traeInfo = req.body.info_asistente !== undefined;
        // Valor del domicilio como rango (2026-10-02): reemplaza cargar el precio barrio por barrio.
        const traeDomicilio =
            req.body.domicilio_valor_min !== undefined ||
            req.body.domicilio_valor_max !== undefined ||
            req.body.domicilio_nota !== undefined;
        // ¿El asistente tiene en cuenta el inventario aunque caja no lo controle? (2026-10-07)
        const traeStock = req.body.asistente_mira_stock !== undefined;
        if (!traeReactivacion && !traeTiempo && !traeInfo && !traeDomicilio && !traeStock) {
            return Respuesta.error(res, 'No hay nada que guardar', 400);
        }

        // Quien no es administrador de ESE negocio recibe 403, sea de otro negocio o del mismo con
        // un rol menor: que el id de un negocio exista no es un secreto, y un mensaje único para
        // los dos casos no filtra nada. La lectura (GET) sí contesta 404 a los ajenos.
        if (!(await esAdministradorDelNegocio(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(
                res,
                'Solo un administrador de este negocio puede cambiar la configuración del asistente.',
                403
            );
        }

        const [antes] = await Models.sequelize.query(
            `SELECT reactivar_asistente_min, tiempo_estimado_min, tiempo_estimado_max, info_asistente,
                    domicilio_valor_min, domicilio_valor_max, domicilio_nota, asistente_mira_stock
               FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, ...SELECT }
        );
        if (!antes) return Respuesta.error(res, 'Negocio no encontrado', 404);

        const nulo = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
        const cambios = [];
        const replacements = { idNegocio };
        let minutos = antes.reactivar_asistente_min;
        let tiempoMin = antes.tiempo_estimado_min;
        let tiempoMax = antes.tiempo_estimado_max;

        if (traeReactivacion) {
            minutos = Number(req.body.reactivar_asistente_min);
            cambios.push('reactivar_asistente_min = :minutos');
            replacements.minutos = minutos;
        }

        if (traeTiempo) {
            // Sin mínimo no hay máximo: «hasta 60 minutos» sin un «desde» no es un estimado que el
            // asistente pueda decir bien. Vaciar el mínimo vacía también el máximo.
            tiempoMin = nulo(req.body.tiempo_estimado_min);
            tiempoMax = tiempoMin === null ? null : nulo(req.body.tiempo_estimado_max);
            if (tiempoMax !== null && tiempoMax < tiempoMin) {
                return Respuesta.error(res, 'El tiempo máximo no puede ser menor que el mínimo', 400);
            }
            cambios.push('tiempo_estimado_min = :tiempoMin', 'tiempo_estimado_max = :tiempoMax');
            replacements.tiempoMin = tiempoMin;
            replacements.tiempoMax = tiempoMax;
        }

        let info = antes.info_asistente ?? null;
        if (traeInfo) {
            info = String(req.body.info_asistente ?? '').trim().slice(0, 1500) || null;
            cambios.push('info_asistente = :info');
            replacements.info = info;
        }

        let domicilioMin = antes.domicilio_valor_min ?? null;
        let domicilioMax = antes.domicilio_valor_max ?? null;
        let domicilioNota = antes.domicilio_nota ?? null;
        if (traeDomicilio) {
            // Igual que el tiempo: sin mínimo no hay máximo, y vaciar el mínimo vacía el máximo.
            // Viene el trío entero desde la Bandeja; lo que no venga se queda como estaba.
            if (req.body.domicilio_valor_min !== undefined || req.body.domicilio_valor_max !== undefined) {
                domicilioMin = nulo(req.body.domicilio_valor_min);
                domicilioMax = domicilioMin === null ? null : nulo(req.body.domicilio_valor_max);
                if (domicilioMax !== null && domicilioMax < domicilioMin) {
                    return Respuesta.error(res, 'El valor máximo del domicilio no puede ser menor que el mínimo', 400);
                }
                if (domicilioMax !== null && domicilioMax === domicilioMin) domicilioMax = null;
            }
            if (req.body.domicilio_nota !== undefined) {
                domicilioNota = String(req.body.domicilio_nota ?? '').trim().slice(0, 200) || null;
            }
            cambios.push(
                'domicilio_valor_min = :domicilioMin',
                'domicilio_valor_max = :domicilioMax',
                'domicilio_nota = :domicilioNota'
            );
            Object.assign(replacements, { domicilioMin, domicilioMax, domicilioNota });
        }

        let miraStock = antes.asistente_mira_stock === true;
        if (traeStock) {
            miraStock = req.body.asistente_mira_stock === true;
            cambios.push('asistente_mira_stock = :miraStock');
            replacements.miraStock = miraStock;
        }

        await Models.sequelize.query(
            `UPDATE general.gener_negocio SET ${cambios.join(', ')} WHERE id_negocio = :idNegocio;`,
            { replacements }
        );

        if (traeStock) {
            await Audit.registrarEvento({
                modulo: 'intelligence',
                accion: 'asistente_mira_stock_configurado',
                idUsuario: req.usuario.id_usuario,
                idNegocio,
                detalle: { antes: antes.asistente_mira_stock === true, despues: miraStock },
            });
        }

        if (traeReactivacion) {
            await Audit.registrarEvento({
                modulo: 'intelligence',
                accion: 'reactivacion_asistente_configurada',
                idUsuario: req.usuario.id_usuario,
                idNegocio,
                detalle: {
                    minutos_antes: antes.reactivar_asistente_min,
                    minutos_despues: minutos,
                    adr: 'ADR-023 Enmienda 2',
                },
            });
        }
        if (traeTiempo) {
            await Audit.registrarEvento({
                modulo: 'intelligence',
                accion: 'tiempo_estimado_configurado',
                idUsuario: req.usuario.id_usuario,
                idNegocio,
                detalle: {
                    antes: { min: antes.tiempo_estimado_min, max: antes.tiempo_estimado_max },
                    despues: { min: tiempoMin, max: tiempoMax },
                },
            });
        }

        if (traeInfo) {
            await Audit.registrarEvento({
                modulo: 'intelligence',
                accion: 'info_asistente_configurada',
                idUsuario: req.usuario.id_usuario,
                idNegocio,
                detalle: { antes: antes.info_asistente ?? null, despues: info },
            });
        }

        if (traeDomicilio) {
            await Audit.registrarEvento({
                modulo: 'intelligence',
                accion: 'domicilio_rango_configurado',
                idUsuario: req.usuario.id_usuario,
                idNegocio,
                detalle: {
                    antes: {
                        min: antes.domicilio_valor_min ?? null,
                        max: antes.domicilio_valor_max ?? null,
                        nota: antes.domicilio_nota ?? null,
                    },
                    despues: { min: domicilioMin, max: domicilioMax, nota: domicilioNota },
                },
            });
        }

        const soloStock = traeStock && !traeDomicilio && !traeInfo && !traeTiempo && !traeReactivacion;
        const mensaje = soloStock
            ? (miraStock
                ? 'El asistente tendrá en cuenta el inventario'
                : 'El asistente ya no tendrá en cuenta el inventario')
            : traeDomicilio && !traeInfo && !traeTiempo && !traeReactivacion
            ? (domicilioMin === null && !domicilioNota
                ? 'El asistente ya no dirá el valor del domicilio'
                : 'Valor del domicilio guardado')
            : traeInfo && !traeTiempo && !traeReactivacion
            ? 'Información para el asistente guardada'
            : traeTiempo && !traeReactivacion
            ? (tiempoMin === null
                ? 'El asistente ya no dará un tiempo estimado de entrega'
                : 'Tiempo estimado de entrega guardado')
            : (minutos === 0
                ? 'El asistente no volverá solo a las conversaciones que atienda una persona'
                : `El asistente volverá solo a los ${minutos} minutos de la última respuesta de una persona`);

        return Respuesta.success(res, mensaje, {
            id_negocio: idNegocio,
            reactivar_asistente_min: minutos,
            tiempo_estimado_min: tiempoMin,
            tiempo_estimado_max: tiempoMax,
            info_asistente: info,
            domicilio_valor_min: domicilioMin,
            domicilio_valor_max: domicilioMax,
            domicilio_nota: domicilioNota,
            asistente_mira_stock: miraStock,
        });
    } catch (err) {
        console.error('Error en bandeja.guardarConfiguracion:', err);
        return Respuesta.error(res, 'Error al guardar la configuración');
    }
}

/**
 * POST /admin/intelligence/bandeja/conversaciones/:id/bloquear
 *
 * «Este número abusa del sistema: que el asistente deje de contestarle.»
 *
 * ## Por qué esto NO es lo mismo que STOP/BAJA, aunque escriba el mismo estado
 *
 * `estado = 'bloqueada'` ya existía para cuando el propio cliente se da de baja (`optout.js`,
 * ADR-023) — es una obligación legal y por eso es irrevocable salvo por un super admin desde
 * la Consola. Esto es otra cosa: un negocio decidiendo, dentro de SU bandeja, que no quiere
 * seguir sirviendo a un número — no hay opt-out de por medio, es moderación.
 *
 * Las dos llegan al mismo estado porque el motor solo necesita saber UNA cosa para callarse
 * (`ESTADOS_PROCESABLES` no incluye `bloqueada`, sea cual sea el motivo). Lo que las distingue
 * es `bloqueada_por` — y es lo que hace que el negocio pueda deshacer SU bloqueo
 * (`desbloquear`, abajo) sin que eso le abra la puerta a deshacer la baja legal de alguien.
 *
 * Idempotente: bloquear algo ya bloqueado no es un error, es la misma decisión otra vez.
 */
async function bloquear(req, res) {
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

        if (conversacion.estado === 'bloqueada') {
            return Respuesta.success(res, 'Ese número ya estaba bloqueado', {
                estado: 'bloqueada',
                bloqueada_por: conversacion.bloqueada_por,
            });
        }

        await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET estado = 'bloqueada', bloqueada_por = 'negocio'
              WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion } }
        );

        await Audit.registrarEvento({
            modulo: 'intelligence',
            accion: 'conversacion_bloqueada_por_negocio',
            idUsuario: req.usuario.id_usuario,
            idNegocio: conversacion.id_negocio,
            detalle: {
                id_conversacion: conversacion.id_conversacion,
                estado_anterior: conversacion.estado,
                motivo: req.body?.motivo ? String(req.body.motivo).trim().slice(0, 300) : null,
            },
        });

        return Respuesta.success(res, 'El asistente ya no le contestará a este número', {
            estado: 'bloqueada',
            bloqueada_por: 'negocio',
        });
    } catch (err) {
        console.error('Error en bandeja.bloquear:', err);
        return Respuesta.error(res, 'Error al bloquear la conversación');
    }
}

/**
 * POST /admin/intelligence/bandeja/conversaciones/:id/desbloquear
 *
 * El reverso de `bloquear` — y SOLO de `bloquear`. Deliberadamente estrecho: solo actúa si
 * `bloqueada_por = 'negocio'`. Una baja por STOP/BAJA sigue exigiendo un super admin desde la
 * Consola (ADR-023): este endpoint no le da al negocio una puerta de atrás para deshacer la
 * baja legal de un cliente con el mismo botón que usa para deshacer su propio error.
 */
async function desbloquear(req, res) {
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

        if (conversacion.estado !== 'bloqueada' || conversacion.bloqueada_por !== 'negocio') {
            return Respuesta.error(
                res,
                conversacion.estado === 'bloqueada'
                    ? 'Esta conversación está bloqueada por baja del propio cliente (STOP/BAJA): solo un administrador de EscalApp puede deshacerla.'
                    : 'Esta conversación no está bloqueada.',
                409
            );
        }

        await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET estado = 'activa', bloqueada_por = NULL
              WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion } }
        );

        await Audit.registrarEvento({
            modulo: 'intelligence',
            accion: 'conversacion_desbloqueada_por_negocio',
            idUsuario: req.usuario.id_usuario,
            idNegocio: conversacion.id_negocio,
            detalle: { id_conversacion: conversacion.id_conversacion },
        });

        return Respuesta.success(res, 'El asistente vuelve a poder contestarle a este número', {
            estado: 'activa',
        });
    } catch (err) {
        console.error('Error en bandeja.desbloquear:', err);
        return Respuesta.error(res, 'Error al desbloquear la conversación');
    }
}

/**
 * GET /admin/intelligence/bandeja/preparacion?id_negocio=
 *
 * Lo que le falta al negocio para que su asistente de WhatsApp atienda bien: horario, carta,
 * tiempo de entrega, info de pagos… con por qué importa y dónde se arregla. La Bandeja lo enseña
 * apenas se conecta el número (2026-10-02, tras la primera noche de Zona Burger).
 */
async function leerPreparacion(req, res) {
    try {
        if (!revisar(req, res)) return;
        const idNegocio = Number(req.query.id_negocio);
        if (!(await negocioVisible(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }
        const resultado = await PreparacionAsistente.revisar(idNegocio);
        if (!resultado) return Respuesta.error(res, 'Negocio no encontrado', 404);
        return Respuesta.success(res, 'Preparación del asistente', resultado);
    } catch (err) {
        console.error('Error en bandeja.leerPreparacion:', err);
        return Respuesta.error(res, 'No se pudo revisar la preparación del asistente', 500);
    }
}

/**
 * POST /admin/intelligence/bandeja/asistente-pausa   { id_negocio, pausado: boolean }
 *
 * Pausa de emergencia (2026-10-04: Zona Burger se quedó sin papas y pidió que el bot dejara de
 * contestar YA). En pausa, los mensajes siguen entrando y quedan en «Esperan respuesta», pero el
 * asistente no contesta ni ejecuta nada (ver `motor.recibir`). Al reanudar, lo que llegó durante
 * la pausa no se contesta: lo atendió el personal. Solo un administrador del negocio (o el
 * superadmin), y queda auditado.
 */
async function pausarAsistente(req, res) {
    try {
        if (!revisar(req, res)) return;
        const idNegocio = Number(req.body.id_negocio);
        const pausado = req.body.pausado === true;

        if (!(await esAdministradorDelNegocio(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(res, 'Solo un administrador de este negocio puede pausar el asistente.', 403);
        }

        const [fila] = await Models.sequelize.query(
            `UPDATE general.gener_negocio
                SET asistente_pausado = :pausado,
                    asistente_pausado_en = CASE WHEN :pausado THEN now() ELSE NULL END
              WHERE id_negocio = :idNegocio
          RETURNING asistente_pausado, asistente_pausado_en;`,
            { replacements: { idNegocio, pausado }, ...SELECT }
        );
        if (!fila) return Respuesta.error(res, 'Negocio no encontrado', 404);

        await Audit.registrarEvento({
            modulo: 'intelligence',
            accion: pausado ? 'asistente_pausado' : 'asistente_reanudado',
            idUsuario: req.usuario.id_usuario,
            idNegocio,
            detalle: { pausado },
        });

        return Respuesta.success(res, pausado ? 'Asistente en pausa' : 'Asistente reanudado', {
            asistente_pausado: fila.asistente_pausado === true,
            asistente_pausado_en: fila.asistente_pausado_en ?? null,
        });
    } catch (err) {
        console.error('Error en bandeja.pausarAsistente:', err);
        return Respuesta.error(res, 'No se pudo cambiar la pausa del asistente');
    }
}

/**
 * GET /admin/intelligence/bandeja/diagnostico?id_negocio=
 *
 * El diagnóstico a fondo de la carta (reglas + prueba del buscador del asistente). Bajo demanda:
 * hace decenas de búsquedas, no va en la carga de la Bandeja. Lo ve quien puede arreglarlo: el
 * administrador del negocio y el super admin (que prepara la carta antes de entregar WhatsApp).
 */
async function leerDiagnostico(req, res) {
    try {
        if (!revisar(req, res)) return;
        const idNegocio = Number(req.query.id_negocio);
        if (!(await esAdministradorDelNegocio(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }
        const diagnostico = await require('../services/diagnosticoAsistenteService').diagnosticar(idNegocio);
        return Respuesta.success(res, 'Diagnóstico del asistente', diagnostico);
    } catch (err) {
        console.error('Error en bandeja.leerDiagnostico:', err);
        return Respuesta.error(res, 'No se pudo hacer el diagnóstico');
    }
}

/**
 * POST /admin/intelligence/bandeja/diagnostico/recomendaciones   { id_negocio, forzar? }
 *
 * Fase 2 del diagnóstico: un modelo redacta el arreglo concreto de la carta («renómbralo así»).
 * Solo recomienda; nada se cambia. Cuesta centavos y se guarda por carta, así que repetir sin
 * cambios no gasta (`forzar: true` vuelve a preguntar). Administrador del negocio o super admin.
 */
async function pedirRecomendaciones(req, res) {
    try {
        if (!revisar(req, res)) return;
        const idNegocio = Number(req.body.id_negocio);
        if (!(await esAdministradorDelNegocio(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }
        const recomendaciones = await require('../services/recomendacionesAsistenteService').recomendar(idNegocio, {
            forzar: req.body.forzar === true,
            idUsuario: req.usuario.id_usuario,
        });
        // El costo y el modelo son internos (quedan en la auditoría): al panel no viajan.
        const { costo_usd: _c, modelo: _m, descartados: _d, ...paraElPanel } = recomendaciones;
        return Respuesta.success(res, 'Recomendaciones para la carta', paraElPanel);
    } catch (err) {
        if (err.statusCode && err.code) return Respuesta.error(res, err.message, err.statusCode);
        console.error('Error en bandeja.pedirRecomendaciones:', err);
        return Respuesta.error(res, 'No se pudieron generar las recomendaciones');
    }
}

/**
 * GET /admin/intelligence/bandeja/informe?id_negocio=&dias=
 *
 * Cómo le fue al asistente con las conversaciones reales (fase 3): pedidos por carta y por chat,
 * lo que se pidió y no se encontró, chats que acabaron en una persona, pedidos rechazados, y qué
 * hacer. Administrador del negocio o super admin; el gasto en IA —que es de EscalApp, no del
 * negocio— solo viaja al super admin.
 */
async function leerInforme(req, res) {
    try {
        if (!revisar(req, res)) return;
        if (!(await hayEsquemaIntelligence())) return sinEsquema(res);
        const idNegocio = Number(req.query.id_negocio);
        if (!(await esAdministradorDelNegocio(req.usuario.id_usuario, idNegocio))) {
            return Respuesta.error(res, 'Negocio no encontrado', 404);
        }
        const { superAdmin } = await alcanceDeNegocios(req.usuario.id_usuario);
        const informe = await require('../services/informeAsistenteService').informe(idNegocio, {
            dias: req.query.dias ? Number(req.query.dias) : 7,
            conCosto: superAdmin,
        });
        return Respuesta.success(res, 'Informe del asistente', informe);
    } catch (err) {
        console.error('Error en bandeja.leerInforme:', err);
        return Respuesta.error(res, 'No se pudo generar el informe');
    }
}

module.exports = {
    leerInforme,
    pedirRecomendaciones,
    leerDiagnostico,
    pausarAsistente,
    leerPreparacion,
    listarConversaciones,
    detalleConversacion,
    archivoDeMensaje,
    responder,
    atender,
    devolverAlAsistente,
    bloquear,
    desbloquear,
    leerConfiguracion,
    guardarConfiguracion,
};
