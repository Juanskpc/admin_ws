'use strict';
const Models = require('../../app_core/models/conection');

async function listar(idNegocio, soloActivos = true) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.RestMetodoPago.findAll({
        where, order: [['nombre', 'ASC']],
    });
}

async function crear({ idNegocio, nombre }) {
    const trimmed = String(nombre || '').trim();
    if (!trimmed) {
        const e = new Error('Nombre requerido'); e.statusCode = 422; throw e;
    }
    return Models.RestMetodoPago.create({ id_negocio: idNegocio, nombre: trimmed, estado: 'A' });
}

async function actualizar({ idMetodo, idNegocio, nombre }) {
    const m = await Models.RestMetodoPago.findOne({ where: { id_metodo_pago: idMetodo, id_negocio: idNegocio } });
    if (!m) return null;
    const trimmed = String(nombre || '').trim();
    if (!trimmed) {
        const e = new Error('Nombre requerido'); e.statusCode = 422; throw e;
    }
    return m.update({ nombre: trimmed });
}

/**
 * Cuánto del turno en curso depende de esta forma de pago.
 *
 * Hace falta porque apagar una forma de pago NO la borra, pero sí la saca de la lista
 * de las válidas: `validarMetodoPagoParaNegocio` exige `estado='A'`, así que un pedido
 * que ya la llevaba deja de poder cobrarse o modificarse y devuelve «Método de pago
 * inválido para este negocio». El cajero apagaba «Transferencia» en Configuración y el
 * fallo aparecía después, en Pedidos, sin ninguna pista de que él lo había causado.
 *
 * Se mira el turno abierto y los pedidos sin cobrar, que son los dos sitios donde la
 * forma de pago todavía tiene que funcionar. Lo ya cerrado no estorba: nadie va a
 * volver a cobrarlo, y el desglose de un turno pasado la sigue nombrando por su id.
 *
 * @returns {Promise<{ cobrados: number, sin_cobrar: number, movimientos: number, total: number }>}
 */
async function contarUsoEnTurnoAbierto({ idMetodo, idNegocio }) {
    const [fila] = await Models.sequelize.query(`
        WITH caja AS (
            SELECT id_caja FROM restaurante.rest_caja
            WHERE id_negocio = :idNegocio AND estado = 'A'
            LIMIT 1
        ),
        -- Un pedido «lleva» la forma de pago por su columna o por el desglose del
        -- multipago; las dos rutas rompen igual, así que las dos cuentan.
        ordenes AS (
            SELECT o.id_orden, o.estado, o.id_caja
            FROM restaurante.pedid_orden o
            WHERE o.id_negocio = :idNegocio
              AND (
                  o.id_metodo_pago = :idMetodo
                  OR EXISTS (
                      SELECT 1 FROM restaurante.rest_pago_orden p
                      WHERE p.id_orden = o.id_orden AND p.id_metodo_pago = :idMetodo
                  )
              )
              AND (
                  -- cobrado dentro del turno que sigue abierto
                  o.id_caja = (SELECT id_caja FROM caja)
                  -- o todavía sin cobrar, que es donde volvería a validarse
                  OR o.estado = 'ABIERTA'
              )
        )
        SELECT
            (SELECT COUNT(*) FROM ordenes WHERE estado <> 'ABIERTA')::int AS cobrados,
            (SELECT COUNT(*) FROM ordenes WHERE estado =  'ABIERTA')::int AS sin_cobrar,
            (SELECT COUNT(*) FROM restaurante.rest_movimiento_caja m
              WHERE m.id_metodo_pago = :idMetodo
                AND m.id_caja = (SELECT id_caja FROM caja))::int          AS movimientos
    `, {
        replacements: { idMetodo, idNegocio },
        type: Models.sequelize.QueryTypes.SELECT,
    });

    const cobrados = Number(fila?.cobrados ?? 0);
    const sinCobrar = Number(fila?.sin_cobrar ?? 0);
    const movimientos = Number(fila?.movimientos ?? 0);
    return { cobrados, sin_cobrar: sinCobrar, movimientos, total: cobrados + sinCobrar + movimientos };
}

/** Une los conteos en una frase que diga qué estorba, y no solo que algo estorba. */
function describirUso({ cobrados, sin_cobrar: sinCobrar, movimientos }) {
    const partes = [];
    if (cobrados)    partes.push(`${cobrados} pedido(s) cobrado(s) en el turno abierto`);
    if (sinCobrar)   partes.push(`${sinCobrar} pedido(s) sin cobrar`);
    if (movimientos) partes.push(`${movimientos} movimiento(s) de caja`);
    return partes.join(', ');
}

async function inactivar({ idMetodo, idNegocio }) {
    const m = await Models.RestMetodoPago.findOne({ where: { id_metodo_pago: idMetodo, id_negocio: idNegocio } });
    if (!m) return null;

    // «Cuenta / Tiquetera» no es una forma de pago más: es la que le dice al cobro que ese
    // dinero no entra al cajón hoy. Apagarla dejaría el módulo de clientes sin manera de
    // cobrar, y el fallo aparecería lejos de aquí —al intentar cobrar— sin decir por qué.
    // Renombrarla sí se permite: el código la reconoce por la marca, no por el nombre.
    if (m.es_cuenta) {
        const e = new Error('La forma de pago de las cuentas de cliente no se puede desactivar.');
        e.code = 'METODO_PAGO_PROTEGIDO';
        e.statusCode = 409;
        throw e;
    }

    // La caja tiene que estar limpia de esta forma de pago antes de apagarla. Cerrar el
    // turno basta: a partir de ahí nada vuelve a validarla, y el histórico la sigue
    // mostrando por su nombre porque la fila no se borra.
    const uso = await contarUsoEnTurnoAbierto({ idMetodo, idNegocio });
    if (uso.total > 0) {
        const e = new Error(
            `No se puede eliminar «${m.nombre}»: el turno actual todavía la usa (${describirUso(uso)}). `
            + 'Cierra la caja y vuelve a intentarlo.',
        );
        e.code = 'METODO_PAGO_EN_USO';
        e.statusCode = 409;
        e.uso = uso;
        throw e;
    }

    return m.update({ estado: 'I' });
}

module.exports = { listar, crear, actualizar, inactivar, contarUsoEnTurnoAbierto };
