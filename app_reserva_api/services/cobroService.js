'use strict';
const Models = require('../../app_core/models/conection');
const EstadoCita = require('./estadoCita');
const CajaService = require('./cajaService');
const MetodoPagoService = require('./metodoPagoService');
const Perfiles = require('../perfiles');

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
 * 4. **La caja abierta**, siempre que haya dinero que asentar.
 *
 * ## Sin caja abierta no se cobra. Nunca.
 *
 * Esto no depende de la configuración del negocio. Antes `exige_caja_abierta` permitía cobrar
 * con el turno cerrado: la cita se completaba, el dinero no entraba en ninguna caja y quedaba
 * en `getCitasSinCaja` como aviso. En la práctica ese aviso se leía al cerrar —horas después—,
 * cuando ya nadie sabía si ese efectivo estaba en el cajón o en el bolsillo de alguien. Un
 * cobro que no cae en un turno no se puede cuadrar, así que se rechaza con `CAJA_CERRADA` y se
 * abre la caja, que cuesta diez segundos. El flag se conserva en la tabla por compatibilidad,
 * pero ya no decide nada.
 *
 * ## Cuándo NO se toca la caja
 *
 * Una cita de importe cero (cortesía, o un negocio que no cobra por aquí) se completa sin
 * movimiento: un ingreso de 0 ensucia el turno y no cuadra nada. Ese caso —y solo ese— sigue
 * pudiendo completarse con la caja cerrada, porque no hay dinero que asentar.
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
async function completarYCobrar({
    idCita, idNegocio, idUsuario, idMetodoPago, pagos,
    // [{ id_servicio, precio }] — el precio final de los servicios con rango (o a cotizar), que
    // se decide al cobrar: el catálogo solo daba «$25.000 - $40.000».
    precios = null,
    // 'SERVICIO' (por defecto) o 'ASESORIA': una asesoría no mueve dinero (ver abajo).
    tipoCobro = 'SERVICIO',
}) {
    const esAsesoria = String(tipoCobro || '').toUpperCase() === 'ASESORIA';
    const cfg = await Models.ReservaConfig.findByPk(idNegocio);
    const permiteMultipago = !!cfg?.permite_multipago;

    return Models.sequelize.transaction(async (t) => {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) return null;

        EstadoCita.exigirTransicion(cita.estado, 'completada');

        // Consentimiento informado: un servicio que lo exige no se completa sin él registrado en
        // la ficha de esta cita. Solo con la función encendida; la barbería no la tiene.
        const funciones = new Set((await Perfiles.perfilDeNegocio(idNegocio, { transaction: t })).funciones);
        if (funciones.has('consentimiento')) await exigirConsentimiento(cita, t);

        // Precio final de los servicios con rango o a cotizar, escrito en el diálogo de cobro.
        if (Array.isArray(precios) && precios.length > 0) {
            await aplicarPreciosFinales(cita, precios, t);
        }

        // Un servicio «a cotizar» (tatuajes, estética a medida) nace sin precio de lista — el
        // catálogo da como mucho un rango de referencia — y si nadie escribió el precio acordado
        // al agendar o editar la cita, la línea se quedó con `precio_snapshot = 0`. Completar así
        // factura la cita por nada, y no se nota hasta que se cuadra la caja. La barbería no
        // tiene esta función y estas líneas no existen para ella.
        if (funciones.has('a_cotizar') && !esAsesoria) {
            const lineas = await Models.ReservaCitaServicio.findAll({
                where: { id_cita: cita.id_cita },
                include: [{ model: Models.ReservaServicio, as: 'servicio', attributes: ['a_cotizar'] }],
                transaction: t,
            });
            const sinPrecio = lineas.some(l => l.servicio?.a_cotizar && Number(l.precio_snapshot) <= 0);
            if (sinPrecio) {
                throw errorValidacion(
                    'Escribe el precio acordado del servicio a cotizar antes de completar la cita.',
                    'PRECIO_A_COTIZAR_REQUERIDO',
                );
            }
        }

        // Con abono aprobado se cobra el SALDO: el abono ya se pagó. Sin abono (`monto_abono`
        // nulo, el caso de siempre) el saldo es el total y todo lo de abajo es lo de antes.
        const total = Number(cita.monto_total ?? 0);
        const abono = cita.monto_abono != null && cita.pago_estado === 'aprobado'
            ? Math.min(Number(cita.monto_abono), total)
            : 0;
        const abonoPorAsentar = abono > 0 && !cita.id_caja_abono;
        // Una asesoría no cobra saldo: el abono que ya se hubiera pagado sigue siendo dinero
        // recibido, pero no se pide nada más.
        const saldo = esAsesoria ? 0 : Math.max(0, total - abono);
        const { modo, lista } = esAsesoria
            ? { modo: 'ninguno', lista: [] }
            : normalizarPagos({ idMetodoPago, pagos, total: saldo });

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
        if (saldo > 0 && lista.length === 0) {
            throw errorValidacion('Indica con qué forma de pago se cobró la cita.', 'PAGO_REQUERIDO');
        }

        let idCaja = null;
        if (saldo > 0 && lista.length > 0) {
            const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
            await CajaService.registrarCobroCita({
                idNegocio, cita, pagos: lista, idUsuario, transaction: t,
            });
            idCaja = caja.id_caja;
        }

        // El abono que se aprobó con la caja cerrada entra ahora, en el mismo turno que el saldo.
        let idCajaAbono = cita.id_caja_abono;
        if (abonoPorAsentar) {
            const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
            await CajaService.registrarMovimiento({
                idCaja: caja.id_caja,
                tipo: 'INGRESO',
                monto: abono,
                concepto: `Abono cita #${cita.id_cita} · ${cita.cliente_nombre}`,
                idUsuario,
                idCita: cita.id_cita,
                idProfesional: cita.id_profesional,
                idMetodoPago: cita.id_metodo_pago_abono ?? null,
                transaction: t,
            });
            idCajaAbono = caja.id_caja;
            idCaja = idCaja ?? caja.id_caja;
        }

        // Asesoría: queda en el historial del turno como un movimiento propio, sin sumar ni restar.
        if (esAsesoria) {
            const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
            await Models.ReservaMovimientoCaja.create({
                id_caja: caja.id_caja,
                tipo: 'ASESORIA',
                monto: 0,
                concepto: `Asesoría · cita #${cita.id_cita} · ${cita.cliente_nombre}`,
                id_cita: cita.id_cita,
                id_profesional: cita.id_profesional,
                id_usuario: idUsuario,
            }, { transaction: t });
            idCaja = idCaja ?? caja.id_caja;
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
            tipo_cobro: esAsesoria ? 'ASESORIA' : 'SERVICIO',
            // Una asesoría no factura: su total es lo que de verdad se recibió (el abono, si lo
            // hubo). Así los informes y el dashboard no la cuentan como ingreso.
            ...(esAsesoria ? { monto_total: abono } : {}),
            id_metodo_pago: modo === 'simple' ? lista[0].id_metodo_pago : null,
            id_caja: idCaja,
            ...(abonoPorAsentar ? { id_caja_abono: idCajaAbono } : {}),
            fecha_actualizacion: new Date(),
        }, { transaction: t });
    });
}

/**
 * Fija el precio final de las líneas con rango de precio o «a cotizar» y ajusta el total.
 *
 * El total se ajusta por DIFERENCIA (nuevo − anterior) y no se recalcula desde cero: así no se
 * pierde nada que la cita sume aparte de sus líneas. Una línea de precio fijo no se toca aunque
 * venga en la lista: su precio lo decide el catálogo, no el mostrador.
 */
async function aplicarPreciosFinales(cita, precios, transaction) {
    const lineas = await Models.ReservaCitaServicio.findAll({
        where: { id_cita: cita.id_cita },
        include: [{ model: Models.ReservaServicio, as: 'servicio', attributes: ['a_cotizar', 'precio_min', 'precio_max'] }],
        transaction,
    });
    let delta = 0;
    for (const { id_servicio: idServicio, precio } of precios) {
        const linea = lineas.find((l) => Number(l.id_servicio) === Number(idServicio));
        if (!linea) continue;
        const s = linea.servicio;
        const editable = s && (s.a_cotizar || s.precio_min != null || s.precio_max != null);
        if (!editable) continue;
        const valor = Number(precio);
        if (!Number.isFinite(valor) || valor < 0) {
            throw errorValidacion('El precio a cobrar no es válido.', 'PRECIO_NO_VALIDO');
        }
        delta += valor - Number(linea.precio_snapshot || 0);
        await linea.update({ precio_snapshot: valor }, { transaction });
    }
    if (delta !== 0) {
        cita.monto_total = Math.max(0, Number(cita.monto_total || 0) + delta);
        await cita.save({ transaction });
    }
}

/**
 * Falla si la cita tiene un servicio que exige consentimiento y no hay uno registrado para ella
 * en la ficha. Se registra desde el detalle de la cita (foto del documento firmado o constancia
 * de que se firmó en papel).
 */
async function exigirConsentimiento(cita, transaction) {
    const lineas = await Models.ReservaCitaServicio.findAll({
        where: { id_cita: cita.id_cita },
        include: [{ model: Models.ReservaServicio, as: 'servicio', attributes: ['requiere_consentimiento', 'nombre'] }],
        transaction,
    });
    const exigen = lineas.filter((l) => l.servicio?.requiere_consentimiento);
    if (exigen.length === 0) return;
    const registrado = await Models.ReservaFicha.count({
        where: { id_cita: cita.id_cita, tipo: 'CONSENTIMIENTO', estado: 'A' },
        transaction,
    });
    if (registrado > 0) return;
    const e = new Error(
        `Falta el consentimiento informado de «${exigen[0].servicio.nombre}». `
        + 'Regístralo en el detalle de la cita antes de completarla.',
    );
    e.statusCode = 409;
    e.code = 'CONSENTIMIENTO_PENDIENTE';
    throw e;
}

module.exports = { completarYCobrar, normalizarPagos, centavos };
