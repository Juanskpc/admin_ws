'use strict';
const Models = require('../../app_core/models/conection');
const EstadoCita = require('./estadoCita');
const CajaService = require('./cajaService');
const MetodoPagoService = require('./metodoPagoService');

/**
 * Completar una cita **es** cobrarla.
 *
 * Antes `completar` solo cambiaba el estado. Ahora la misma operación registra con qué se pagó,
 * lo asienta en la caja abierta y deja la cita ligada a ese turno — todo en **una transacción**.
 * La atomicidad no es un adorno: si el movimiento de caja fallara después de marcar la cita como
 * completada, quedaría trabajo cobrado que no aparece en ningún turno, y eso solo se descubre al
 * cuadrar, cuando ya nadie recuerda qué pasó.
 *
 * ## Qué se valida, y por qué en este orden
 *
 * 1. **La transición** (`pendiente|confirmada → completada`). Lo primero: si la cita ya estaba
 *    cerrada no hay nada que cobrar.
 * 2. **Las formas de pago**, que deben ser del negocio y estar activas.
 * 3. **El cuadre**: en multipago la suma debe ser exactamente el total. Se compara en
 *    centavos enteros, nunca `a === b` sobre flotantes — `0.1 + 0.2` no vale `0.3` y un cuadre
 *    correcto se rechazaría.
 * 4. **La caja**, solo si el negocio la exige o si de verdad hay dinero que asentar.
 *
 * ## Cuándo NO se toca la caja
 *
 * Una cita de importe cero (cortesía, o un negocio que no cobra por aquí) se completa sin
 * movimiento: un ingreso de 0 ensucia el turno y no cuadra nada. Y si el negocio no exige caja
 * abierta, se completa igual y queda registrada en `getCitasSinCaja` para que el cierre lo avise.
 */

function errorValidacion(mensaje, code) {
    const e = new Error(mensaje);
    e.statusCode = 422;
    if (code) e.code = code;
    return e;
}

/** Compara importes en centavos enteros: los flotantes no son fiables para dinero. */
function centavos(v) {
    return Math.round(Number(v) * 100);
}

/**
 * Normaliza la entrada de pago a una lista `[{ id_metodo_pago, valor }]`.
 *
 * Acepta las dos formas que manda el frontend: `id_metodo_pago` suelto (pago simple) o `pagos[]`
 * (multipago). Devolver siempre una lista deja el resto del flujo con un solo caso que tratar.
 */
function normalizarPagos({ idMetodoPago, pagos, total }) {
    if (Array.isArray(pagos) && pagos.length > 0) {
        const limpios = pagos
            .map(p => ({ id_metodo_pago: Number(p.id_metodo_pago), valor: Number(p.valor) }))
            .filter(p => Number.isInteger(p.id_metodo_pago) && Number.isFinite(p.valor));

        if (limpios.length !== pagos.length) {
            throw errorValidacion('Hay formas de pago incompletas en el desglose.');
        }
        if (limpios.some(p => p.valor <= 0)) {
            throw errorValidacion('Cada forma de pago debe llevar un valor mayor que cero.');
        }
        const repetidos = new Set();
        for (const p of limpios) {
            if (repetidos.has(p.id_metodo_pago)) {
                throw errorValidacion('No repitas la misma forma de pago en el desglose.');
            }
            repetidos.add(p.id_metodo_pago);
        }
        const suma = limpios.reduce((a, p) => a + centavos(p.valor), 0);
        if (suma !== centavos(total)) {
            const dif = (suma - centavos(total)) / 100;
            throw errorValidacion(
                dif > 0
                    ? `El desglose supera el total en ${dif}. Ajusta los valores.`
                    : `Faltan ${-dif} por asignar en el desglose.`,
                'PAGO_NO_CUADRA',
            );
        }
        return { modo: 'multi', lista: limpios };
    }

    if (idMetodoPago != null) {
        return {
            modo: 'simple',
            lista: [{ id_metodo_pago: Number(idMetodoPago), valor: Number(total) }],
        };
    }

    return { modo: 'ninguno', lista: [] };
}

/**
 * Completa y cobra la cita.
 *
 * @returns la cita actualizada, o `null` si no existe (el controlador lo traduce a 404).
 */
async function completarYCobrar({ idCita, idNegocio, idUsuario, idMetodoPago, pagos }) {
    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    const exigeCaja = !!cfg?.exige_caja_abierta;
    const permiteMultipago = !!cfg?.permite_multipago;

    return Models.sequelize.transaction(async (t) => {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) return null;

        EstadoCita.exigirTransicion(cita.estado, 'completada');

        const total = Number(cita.monto_total ?? 0);
        const { modo, lista } = normalizarPagos({ idMetodoPago, pagos, total });

        if (modo === 'multi' && !permiteMultipago) {
            throw errorValidacion('Este negocio no tiene habilitado el pago con varias formas.');
        }
        if (lista.length > 0) {
            await MetodoPagoService.validarDelNegocio(
                idNegocio, lista.map(p => p.id_metodo_pago), { transaction: t },
            );
        }

        // Una cita con importe se cobra: exigir la forma de pago es lo que hace que la caja
        // cuadre. Sin importe, no hay nada que preguntar.
        if (total > 0 && lista.length === 0) {
            throw errorValidacion('Indica con qué forma de pago se cobró la cita.', 'PAGO_REQUERIDO');
        }

        let idCaja = null;
        if (total > 0 && lista.length > 0) {
            const caja = exigeCaja
                ? await CajaService.requireCajaAbierta(idNegocio, { transaction: t })
                : await CajaService.getCajaAbiertaRaw(idNegocio, { transaction: t, bloquear: true });

            if (caja) {
                await CajaService.registrarCobroCita({
                    idNegocio, cita, pagos: lista, idUsuario, transaction: t,
                });
                idCaja = caja.id_caja;
            }
        }

        // El desglose solo se guarda en multipago; en pago simple `id_metodo_pago` ya lo dice
        // todo y una tabla de detalle con una sola fila es ruido.
        if (modo === 'multi') {
            await Models.ReservaPagoCita.destroy({ where: { id_cita: cita.id_cita }, transaction: t });
            await Models.ReservaPagoCita.bulkCreate(
                lista.map(p => ({ id_cita: cita.id_cita, id_metodo_pago: p.id_metodo_pago, valor: p.valor })),
                { transaction: t },
            );
        }

        return cita.update({
            estado: 'completada',
            id_metodo_pago: modo === 'simple' ? lista[0].id_metodo_pago : null,
            id_caja: idCaja,
            fecha_actualizacion: new Date(),
        }, { transaction: t });
    });
}

module.exports = { completarYCobrar, normalizarPagos };
