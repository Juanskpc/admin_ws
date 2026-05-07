'use strict';
const Models = require('../../app_core/models/conection');

async function listar({ idNegocio, idProfesional = null }) {
    const where = { id_negocio: idNegocio };
    if (idProfesional !== undefined) where.id_profesional = idProfesional; // null permitido = horario del negocio
    return Models.ReservaHorario.findAll({
        where,
        order: [['dia_semana', 'ASC'], ['hora_inicio', 'ASC']],
    });
}

/**
 * Reemplaza completamente el horario semanal del negocio o de un profesional.
 * `bloques` = [{ dia_semana, hora_inicio, hora_fin }]
 */
async function reemplazar({ idNegocio, idProfesional = null, bloques = [] }) {
    const t = await Models.sequelize.transaction();
    try {
        await Models.ReservaHorario.destroy({
            where: { id_negocio: idNegocio, id_profesional: idProfesional },
            transaction: t,
        });
        if (bloques.length) {
            await Models.ReservaHorario.bulkCreate(
                bloques.map(b => ({
                    id_negocio: idNegocio,
                    id_profesional: idProfesional,
                    dia_semana: b.dia_semana,
                    hora_inicio: b.hora_inicio,
                    hora_fin: b.hora_fin,
                })),
                { transaction: t, validate: true },
            );
        }
        await t.commit();
    } catch (err) {
        await t.rollback(); throw err;
    }
    return listar({ idNegocio, idProfesional });
}

module.exports = { listar, reemplazar };
