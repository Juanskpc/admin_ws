'use strict';
const Models = require('../../app_core/models/conection');
const { getLimitesNegocio } = require('../../app_core/helpers/limitesNegocio');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');
const { asegurarCajaPrincipal } = require('../../app_core/helpers/cajaPrincipal');
const { avisar, TEMAS } = require('./avisoService');

/**
 * puntoCajaService — las cajas del negocio entendidas como RUBROS de ingreso.
 *
 * Un restaurante con tienda de abarrotes cobra dos cosas que no se mezclan: la comida y la
 * tienda. Cada una lleva sus turnos, su arqueo y sus informes por separado, aunque las
 * atienda la misma persona en el mismo mostrador. Eso es un «punto de caja».
 *
 * Lo importante de este archivo es lo que NO hace: el negocio con una sola caja —que hoy son
 * todos los de producción— nunca ve una pregunta nueva. `resolverPuntoCaja` le devuelve la
 * única que hay y el resto del sistema sigue igual que antes. La elección solo aparece cuando
 * el usuario tiene de verdad más de una, que es cuando la pregunta significa algo.
 *
 * Permisos: crear, renombrar, desactivar y asignar exige el subnivel `caja_gestionar`
 * (lo hereda ADMINISTRADOR). Consultar las propias cajas no exige nada: el POS lo necesita
 * para pintar el selector.
 */

const SUBNIVEL_GESTIONAR = 'caja_gestionar';

const sequelize = Models.sequelize;

// ── Errores del dominio ───────────────────────────────────────────────────────────────────

function errorTipado(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

/**
 * El usuario tiene varias cajas y no dijo cuál.
 *
 * Lleva la lista en el error a propósito: quien llama (el POS, el cobro) puede pintar el
 * selector con esto sin una segunda vuelta al servidor.
 */
function errorPuntoRequerido(puntos) {
    const err = errorTipado(
        'Este negocio maneja varias cajas: indica en cuál va el movimiento.',
        'PUNTO_CAJA_REQUERIDO',
        409,
    );
    err.puntos = puntos.map((p) => ({ id_punto_caja: p.id_punto_caja, nombre: p.nombre }));
    return err;
}

// ── Consultas ─────────────────────────────────────────────────────────────────────────────

/** Cajas activas del negocio, en el orden en que se muestran. */
async function listarActivas(idNegocio, { transaction } = {}) {
    return sequelize.query(
        `SELECT id_punto_caja, nombre, descripcion, orden, estado
           FROM restaurante.rest_punto_caja
          WHERE id_negocio = :idNegocio AND estado = 'A'
          ORDER BY orden ASC, nombre ASC;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
    );
}

/**
 * Listado de administración: todas las cajas (activas e inactivas) con lo que hace falta
 * para decidir sobre ellas — cuánta gente tiene asignada, si hay turno abierto y si ya
 * movió pedidos (una caja con historia no se borra, se desactiva).
 */
async function listarParaAdmin(idNegocio) {
    const [filas, limites] = await Promise.all([
        sequelize.query(
            `SELECT pc.id_punto_caja,
                    pc.nombre,
                    pc.descripcion,
                    pc.orden,
                    pc.estado,
                    (SELECT COUNT(*)::int
                       FROM restaurante.rest_punto_caja_usuario a
                      WHERE a.id_punto_caja = pc.id_punto_caja AND a.estado = 'A') AS usuarios,
                    (SELECT COUNT(*)::int
                       FROM restaurante.pedid_orden o
                      WHERE o.id_punto_caja = pc.id_punto_caja)                    AS pedidos,
                    (SELECT c.id_caja
                       FROM restaurante.rest_caja c
                      WHERE c.id_punto_caja = pc.id_punto_caja AND c.estado = 'A'
                      LIMIT 1)                                                     AS turno_abierto
               FROM restaurante.rest_punto_caja pc
              WHERE pc.id_negocio = :idNegocio
              ORDER BY pc.estado ASC, pc.orden ASC, pc.nombre ASC;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
        ),
        getLimitesNegocio(idNegocio),
    ]);

    const activas = filas.filter((f) => f.estado === 'A').length;
    const tope = limites?.cajas?.total ?? null;

    return {
        rows: filas.map((f) => ({
            id_punto_caja: Number(f.id_punto_caja),
            nombre: f.nombre,
            descripcion: f.descripcion,
            orden: Number(f.orden ?? 0),
            estado: f.estado,
            usuarios: Number(f.usuarios ?? 0),
            pedidos: Number(f.pedidos ?? 0),
            turno_abierto: f.turno_abierto != null,
        })),
        limite: {
            // `null` es sin tope. Se manda tal cual para que la pantalla no invente un número.
            total: tope,
            usadas: activas,
            disponibles: tope == null ? null : Math.max(0, tope - activas),
            plan: limites?.plan ?? null,
        },
    };
}

/**
 * Las cajas que ESTE usuario puede usar.
 *
 * Sin asignaciones, se le dan todas las activas. Es lo correcto en los dos casos que
 * importan: el negocio de una caja (no hay nada que elegir) y el negocio que acaba de crear
 * la segunda y todavía no ha repartido a nadie — ahí es preferible que todos vean las dos a
 * que el POS se quede sin caja y nadie pueda cobrar.
 */
async function cajasDeUsuario({ idNegocio, idUsuario, transaction } = {}) {
    const asignadas = await sequelize.query(
        `SELECT pc.id_punto_caja, pc.nombre, pc.descripcion, pc.orden, pc.estado
           FROM restaurante.rest_punto_caja_usuario a
           JOIN restaurante.rest_punto_caja pc ON pc.id_punto_caja = a.id_punto_caja
          WHERE a.id_usuario = :idUsuario
            AND a.id_negocio = :idNegocio
            AND a.estado = 'A'
            AND pc.estado = 'A'
          ORDER BY pc.orden ASC, pc.nombre ASC;`,
        { replacements: { idNegocio, idUsuario }, type: sequelize.QueryTypes.SELECT, transaction },
    );
    if (asignadas.length > 0) return asignadas;
    return listarActivas(idNegocio, { transaction });
}

/**
 * La caja en la que va esta operación. Es el único sitio donde se decide.
 *
 * - Si llega `idPuntoCaja`, se comprueba que exista, esté activa y —cuando se pasa
 *   `idUsuario`— que sea del usuario. No vale mandar el id de la caja del vecino.
 * - Si no llega y solo hay una posible, esa. Aquí es donde el negocio de siempre no nota
 *   ningún cambio.
 * - Si no llega y hay varias, PUNTO_CAJA_REQUERIDO con la lista para que elija.
 *
 * @returns {Promise<{id_punto_caja:number, nombre:string}>}
 */
async function resolverPuntoCaja({ idNegocio, idUsuario = null, idPuntoCaja = null, transaction } = {}) {
    const disponibles = idUsuario
        ? await cajasDeUsuario({ idNegocio, idUsuario, transaction })
        : await listarActivas(idNegocio, { transaction });

    if (idPuntoCaja != null && idPuntoCaja !== '') {
        const buscado = Number(idPuntoCaja);
        const punto = disponibles.find((p) => Number(p.id_punto_caja) === buscado);
        if (!punto) {
            throw errorTipado(
                'La caja indicada no existe, está inactiva o no está asignada a este usuario.',
                'PUNTO_CAJA_INVALIDO',
                422,
            );
        }
        return punto;
    }

    if (disponibles.length === 0) {
        // Un negocio sin ninguna caja no puede tomar un pedido ni cobrar: está muerto. Como eso
        // no es una decisión de nadie sino un hueco (un negocio que se creó antes de que esto
        // existiera, o un alta por un camino que se nos pasó), se le crea la suya en vez de
        // dejarlo bloqueado. Es idempotente y solo ocurre una vez en la vida del negocio.
        const creada = await asegurarCajaPrincipal(idNegocio, { transaction });
        if (creada) return { id_punto_caja: Number(creada.id_punto_caja), nombre: creada.nombre };

        // Aquí sí hay decisión detrás: alguien desactivó la última caja a mano.
        throw errorTipado(
            'Este negocio no tiene ninguna caja activa. Crea una en Configuración para poder operar.',
            'SIN_PUNTO_CAJA',
            409,
        );
    }
    if (disponibles.length === 1) return disponibles[0];

    throw errorPuntoRequerido(disponibles);
}

// ── Escritura ─────────────────────────────────────────────────────────────────────────────

async function exigirPermiso({ idUsuario, idNegocio }) {
    const puede = await usuarioTieneSubnivel({
        idUsuario, idNegocio, codigo: SUBNIVEL_GESTIONAR,
    });
    if (!puede) {
        throw errorTipado('No tienes permiso para gestionar las cajas del negocio.', 'SIN_PERMISO_CAJAS', 403);
    }
}

/**
 * ¿Cabe una caja activa más? Tope = cajas del plan + complemento «Caja adicional».
 * Sin plan vigente (o plan sin tope) no se limita: el acceso lo corta el plan, no esto.
 */
async function exigirCupoDeCaja(idNegocio) {
    const limites = await getLimitesNegocio(idNegocio);
    const tope = limites?.cajas?.total ?? null;
    if (tope == null) return;
    const activas = await listarActivas(idNegocio);
    if (activas.length >= tope) {
        const err = errorTipado(
            `Tu plan permite ${tope} caja(s). Para abrir otra, añade el complemento de caja adicional.`,
            'LIMITE_CAJAS',
            409,
        );
        err.limite = { total: tope, usadas: activas.length, plan: limites?.plan ?? null };
        throw err;
    }
}

/** Una caja nueva. Cuenta contra el tope de cajas del plan (incluidas + complementos). */
async function crearPunto({ idNegocio, idUsuario, nombre, descripcion = null }) {
    await exigirPermiso({ idUsuario, idNegocio });

    const limpio = String(nombre || '').trim();
    if (limpio.length < 2) {
        throw errorTipado('El nombre de la caja es obligatorio.', 'NOMBRE_INVALIDO', 422);
    }

    // Crear, o reactivar una con el mismo nombre, suma una caja activa: las dos cuentan.
    await exigirCupoDeCaja(idNegocio);

    const t = await sequelize.transaction();
    try {
        const repetida = await Models.RestPuntoCaja.findOne({
            where: { id_negocio: idNegocio, nombre: limpio }, transaction: t,
        });
        if (repetida) {
            // Reactivar la que ya existía es mejor que rebotar: conserva sus pedidos y su
            // historia, que es justo lo que el usuario quiere cuando repite el nombre.
            if (repetida.estado === 'I') {
                repetida.estado = 'A';
                repetida.descripcion = descripcion || repetida.descripcion;
                repetida.actualizado_en = new Date();
                await repetida.save({ transaction: t });
                await t.commit();
                avisar(idNegocio, TEMAS.CAJA);
                return repetida.toJSON();
            }
            throw errorTipado('Ya existe una caja con ese nombre.', 'NOMBRE_DUPLICADO', 409);
        }

        const [{ siguiente }] = await sequelize.query(
            `SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente
               FROM restaurante.rest_punto_caja WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction: t },
        );

        const punto = await Models.RestPuntoCaja.create({
            id_negocio: idNegocio,
            nombre: limpio,
            descripcion: descripcion ? String(descripcion).trim() : null,
            orden: Number(siguiente ?? 1),
            estado: 'A',
        }, { transaction: t });

        await t.commit();
        avisar(idNegocio, TEMAS.CAJA);
        return punto.toJSON();
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/** Renombrar, redescribir, reordenar o activar/desactivar. */
async function actualizarPunto({ idNegocio, idUsuario, idPuntoCaja, nombre, descripcion, orden, estado }) {
    await exigirPermiso({ idUsuario, idNegocio });

    const punto = await Models.RestPuntoCaja.findOne({
        where: { id_punto_caja: idPuntoCaja, id_negocio: idNegocio },
    });
    if (!punto) throw errorTipado('Caja no encontrada.', 'PUNTO_CAJA_NO_ENCONTRADO', 404);

    if (nombre != null) {
        const limpio = String(nombre).trim();
        if (limpio.length < 2) throw errorTipado('El nombre de la caja es obligatorio.', 'NOMBRE_INVALIDO', 422);
        const repetida = await Models.RestPuntoCaja.findOne({ where: { id_negocio: idNegocio, nombre: limpio } });
        if (repetida && Number(repetida.id_punto_caja) !== Number(idPuntoCaja)) {
            throw errorTipado('Ya existe una caja con ese nombre.', 'NOMBRE_DUPLICADO', 409);
        }
        punto.nombre = limpio;
    }
    if (descripcion !== undefined) punto.descripcion = descripcion ? String(descripcion).trim() : null;
    if (orden != null && Number.isFinite(Number(orden))) punto.orden = Number(orden);

    if (estado && estado !== punto.estado) {
        if (estado === 'I') {
            // Desactivar una caja con el turno abierto dejaría su plata sin arquear, y con
            // pedidos vivos dejaría comida sin poder cobrarse. Se cierra primero.
            const [abierto] = await sequelize.query(
                `SELECT id_caja FROM restaurante.rest_caja
                  WHERE id_punto_caja = :idPuntoCaja AND estado = 'A' LIMIT 1;`,
                { replacements: { idPuntoCaja }, type: sequelize.QueryTypes.SELECT },
            );
            if (abierto) {
                throw errorTipado(
                    'Esta caja tiene un turno abierto. Ciérralo antes de desactivarla.',
                    'PUNTO_CAJA_CON_TURNO',
                    409,
                );
            }
            const [{ pendientes }] = await sequelize.query(
                `SELECT COUNT(*)::int AS pendientes FROM restaurante.pedid_orden
                  WHERE id_punto_caja = :idPuntoCaja AND estado = 'ABIERTA';`,
                { replacements: { idPuntoCaja }, type: sequelize.QueryTypes.SELECT },
            );
            if (Number(pendientes) > 0) {
                throw errorTipado(
                    `Esta caja tiene ${pendientes} pedido(s) sin cerrar.`,
                    'PUNTO_CAJA_CON_PEDIDOS',
                    409,
                );
            }
            const activas = await listarActivas(idNegocio);
            if (activas.length <= 1) {
                throw errorTipado('El negocio necesita al menos una caja activa.', 'ULTIMA_CAJA', 409);
            }
        } else if (estado === 'A') {
            // Reactivar es abrir una caja más: cuenta contra el mismo tope que crearla. Sin
            // esto bastaba desactivar y reactivar para saltarse el límite del plan.
            await exigirCupoDeCaja(idNegocio);
        }
        punto.estado = estado;
    }

    punto.actualizado_en = new Date();
    await punto.save();
    avisar(idNegocio, TEMAS.CAJA);
    return punto.toJSON();
}

/**
 * Fija de una vez las cajas de un usuario. Es la forma en que lo usa la pantalla de
 * usuarios: llega la lista completa y esto la cuadra (reactiva las que vuelven, desactiva
 * las que salen) en lugar de borrar y recrear, para no perder la fecha de asignación.
 *
 * Lista vacía = sin asignación explícita = ve todas las activas (ver `cajasDeUsuario`).
 */
async function fijarCajasDeUsuario({ idNegocio, idUsuario, idUsuarioObjetivo, idsPuntos = [], transaction = null }) {
    // La asignación puede venir del alta de un usuario (que ya validó su propio permiso) o
    // de la pantalla de cajas. Cuando llega `idUsuario` se comprueba aquí.
    if (idUsuario) await exigirPermiso({ idUsuario, idNegocio });

    const ids = [...new Set((idsPuntos || []).map(Number).filter((n) => Number.isFinite(n)))];

    const ejecutar = async (t) => {
        // El id del usuario llega por la ruta: sin esto se podrían crear asignaciones para
        // alguien que no es de este negocio.
        const [miembro] = await sequelize.query(
            `SELECT 1 AS ok FROM general.gener_negocio_usuario
              WHERE id_negocio = :idNegocio AND id_usuario = :idUsuarioObjetivo LIMIT 1;`,
            { replacements: { idNegocio, idUsuarioObjetivo }, type: sequelize.QueryTypes.SELECT, transaction: t },
        );
        if (!miembro) {
            throw errorTipado('El usuario no pertenece a este negocio.', 'USUARIO_AJENO', 404);
        }

        if (ids.length > 0) {
            const validas = await sequelize.query(
                `SELECT id_punto_caja FROM restaurante.rest_punto_caja
                  WHERE id_negocio = :idNegocio AND id_punto_caja IN (:ids);`,
                { replacements: { idNegocio, ids }, type: sequelize.QueryTypes.SELECT, transaction: t },
            );
            if (validas.length !== ids.length) {
                throw errorTipado('Alguna de las cajas no pertenece a este negocio.', 'PUNTO_CAJA_INVALIDO', 422);
            }
        }

        await sequelize.query(
            `UPDATE restaurante.rest_punto_caja_usuario
                SET estado = 'I'
              WHERE id_usuario = :idUsuarioObjetivo AND id_negocio = :idNegocio
                ${ids.length > 0 ? 'AND id_punto_caja NOT IN (:ids)' : ''};`,
            {
                replacements: { idNegocio, idUsuarioObjetivo, ids: ids.length > 0 ? ids : [0] },
                type: sequelize.QueryTypes.UPDATE,
                transaction: t,
            },
        );

        for (const idPunto of ids) {
            await sequelize.query(
                `INSERT INTO restaurante.rest_punto_caja_usuario (id_punto_caja, id_usuario, id_negocio, estado)
                 VALUES (:idPunto, :idUsuarioObjetivo, :idNegocio, 'A')
                 ON CONFLICT (id_punto_caja, id_usuario) DO UPDATE SET estado = 'A';`,
                {
                    replacements: { idPunto, idUsuarioObjetivo, idNegocio },
                    type: sequelize.QueryTypes.INSERT,
                    transaction: t,
                },
            );
        }
    };

    if (transaction) {
        await ejecutar(transaction);
    } else {
        const t = await sequelize.transaction();
        try {
            await ejecutar(t);
            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
        avisar(idNegocio, TEMAS.CAJA);
    }

    return cajasDeUsuario({ idNegocio, idUsuario: idUsuarioObjetivo });
}

/** Quién tiene asignada cada caja, para pintar la pantalla de gestión. */
async function listarAsignaciones(idNegocio) {
    return sequelize.query(
        `SELECT a.id_punto_caja, a.id_usuario,
                u.primer_nombre, u.primer_apellido
           FROM restaurante.rest_punto_caja_usuario a
           JOIN general.gener_usuario u ON u.id_usuario = a.id_usuario
          WHERE a.id_negocio = :idNegocio AND a.estado = 'A'
          ORDER BY u.primer_nombre ASC;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
}

module.exports = {
    SUBNIVEL_GESTIONAR,
    listarActivas,
    listarParaAdmin,
    cajasDeUsuario,
    resolverPuntoCaja,
    crearPunto,
    actualizarPunto,
    fijarCajasDeUsuario,
    listarAsignaciones,
};
