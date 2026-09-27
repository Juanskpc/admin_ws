'use strict';
const { validationResult } = require('express-validator');
const HorarioService = require('../services/horarioService');
const DashboardService = require('../services/dashboardService');
const Models = require('../../app_core/models/conection');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

/**
 * `horarios_editar` deja tocar cualquier horario (el general del negocio y el de cualquier
 * profesional). Quien solo tiene `horarios_editar_propio` —el caso normal de un profesional al
 * que se le habilitó la vista Horarios— únicamente puede reemplazar SU PROPIA ficha.
 *
 * Esto se comprueba aquí y no alcanza con esconder el selector en el frontend, por lo mismo que
 * `exigirAccion.js`: la API está abierta a cualquiera con un token, y machacar el horario de un
 * compañero con uno vacío deja huecos de agenda sin que nadie lo pidiera.
 */
async function puedeReemplazar(req, idNegocio, idProfesionalDestino) {
    const idUsuario = req.usuario?.id_usuario;

    const globales = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, id_negocio: null, estado: 'A' },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['descripcion'] }],
    });
    if (globales.some(r => /SUPER/i.test(r.rol?.descripcion || ''))) return true;

    const negocio = await Models.GenerNegocio.findByPk(idNegocio, { attributes: ['id_tipo_negocio'] });
    if (!negocio) return false;

    const roles = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, id_negocio: idNegocio, estado: 'A' },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol'] }],
    });
    if (!roles.length) return false;

    const permisos = await DashboardService.getPermisosSubnivelNegocio({
        idNegocio,
        idTipoNegocio: negocio.id_tipo_negocio,
        rolesNegocio: roles.map(r => ({ id_rol: r.rol?.id_rol ?? r.id_rol })),
    });
    const tiene = (codigo) => permisos.some(p => p.codigo === codigo && p.puede_ver);

    if (tiene('horarios_editar')) return true;
    if (!tiene('horarios_editar_propio')) return false;

    // Solo la propia: hace falta una ficha de agenda y que sea justo la que se quiere tocar.
    // El horario "general del negocio" (id_profesional NULL) no es de nadie en particular, así
    // que este permiso nunca alcanza para tocarlo.
    if (!idProfesionalDestino) return false;
    const miFicha = await Models.ReservaProfesional.findOne({
        where: { id_usuario: idUsuario, id_negocio: idNegocio },
        attributes: ['id_profesional'],
    });
    return !!miFicha && miFicha.id_profesional === idProfesionalDestino;
}

async function listar(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        const idProfesional = req.query.id_profesional !== undefined
            ? (req.query.id_profesional === '' || req.query.id_profesional === 'null'
                ? null
                : Number(req.query.id_profesional))
            : null;
        const r = await HorarioService.listar({ idNegocio, idProfesional });
        return Respuesta.success(res, 'Horarios obtenidos', r);
    } catch (err) {
        console.error('[Reserva/Horarios] listar:', err.message);
        return Respuesta.error(res, 'Error al obtener horarios.');
    }
}

async function reemplazar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        const idProfesional = req.body.id_profesional == null ? null : Number(req.body.id_profesional);

        if (!await puedeReemplazar(req, idNegocio, idProfesional)) {
            return Respuesta.error(
                res,
                idProfesional
                    ? 'Solo puedes editar tu propio horario.'
                    : 'Tu rol no tiene permiso para esta acción. Pídeselo al administrador del negocio.',
                403,
            );
        }

        const r = await HorarioService.reemplazar({
            idNegocio, idProfesional,
            bloques: req.body.bloques || [],
        });
        return Respuesta.success(res, 'Horario actualizado', r);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Horarios] reemplazar:', err.message);
        return Respuesta.error(res, 'Error al actualizar el horario.');
    }
}

module.exports = { listar, reemplazar };
