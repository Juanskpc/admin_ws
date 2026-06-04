'use strict';
const Models = require('../models/conection');
const { Op } = Models.Sequelize;

/**
 * Crea una notificación interna para un negocio.
 */
async function crearNotificacion({ id_negocio, tipo, titulo, mensaje }) {
    return Models.GenerNotificacion.create({
        id_negocio,
        tipo,
        titulo,
        mensaje,
        leida: false,
        fecha_creacion: new Date()
    });
}

/**
 * Obtiene las notificaciones de un negocio (más recientes primero).
 * @param {number} id_negocio
 * @param {object} opts
 * @param {boolean} [opts.soloNoLeidas=false]
 * @param {number} [opts.limit=50]
 */
async function getNotificaciones(id_negocio, opts = {}) {
    const { soloNoLeidas = false, limit = 50 } = opts;
    const where = { id_negocio };
    if (soloNoLeidas) where.leida = false;

    return Models.GenerNotificacion.findAll({
        where,
        order: [['fecha_creacion', 'DESC']],
        limit
    });
}

/**
 * Obtiene las notificaciones de múltiples negocios (más recientes primero).
 * @param {number[]} ids_negocio
 * @param {object} opts
 * @param {boolean} [opts.soloNoLeidas=false]
 * @param {number} [opts.limit=50]
 */
async function getNotificacionesMulti(ids_negocio, opts = {}) {
    if (!ids_negocio || ids_negocio.length === 0) return [];
    const { soloNoLeidas = false, limit = 50 } = opts;
    const where = { id_negocio: { [Op.in]: ids_negocio } };
    if (soloNoLeidas) where.leida = false;

    return Models.GenerNotificacion.findAll({
        where,
        order: [['fecha_creacion', 'DESC']],
        limit
    });
}

/**
 * Cuenta las notificaciones no leídas de un negocio.
 */
async function contarNoLeidas(id_negocio) {
    return Models.GenerNotificacion.count({
        where: { id_negocio, leida: false }
    });
}

/**
 * Cuenta las notificaciones no leídas de múltiples negocios.
 */
async function contarNoLeidasMulti(ids_negocio) {
    if (!ids_negocio || ids_negocio.length === 0) return 0;
    return Models.GenerNotificacion.count({
        where: { id_negocio: { [Op.in]: ids_negocio }, leida: false }
    });
}

/**
 * Marca una notificación como leída.
 */
async function marcarLeida(id_notificacion, id_negocio) {
    const [updated] = await Models.GenerNotificacion.update(
        { leida: true, fecha_lectura: new Date() },
        { where: { id_notificacion, id_negocio } }
    );
    return updated > 0;
}

/**
 * Marca todas las notificaciones de un negocio como leídas.
 */
async function marcarTodasLeidas(id_negocio) {
    const [updated] = await Models.GenerNotificacion.update(
        { leida: true, fecha_lectura: new Date() },
        { where: { id_negocio, leida: false } }
    );
    return updated;
}

/**
 * Verifica si ya se envió un aviso de un tipo específico para un negocio_plan.
 */
async function avisoYaEnviado(id_negocio_plan, tipo_aviso) {
    const aviso = await Models.GenerAvisoPlanEnviado.findOne({
        where: { id_negocio_plan, tipo_aviso }
    });
    return aviso !== null;
}

/**
 * Registra que se envió un aviso de vencimiento.
 */
async function registrarAvisoEnviado({ id_negocio_plan, tipo_aviso, email_enviado, notificacion_creada }) {
    return Models.GenerAvisoPlanEnviado.create({
        id_negocio_plan,
        tipo_aviso,
        fecha_envio: new Date(),
        email_enviado: email_enviado ?? false,
        notificacion_creada: notificacion_creada ?? false
    });
}

/**
 * Obtiene todos los negocio_plan activos que vencen en exactamente N días.
 * @param {number} dias - Días hasta el vencimiento (5 o 1)
 */
async function getPlanesQueVencenEn(dias) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    const fechaObjetivo = new Date(hoy);
    fechaObjetivo.setDate(fechaObjetivo.getDate() + dias);

    const inicio = new Date(fechaObjetivo);
    inicio.setHours(0, 0, 0, 0);
    const fin = new Date(fechaObjetivo);
    fin.setHours(23, 59, 59, 999);

    return Models.GenerNegocioPlan.findAll({
        where: {
            estado: 'A',
            fecha_fin: { [Op.between]: [inicio, fin] }
        },
        include: [
            {
                model: Models.GenerNegocio,
                include: [{ model: Models.GenerUsuario, as: 'usuarios' }]
            },
            { model: Models.GenerPlan }
        ]
    });
}

module.exports = {
    crearNotificacion,
    getNotificaciones,
    getNotificacionesMulti,
    contarNoLeidas,
    contarNoLeidasMulti,
    marcarLeida,
    marcarTodasLeidas,
    avisoYaEnviado,
    registrarAvisoEnviado,
    getPlanesQueVencenEn
};
