/**
 * notificacionService.js — Servicio de notificaciones de vencimiento de plan.
 *
 * Gestiona:
 *   1. Notificaciones internas (en la app)
 *   2. Correos electrónicos de advertencia (5 días y 1 día antes del vencimiento)
 *
 * Reglas:
 *   - Cada aviso se envía exactamente una vez por plan.
 *   - Si el plan se renueva, los avisos se reinician (nuevo id_negocio_plan).
 */

'use strict';
const notificacionDao = require('../../app_core/dao/notificacionDao');
const mailService = require('./mailService');

const DIAS_AVISO_1 = 5;
const DIAS_AVISO_2 = 1;

/**
 * Envía aviso de vencimiento (correo + notificación interna) si corresponde.
 *
 * @param {number} dias - Días hasta el vencimiento (5 o 1)
 * @returns {Promise<{procesados: number, correos: number, notificaciones: number}>}
 */
async function procesarAvisosDeVencimiento(dias) {
    const tipoAviso = dias === 5 ? '5_DIAS' : '1_DIA';
    const planes = await notificacionDao.getPlanesQueVencenEn(dias);

    let procesados = 0;
    let correosEnviados = 0;
    let notificacionesCreadas = 0;

    for (const negocioPlan of planes) {
        const idNegocioPlan = negocioPlan.id_negocio_plan;
        const negocio = negocioPlan.GenerNegocio;
        const plan = negocioPlan.GenerPlan;

        if (!negocio) continue;

        const yaEnviado = await notificacionDao.avisoYaEnviado(idNegocioPlan, tipoAviso);
        if (yaEnviado) continue;

        procesados++;

        const fechaFin = new Date(negocioPlan.fecha_fin);
        const fechaFinStr = fechaFin.toLocaleDateString('es-CO', {
            year: 'numeric', month: 'long', day: 'numeric'
        });

        const titulo = `Tu plan ${plan.nombre} vence en ${dias} ${dias === 1 ? 'día' : 'días'}`;
        const mensaje = `Tu plan "${plan.nombre}" para "${negocio.nombre}" vence el ${fechaFinStr}. ` +
            `Renueva para seguir usando todas las funcionalidades sin interrupciones.`;

        let emailEnviado = false;
        let notificacionCreada = false;

        try {
            const usuariosNegocio = negocio.usuarios || [];
            const emailsDestino = new Set();

            for (const usuarioRel of usuariosNegocio) {
                if (usuarioRel.email) emailsDestino.add(usuarioRel.email);
            }
            if (negocio.email_contacto) emailsDestino.add(negocio.email_contacto);

            for (const email of emailsDestino) {
                await mailService.sendPlanExpiryWarningEmail(email, {
                    nombreNegocio: negocio.nombre,
                    nombrePlan: plan.nombre,
                    fechaVencimiento: fechaFinStr,
                    diasRestantes: dias
                });
                emailEnviado = true;
                correosEnviados++;
            }
        } catch (err) {
            console.error(`Error enviando correo de vencimiento a negocio ${negocio.id_negocio}:`, err.message);
        }

        try {
            await notificacionDao.crearNotificacion({
                id_negocio: negocio.id_negocio,
                tipo: 'VENCIMIENTO_PLAN',
                titulo,
                mensaje
            });
            notificacionCreada = true;
            notificacionesCreadas++;
        } catch (err) {
            console.error(`Error creando notificación para negocio ${negocio.id_negocio}:`, err.message);
        }

        try {
            await notificacionDao.registrarAvisoEnviado({
                id_negocio_plan: idNegocioPlan,
                tipo_aviso: tipoAviso,
                email_enviado: emailEnviado,
                notificacion_creada: notificacionCreada
            });
        } catch (err) {
            console.error(`Error registrando aviso enviado para plan ${idNegocioPlan}:`, err.message);
        }
    }

    return { procesados, correos: correosEnviados, notificaciones: notificacionesCreadas };
}

/**
 * Ejecuta la verificación diaria de vencimientos (5 y 1 día).
 * Diseñado para ser llamado desde el scheduler.
 */
async function ejecutarVerificacionDiaria() {
    console.log(`\n[${new Date().toISOString()}] Verificación diaria de vencimientos de plan...`);

    try {
        const resultado5 = await procesarAvisosDeVencimiento(DIAS_AVISO_1);
        console.log(`  Aviso 5 días: ${resultado5.procesados} procesados, ${resultado5.correos} correos, ${resultado5.notificaciones} notificaciones`);

        const resultado1 = await procesarAvisosDeVencimiento(DIAS_AVISO_2);
        console.log(`  Aviso 1 día:  ${resultado1.procesados} procesados, ${resultado1.correos} correos, ${resultado1.notificaciones} notificaciones`);

        console.log(`[${new Date().toISOString()}] Verificación completada.\n`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error en verificación diaria:`, err.message);
    }
}

module.exports = { procesarAvisosDeVencimiento, ejecutarVerificacionDiaria };
