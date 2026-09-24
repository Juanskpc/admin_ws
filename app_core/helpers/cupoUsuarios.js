/**
 * cupoUsuarios — ¿cabe una persona más en el equipo de este negocio?
 *
 * Es `exigirCupoDeCaja` (restaurante/puntoCajaService) para los usuarios, y como aquella se llama
 * DENTRO de los caminos de alta. El tope sale de `limitesNegocio.getLimitesNegocio`:
 * `gener_plan.usuarios_incluidos` + la suma de lo **ASIGNADO** de los complementos «Usuario
 * adicional» (`cob_suscripcion_complemento.cantidad`).
 *
 * ## Lo que da cupo es lo ASIGNADO, no lo cobrado
 *
 * El complemento tiene dos cantidades: «asignados» y «se cobran». La diferencia es cortesía —así se
 * regalan usuarios—, y un usuario regalado también ocupa su sitio. Por eso el tope cuenta
 * `cantidad` y no `cantidad_facturable`. (`limitesNegocio` ya lo hace así: aquí solo se confirma.)
 *
 * ## Qué cuenta como «un usuario» de un negocio
 *
 * Un vínculo ACTIVO (`gener_negocio_usuario.estado = 'A'`) con un usuario ACTIVO
 * (`gener_usuario.estado = 'A'`). Un inactivo o eliminado no ocupa sitio. **Tampoco los usuarios
 * con un rol GLOBAL activo** (`gener_usuario_rol.id_negocio IS NULL`, p. ej. el super
 * administrador): son de la plataforma, no del equipo del cliente.
 *
 * ## Qué NO se toca
 *
 * Esto solo frena las ALTAS. Un negocio que hoy ya supera su tope conserva a todos sus usuarios
 * activos y puede seguir editándolos e inactivándolos: lo único que no puede es ocupar un sitio
 * nuevo hasta bajar del tope o ampliarlo. Ocupar un sitio nuevo es:
 *   - crear un usuario en el negocio,
 *   - vincular a uno existente,
 *   - REACTIVAR a uno inactivo (vuelve a ocupar sitio).
 * Editar a alguien que ya ocupa su sitio no lo ocupa otra vez y por eso nunca se bloquea.
 *
 * ## El primer usuario nunca falla
 *
 * El alta de un negocio (registrar cliente, prueba gratis, compra en la web) crea a su primer
 * usuario: sin él el negocio no se puede abrir. Con cero usuarios contados el cupo siempre
 * alcanza, aunque el plan tenga un tope raro.
 *
 * Sin plan vigente o con plan sin tope no se limita: el acceso lo corta el plan, no esto.
 */
'use strict';
const Models = require('../models/conection');
const { getLimitesNegocio } = require('./limitesNegocio');
const { sqlSinAsistente } = require('../dao/usuarioAsistenteDao');

const sequelize = Models.sequelize;

/** Usuarios que hoy ocupan sitio en el negocio. `excluirUsuario` = no contar a esa persona. */
async function contarUsuarios(idNegocio, { transaction, excluirUsuario = null } = {}) {
    const [fila] = await sequelize.query(
        `SELECT COUNT(DISTINCT nu.id_usuario)::int AS usados
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_usuario u ON u.id_usuario = nu.id_usuario AND u.estado = 'A'
          WHERE nu.id_negocio = :idNegocio
            AND nu.estado = 'A'
            AND ${sqlSinAsistente('u')}
            ${excluirUsuario ? 'AND nu.id_usuario <> :excluir' : ''}
            AND NOT EXISTS (
                SELECT 1 FROM general.gener_usuario_rol ur
                 WHERE ur.id_usuario = u.id_usuario
                   AND ur.id_negocio IS NULL
                   AND ur.estado = 'A'
            );`,
        {
            replacements: { idNegocio, ...(excluirUsuario ? { excluir: excluirUsuario } : {}) },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        },
    );
    return fila?.usados ?? 0;
}

/** ¿Esta persona ya ocupa un sitio en ESTE negocio (vínculo y usuario activos)? */
async function yaOcupaSitio(idUsuario, idNegocio, transaction) {
    const [fila] = await sequelize.query(
        `SELECT 1 AS ok
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_usuario u ON u.id_usuario = nu.id_usuario
          WHERE nu.id_usuario = :idUsuario AND nu.id_negocio = :idNegocio
            AND nu.estado = 'A' AND u.estado = 'A'
          LIMIT 1;`,
        { replacements: { idUsuario, idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
    );
    return Boolean(fila);
}

/** ¿Tiene un rol global activo (super admin)? Esa gente no cuenta contra el tope de nadie. */
async function tieneRolGlobal(idUsuario, transaction) {
    const [fila] = await sequelize.query(
        `SELECT 1 AS ok FROM general.gener_usuario_rol
          WHERE id_usuario = :idUsuario AND id_negocio IS NULL AND estado = 'A' LIMIT 1;`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT, transaction },
    );
    return Boolean(fila);
}

/**
 * Cuántos usuarios usa el negocio y cuántos le caben. Para mostrar «X de Y usuarios».
 * `total = null` = sin tope (sin plan vigente o plan sin límite).
 */
async function getUsoUsuarios(idNegocio, { transaction } = {}) {
    const [usados, limites] = await Promise.all([
        contarUsuarios(idNegocio, { transaction }),
        getLimitesNegocio(idNegocio, { transaction }),
    ]);
    return {
        usados,
        total: limites?.usuarios?.total ?? null,
        incluidos: limites?.usuarios?.incluidos ?? null,
        adicionales: limites?.usuarios?.adicionales ?? 0,
        plan: limites?.plan ?? null,
    };
}

/**
 * Lanza `409 LIMITE_USUARIOS` si ocupar un sitio más en el negocio lo pasaría del tope.
 *
 * @param {number} idNegocio
 * @param {object} [opciones]
 * @param {number} [opciones.idUsuario]   La persona que entraría, si YA existe. Con ella se sabe si
 *        de verdad ocupa un sitio nuevo (no lo ocupa si ya tenía el suyo, activo).
 * @param {string} [opciones.estadoFinal] `'A'` (por defecto) o `'I'`: si va a quedar inactivo no
 *        ocupa sitio y no se comprueba nada.
 * @param {object} [opciones.transaction]
 */
async function exigirCupoDeUsuario(idNegocio, { idUsuario = null, estadoFinal = 'A', transaction } = {}) {
    if (!idNegocio || estadoFinal !== 'A') return;

    if (idUsuario) {
        // Editar a quien ya ocupa su sitio no ocupa otro. Y quien es de la plataforma no cuenta.
        if (await yaOcupaSitio(idUsuario, idNegocio, transaction)) return;
        if (await tieneRolGlobal(idUsuario, transaction)) return;
    }

    const usados = await contarUsuarios(idNegocio, { transaction, excluirUsuario: idUsuario });

    // El primer usuario de un negocio nunca falla: sin él el negocio no se puede abrir.
    if (usados === 0) return;

    const limites = await getLimitesNegocio(idNegocio, { transaction });
    const tope = limites?.usuarios?.total ?? null;
    if (tope == null) return;

    if (usados >= tope) {
        const err = new Error(
            `Tu plan permite ${tope} ${tope === 1 ? 'usuario' : 'usuarios'} y ya hay ${usados} activos. ` +
            'Para añadir a alguien más, agrega el complemento «Usuario adicional» o cambia de plan.',
        );
        err.code = 'LIMITE_USUARIOS';
        err.statusCode = 409;
        err.limite = { total: tope, usados, plan: limites?.plan ?? null };
        throw err;
    }
}

module.exports = { exigirCupoDeUsuario, getUsoUsuarios, contarUsuarios };
