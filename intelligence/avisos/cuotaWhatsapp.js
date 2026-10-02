/**
 * El aviso de que un número se está comiendo su cuota de WhatsApp.
 *
 * ## El agujero que tapa
 *
 * Desde el 1 de octubre de 2026 Meta cobra los *service messages* pasada la asignación mensual de
 * cada número (`channels/whatsapp/cuota.js`). Antes de hoy nadie sabía cuántos mensajes llevaba un
 * inquilino: el dato estaba en `intelligence.mensaje` y nadie lo miraba, así que la primera noticia
 * habría sido la factura — que es exactamente el fallo que el Ledger existe para evitar.
 *
 * ## Las tres reglas, y las tres son la misma: un aviso que se ignora no sirve
 *
 * 1. **Dos avisos por mes como mucho**, y son distintos: uno al llegar al umbral («te quedan
 *    doscientos») y otro al agotarla («de aquí en adelante se cobra»). Un aviso diario diciendo lo
 *    mismo enseña a no abrirlos.
 * 2. **Se cuenta cuántos hay este mes para saber si toca.** Es lo que hace idempotente a esto sin
 *    una tabla de control: la propia campanita es la marca, igual que en `escalado.js`.
 * 3. **Dice qué hacer, no solo qué pasa.** «Vas por el 80 %» no es información útil; «vas por el
 *    80 % y cada cita gasta siete mensajes» sí, porque señala dónde está el gasto.
 *
 * ## Por qué campanita y no correo
 *
 * Por lo mismo que el escalado la prefiere: ya existe, sale con contador e historial, y no depende
 * de que el SMTP esté en pie. Esto además **no es urgente** —es una tendencia, no un cliente
 * esperando— así que interrumpir por correo sería desproporcionado. El día que haga falta, son tres
 * líneas aquí.
 */
'use strict';

const Models = require('../../app_core/models/conection');
const notificacionDao = require('../../app_core/dao/notificacionDao');
const cuota = require('../channels/whatsapp/cuota');

const SELECT = { type: Models.sequelize.QueryTypes.SELECT };
const TIPO_NOTIFICACION = 'WHATSAPP_CUOTA';

let temporizador = null;

/** Cuántos avisos de cuota lleva este negocio en el mes en curso. */
async function avisosDelMes(idNegocio, ahora) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT count(*)::int AS total
          FROM general.gener_notificacion
         WHERE id_negocio = :idNegocio
           AND tipo = :tipo
           AND fecha_creacion >= CAST(:desde AS timestamptz);
        `,
        {
            replacements: {
                idNegocio,
                tipo: TIPO_NOTIFICACION,
                desde: cuota.primerDiaDelMes(ahora),
            },
            ...SELECT,
        }
    );
    return Number(fila?.total || 0);
}

/**
 * Qué aviso toca, si toca alguno.
 *
 * Se devuelve el **nivel** y no un booleano porque los dos avisos dicen cosas distintas y se
 * cuentan por separado: el de agotada tiene que poder salir aunque el del umbral ya haya salido.
 */
function nivelDeAviso(consumo, avisosPrevios) {
    if (consumo.porcentaje >= 1) return avisosPrevios < 2 ? 'agotada' : null;
    if (consumo.porcentaje >= cuota.CONFIG.umbralAviso) return avisosPrevios < 1 ? 'umbral' : null;
    return null;
}

function comoSeDice(nivel, consumo, porCita) {
    const gasto = porCita?.promedio > 0
        ? ` Cada cita que agenda el asistente gasta ${porCita.promedio} mensajes de media, así que ` +
          `a este ritmo caben unas ${porCita.citasGratisAlMes} citas al mes dentro de lo gratis.`
        : '';

    if (nivel === 'agotada') {
        return {
            titulo: 'Se agotó la cuota de WhatsApp del mes',
            mensaje:
                `Este número ya entregó los ${consumo.asignacion} mensajes que WhatsApp da gratis ` +
                `cada mes (van ${consumo.servicio}). Los que salgan hasta fin de mes se cobran.` +
                `${gasto} La cuota se renueva el día 1.`,
        };
    }
    return {
        titulo: 'La cuota de WhatsApp va por el ' + Math.round(consumo.porcentaje * 100) + '%',
        mensaje:
            `Este número lleva ${consumo.servicio} de los ${consumo.asignacion} mensajes gratis del ` +
            `mes; quedan ${consumo.restantes}.${gasto} Pasados los gratis, cada mensaje se cobra.`,
    };
}

/**
 * Revisa todos los números y avisa a quien toque.
 *
 * Los motivos por los que no se avisa se **devuelven**, no se lanzan: no son fallos, y un
 * temporizador que revienta por una cuota que va bien se apagaría solo.
 */
async function revisar({ ahora = new Date() } = {}) {
    const consumos = await cuota.consumoDelMes({ ahora });
    const avisados = [];

    for (const consumo of consumos) {
        const previos = await avisosDelMes(consumo.id_negocio, ahora);
        const nivel = nivelDeAviso(consumo, previos);
        if (!nivel) continue;

        // Solo se mide el gasto por cita de quien ya está en el umbral: es una consulta sobre dos
        // tablas particionadas y no hace falta pagarla por cada negocio que va sobrado.
        const porCita = await cuota.mensajesPorCita({ idNegocio: consumo.id_negocio });
        const { titulo, mensaje } = comoSeDice(nivel, consumo, porCita);

        await notificacionDao.crearNotificacion({
            id_negocio: consumo.id_negocio,
            tipo: TIPO_NOTIFICACION,
            titulo,
            mensaje,
        });
        console.warn(
            `[whatsapp-cuota] negocio ${consumo.id_negocio} (${consumo.negocio}): ` +
                `${consumo.servicio}/${consumo.asignacion} mensajes — aviso "${nivel}".`
        );
        avisados.push({ idNegocio: consumo.id_negocio, nivel, consumo: consumo.servicio });
    }

    return { revisados: consumos.length, avisados };
}

/**
 * Pone el temporizador. Lo llama la composición (`intelligence/index.js`), nunca el núcleo.
 *
 * La primera revisión va **al arrancar** y no dentro de un día: si el despliegue ocurre con la
 * cuota ya pasada, enterarse mañana no sirve de nada.
 */
function iniciar() {
    if (temporizador) return { ya: true };
    const cada = Math.max(1, cuota.CONFIG.horasEntreRevisiones) * 60 * 60 * 1000;

    const correr = () => revisar().catch((e) => console.error(`[whatsapp-cuota] ${e.message}`));
    correr();
    temporizador = setInterval(correr, cada);
    // Un temporizador que mantiene vivo el proceso convierte un `Ctrl+C` en una espera.
    temporizador.unref?.();
    return { cada };
}

function detener() {
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
}

module.exports = {
    TIPO_NOTIFICACION,
    revisar,
    iniciar,
    detener,
    nivelDeAviso,
    comoSeDice,
    avisosDelMes,
};
