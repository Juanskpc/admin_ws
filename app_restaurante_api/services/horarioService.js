'use strict';
const { Op } = require('sequelize');
const Models = require('../../app_core/models/conection');
const cajaService = require('./cajaService');

/**
 * horarioService — franjas semanales, del negocio o de un domiciliario.
 *
 * Misma forma que `app_reserva_api/services/horarioService.js` (id_usuario en vez de
 * id_profesional), en tabla propia por ADR-005: ver `migrate_restaurante_horario.js` para el
 * porqué no se comparte la tabla entre verticales.
 *
 * ## Bogotá no tiene horario de verano
 *
 * Restar 5 horas de un instante UTC da siempre la hora de pared bogotana, sin depender de qué
 * `TZ` tenga el proceso de Node — la misma garantía que ya usa el hook de sesión de Postgres
 * (`app_core/models/conection.js`). El día que un negocio de otro país use esto, hace falta
 * pasar el offset por parámetro; hoy no hay ninguno (ver `paisNegocio.js`).
 */
function aBogota(fecha) {
    return new Date(fecha.getTime() - 5 * 3600 * 1000);
}

/** `{ dia: 0..6 (0=Dom), hora: "HH:MM:SS" }`, comparable directamente contra una columna TIME. */
function diaYHora(fecha) {
    const b = aBogota(fecha);
    const dos = (n) => String(n).padStart(2, '0');
    return {
        dia: b.getUTCDay(),
        hora: `${dos(b.getUTCHours())}:${dos(b.getUTCMinutes())}:${dos(b.getUTCSeconds())}`,
    };
}

async function listar({ idNegocio, idUsuario }) {
    const where = { id_negocio: idNegocio };
    if (idUsuario !== undefined) where.id_usuario = idUsuario; // null permitido = horario del negocio
    return Models.RestHorario.findAll({
        where,
        order: [['dia_semana', 'ASC'], ['hora_inicio', 'ASC']],
    });
}

/** Reemplaza completamente el horario semanal del negocio o de un usuario. */
async function reemplazar({ idNegocio, idUsuario = null, bloques = [] }) {
    const t = await Models.sequelize.transaction();
    try {
        await Models.RestHorario.destroy({
            where: { id_negocio: idNegocio, id_usuario: idUsuario },
            transaction: t,
        });
        if (bloques.length) {
            await Models.RestHorario.bulkCreate(
                bloques.map((b) => ({
                    id_negocio: idNegocio,
                    id_usuario: idUsuario,
                    dia_semana: b.dia_semana,
                    hora_inicio: b.hora_inicio,
                    hora_fin: b.hora_fin,
                })),
                { transaction: t, validate: true },
            );
        }
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }
    return listar({ idNegocio, idUsuario });
}

/**
 * ¿Está el negocio dentro de su horario de atención ahora mismo?
 *
 * `configurado: false` cuando el negocio no ha cargado ningún horario propio — y entonces
 * `abierto` es `true`. Es la decisión deliberada de `migrate_restaurante_horario.js`: sin fila
 * no hay restricción, para que cargar esta tabla nunca apague de golpe un bot que ya funcionaba.
 */
async function estaAbierto({ idNegocio, ahora = new Date(), transaction = null } = {}) {
    const bloques = await Models.RestHorario.findAll({
        where: { id_negocio: idNegocio, id_usuario: null },
        attributes: ['dia_semana', 'hora_inicio', 'hora_fin'],
        transaction,
    });
    if (bloques.length === 0) return { configurado: false, abierto: true };

    const { dia, hora } = diaYHora(ahora);
    const abierto = bloques.some(
        (b) => Number(b.dia_semana) === dia && b.hora_inicio <= hora && hora < b.hora_fin
    );
    return { configurado: true, abierto };
}

/**
 * En qué estado de atención está el negocio AHORA MISMO, cruzando horario y caja.
 *
 * Son dos preguntas distintas y el cliente necesita saber cuál de las dos es: «cerrado por
 * hoy» no es lo mismo que «ya es la hora, pero todavía no hemos abierto la caja» — la primera
 * dice que vuelva otro día o más tarde, la segunda que espere un momento.
 *
 * Vive aquí, en un solo sitio, para que `tomar_pedido` (que además necesita el lock de
 * `requireCajaAbierta` porque va a crear una orden) y el saludo (que solo necesita SABER, sin
 * bloquear nada) lean la misma clasificación. Copiarla dos veces es la clase de cosa que
 * diverge — ver `gener_rol_nivel` en `CLAUDE.md`.
 *
 * No toma transacción ni lock a propósito: es una lectura informativa para decidir qué decir,
 * no el paso que va a crear el pedido. Ese paso sigue usando `cajaService.requireCajaAbierta`
 * con su propia transacción, sin pasar por aquí.
 */
async function estadoDeAtencion({ idNegocio, ahora = new Date() } = {}) {
    const horario = await estaAbierto({ idNegocio, ahora });
    if (horario.configurado && !horario.abierto) return { estado: 'fuera_de_horario' };

    const caja = await cajaService.getCajaAbierta(idNegocio);
    if (!caja) return { estado: horario.configurado ? 'aun_no_abre' : 'cerrado_sin_horario' };

    return { estado: 'abierto' };
}

/**
 * Los usuarios (domiciliarios) cuyo horario cubre este instante.
 *
 * Devuelve `id_usuario`, no objetos completos: quien llama (`elegirDomiciliarioAlAzar`) ya sabe
 * cruzarlos contra la lista real de domiciliarios del negocio — esto solo contesta «¿de estos,
 * quién dice estar en turno ahora?», nunca «quiénes son los domiciliarios».
 */
async function usuariosEnTurnoAhora({ idNegocio, ahora = new Date(), transaction = null } = {}) {
    const { dia, hora } = diaYHora(ahora);
    const bloques = await Models.RestHorario.findAll({
        where: { id_negocio: idNegocio, id_usuario: { [Op.ne]: null }, dia_semana: dia },
        attributes: ['id_usuario', 'hora_inicio', 'hora_fin'],
        transaction,
    });

    const idsEnTurno = new Set();
    for (const b of bloques) {
        if (b.hora_inicio <= hora && hora < b.hora_fin) idsEnTurno.add(b.id_usuario);
    }
    return [...idsEnTurno];
}

module.exports = { listar, reemplazar, estaAbierto, usuariosEnTurnoAhora, estadoDeAtencion };
