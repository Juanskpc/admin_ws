/**
 * «Tu pedido ya está listo» — el aviso que dispara una persona desde el despacho.
 *
 * ## Qué es y qué no es
 *
 * **No es un recordatorio.** `intelligence/recordatorios/` existe para mensajes que decide un
 * calendario: se programan, esperan, y se releen al vencer. Éste lo decide alguien mirando la
 * cocina, y ocurre *ahora*: no hay nada que programar ni que volver a comprobar más tarde.
 *
 * Lo que sí comparte con ellos es el último tramo, que es el único que importa:
 * `intelligence.mensaje` pendiente → entregador → adaptador → canal. Lo único distinto de un
 * saliente normal es que lleva `plantilla`, y eso es lo que le permite salir aunque la ventana
 * de 24 h se haya cerrado — que es justo lo que pasa cuando el pedido tarda dos horas.
 *
 * ## Por qué vive en el adaptador
 *
 * Porque saber qué es una orden, cuál se puede avisar y de qué columna sale el teléfono es
 * conocimiento de la vertical, y el núcleo no puede tenerlo (ADR-005, ADR-009). Es el hermano
 * de `adapters/reserva/recordatorios.js`, que hace lo mismo para las citas.
 *
 * Y por eso lee la orden con **SQL en crudo** en vez de llamar a `pedidoService`: ese servicio ya
 * depende de este adaptador (`index.js` lo usa para crear pedidos), y hacerlo al revés cerraría
 * un ciclo entre los dos módulos. La consulta es de cinco columnas; el ciclo, para siempre.
 *
 * ## El candado, que es la mitad del trabajo
 *
 * Cada envío de plantilla **se le cobra al negocio**. Dos clics seguidos son dos cobros y dos
 * mensajes al cliente, y en una pantalla que se mira con prisa el doble clic no es una
 * posibilidad teórica. Tres cosas lo impiden, y hacen falta las tres:
 *
 *   1. `SELECT … FOR UPDATE` sobre la orden: dos peticiones simultáneas se ponen en fila en vez
 *      de leer las dos «todavía no avisado» y mandar las dos.
 *   2. `aviso_listo_en` se escribe en **la misma transacción** que crea el saliente. Si una de
 *      las dos falla no queda ni el mensaje ni la marca, y se puede reintentar sin miedo.
 *   3. El botón se apaga en el despacho. Esto último es comodidad, no garantía: la garantía son
 *      las dos primeras, porque el frontend siempre puede llegar tarde o venir de otra pestaña.
 */
'use strict';

const Models = require('../../../app_core/models/conection');
const repositorio = require('../../engine/repositorio');
const plantillas = require('../../core/plantillas');
const contextoNegocio = require('../../core/contextoNegocio');
const features = require('../../core/features');
const { normalizarE164Colombia } = require('../../../app_core/helpers/telefono');

const PLANTILLA = 'pedido_listo';
const CANAL = 'whatsapp';

/** Los tipos de pedido a los que este aviso les sirve de algo. */
const TIPO_RECOGER = 'LLEVAR';

/**
 * El número, como lo escribe el canal: `573001234567`, **sin el `+`**.
 *
 * El `id_externo` de una conversación de WhatsApp es el `from` del webhook, que llega así.
 * Buscar con el `+` delante no encontraría la conversación que la persona tiene abierta — la
 * clave única es `(negocio, canal, id_externo)` — y acabaríamos escribiendo por un hilo nuevo.
 * Es la misma nota que hay en `adapters/reserva/recordatorios.js`, y por el mismo motivo.
 */
function comoLoEscribeElCanal(telefono) {
    const e164 = normalizarE164Colombia(telefono);
    return e164 ? e164.replace(/^\+/, '') : null;
}

/** Un error que el despacho puede enseñar tal cual. */
function rechazar(mensaje, code, statusCode = 409) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    throw e;
}

/**
 * Avisa al cliente de que su pedido está listo para recoger.
 *
 * Devuelve `{ id_mensaje, avisado_en }`. Todo lo que impide el envío se lanza como error tipado
 * y con un texto que se le pueda enseñar a quien apretó el botón: quien está al otro lado es
 * alguien con la cocina llena, no un programador leyendo un log.
 */
async function avisarListo({ idNegocio, idOrden }, { transaction = null } = {}) {
    // ── 0. ¿Este negocio tiene derecho al asistente? ──────────────────────────────────────
    //
    // Antes que nada, y **fuera de la transacción**: es una pregunta comercial, no de dominio, y
    // no tiene sentido abrir una transacción para descubrir que el negocio no paga por esto.
    //
    // Se pregunta por la FEATURE y nunca por el nombre del plan (ADR-021). Hoy `asistente_ia`
    // solo la incluye «Plan Avanzado», pero eso lo decide `core/features.js` y puede cambiar sin
    // que este archivo se entere — que es justo el punto de la costura.
    //
    // La pantalla ya esconde el botón sin la feature. Esto no sobra: la pantalla decide qué se
    // enseña, y esto decide qué se permite. Quien llega por `curl`, con una pestaña vieja abierta
    // o después de una baja de plan, llega hasta aquí.
    if (!(await features.estaHabilitado(idNegocio, features.FEATURE.ASISTENTE_IA))) {
        rechazar(
            'El asistente de WhatsApp no está incluido en el plan de este negocio.',
            'FEATURE_NO_HABILITADA',
            403
        );
    }

    const propia = !transaction;
    const t = transaction || (await Models.sequelize.transaction());

    try {
        // ── 1. La orden, bloqueada ────────────────────────────────────────────────────────
        //
        // `FOR UPDATE` desde la primera lectura, no después de decidir: entre un SELECT normal y
        // el UPDATE cabe entera la segunda petición, y las dos verían `aviso_listo_en` nulo.
        const [orden] = await Models.sequelize.query(
            `
            SELECT id_orden, id_negocio, numero_orden, tipo_pedido, estado,
                   contacto_nombre, contacto_telefono, aviso_listo_en
              FROM restaurante.pedid_orden
             WHERE id_orden = :idOrden AND id_negocio = :idNegocio
             FOR UPDATE;
            `,
            {
                replacements: { idOrden, idNegocio },
                type: Models.sequelize.QueryTypes.SELECT,
                transaction: t,
            }
        );

        if (!orden) rechazar('Ese pedido no existe en este negocio.', 'PEDIDO_NO_ENCONTRADO', 404);
        if (orden.aviso_listo_en) {
            rechazar('A este cliente ya se le avisó.', 'PEDIDO_YA_AVISADO');
        }
        if (orden.estado !== 'ABIERTA') {
            rechazar('Ese pedido ya está cerrado.', 'PEDIDO_CERRADO');
        }
        if (orden.tipo_pedido !== TIPO_RECOGER) {
            // Un domicilio no necesita este aviso: lo que llega es el domiciliario. El día que
            // se quiera un «va en camino» será otra plantilla, no ésta con otro texto.
            rechazar(
                'Este aviso es solo para los pedidos que el cliente pasa a recoger.',
                'PEDIDO_NO_ES_PARA_RECOGER'
            );
        }

        const idExterno = comoLoEscribeElCanal(orden.contacto_telefono);
        if (!idExterno) {
            rechazar(
                'Ese pedido no tiene un número de WhatsApp al que escribirle.',
                'PEDIDO_SIN_TELEFONO'
            );
        }

        // ── 2. La conversación, que tiene que existir ANTES ──────────────────────────────
        //
        // Se **busca**, no se asegura. Es la diferencia entre contestarle a alguien que nos
        // escribió y escribirle a un número que apareció en una casilla: si no hay conversación,
        // esta persona nunca habló con este negocio por WhatsApp, y estrenar el hilo con una
        // plantilla es exactamente lo que no se debe hacer desde un botón.
        const conversacion = await repositorio.buscarConversacion(
            { idNegocio, canal: CANAL, idExterno },
            { transaction: t }
        );
        if (!conversacion) {
            rechazar(
                'Este pedido no vino por WhatsApp, así que no hay conversación a la que escribir.',
                'SIN_CONVERSACION'
            );
        }
        // Quien pidió la baja no recibe nada, ni siquiera algo que le interesa. El filtro del
        // entregador también lo mira, pero para entonces el mensaje ya existiría y se quedaría
        // pendiente hasta caducar, ensuciando la cola con algo que nunca va a salir.
        if (conversacion.estado === 'bloqueada') {
            rechazar(
                'Esta persona pidió no recibir más mensajes por WhatsApp.',
                'CONVERSACION_BLOQUEADA'
            );
        }

        // ── 3. El mensaje ────────────────────────────────────────────────────────────────
        const negocio = await contextoNegocio.obtener(idNegocio);
        const parametros = {
            // El nombre puede faltar —una orden puede nacer sin él—, y «Hola , tu pedido» es
            // peor que un saludo genérico.
            cliente: (orden.contacto_nombre || '').trim() || 'hola',
            orden: orden.numero_orden,
            negocio: negocio.tratamiento,
        };
        const definicion = plantillas.obtener(PLANTILLA);
        const contenido = plantillas.renderizarTexto(PLANTILLA, parametros);

        const fila = await repositorio.insertarMensajeSaliente(
            {
                idConversacion: conversacion.id_conversacion,
                idNegocio,
                // Sin turno: no lo decidió una conversación, lo decidió una persona mirando la
                // cocina. NULL es la respuesta correcta a «¿en qué turno se dijo esto?».
                idTurno: null,
                canal: CANAL,
                contenido,
                plantilla: {
                    nombre: definicion.nombre,
                    idioma: definicion.idioma,
                    parametros,
                },
            },
            { transaction: t }
        );

        // ── 4. La marca, en esta misma transacción ───────────────────────────────────────
        const [[marcada]] = await Models.sequelize.query(
            `UPDATE restaurante.pedid_orden
                SET aviso_listo_en = now()
              WHERE id_orden = :idOrden
              RETURNING aviso_listo_en;`,
            { replacements: { idOrden }, transaction: t }
        );

        if (propia) await t.commit();
        return { id_mensaje: fila.id_mensaje, avisado_en: marcada.aviso_listo_en };
    } catch (error) {
        if (propia) await t.rollback();
        throw error;
    }
}

module.exports = { PLANTILLA, CANAL, TIPO_RECOGER, avisarListo, comoLoEscribeElCanal };
