'use strict';

const Models = require('../../app_core/models/conection');
const personaNegocioDao = require('../../app_core/dao/personaNegocioDao');
const { avisar, avisarTrasCommit, TEMAS } = require('./avisoService');

const sequelize = Models.sequelize;

/**
 * cuentaService — tiqueteras y fiado.
 *
 * ## Una cuenta, dos signos
 *
 * En Colombia el cliente de confianza o **paga adelantado** la comida del mes (la tiquetera) o
 * **come y paga al final** (el fiado). No son dos funciones: es el mismo saldo con el signo
 * cambiado. Saldo positivo = el restaurante le debe comida; negativo = él debe plata.
 *
 * ## Dos unidades, un solo libro
 *
 * `modo = DINERO` lleva el saldo en pesos. `modo = TIQUETES` lo lleva en unidades de un
 * producto («20 almuerzos»), que es lo que protege al cliente si sube el precio. Las dos viven
 * en la MISMA tabla de movimientos: cambia la columna en la que se apunta, no la contabilidad.
 * El saldo nunca se guarda, siempre se suma — así no puede desajustarse.
 *
 * ## Dónde está el peligro: que la plata se cuente dos veces
 *
 * Los informes sacan las ventas de `pedid_orden.total` y la caja saca el efectivo de
 * `rest_movimiento_caja`. La tiquetera rompe la equivalencia «pedido = venta = plata» porque el
 * dinero entra un día y la comida sale otro. El reparto, que es la decisión central del módulo:
 *
 *   Vender tiquetera / recibir abono → INGRESO en caja, SIN pedido       → entra plata, NO es venta
 *   Comer con la cuenta              → pedido normal + INGRESO solo por lo
 *                                      que NO paga la cuenta (cero si la
 *                                      paga toda)                         → ES venta, NO mueve el cajón
 *
 * Hasta el 2026-09-14 lo segundo era un INGRESO por el total más un EGRESO por la parte de la
 * cuenta, el mismo truco del domicilio. El arqueo cuadraba, pero el EGRESO salía en Caja
 * etiquetado como domicilio y, en un multipago, se repartía también contra el efectivo: el
 * desglose por forma de pago mostraba menos efectivo del que había en el cajón. Ahora el ingreso
 * nace ya sin la parte de la cuenta (`cajaService.registrarIngresoOrden`, `montoContraCuenta`).
 * Sigue existiendo aunque sea de cero: sin él, el pedido desaparecería del listado del turno.
 */

const MODO = Object.freeze({ DINERO: 'DINERO', TIQUETES: 'TIQUETES' });
const TIPO = Object.freeze({ ABONO: 'ABONO', CARGO: 'CARGO' });

function error(mensaje, code, statusCode = 409) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

// ============================================================
// Saldos — siempre calculados, nunca guardados
// ============================================================

/**
 * Saldo en pesos de una cuenta. Positivo = tiene a favor; negativo = debe.
 *
 * Los movimientos anulados **y sus reversas** se excluyen: dejarlos sumaría cero igualmente,
 * pero se recalcula excluyéndolos para que el saldo no dependa de que la reversa exista con el
 * importe exacto. Es el mismo criterio que usa el desglose de caja.
 */
const SQL_SALDO = `
    SELECT COALESCE(SUM(
        CASE WHEN m.tipo = 'ABONO' THEN m.monto ELSE -m.monto END
    ), 0)::numeric AS saldo
    FROM restaurante.rest_cuenta_movimiento m
    WHERE m.id_cuenta = :idCuenta
      AND m.id_movimiento_anula IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM restaurante.rest_cuenta_movimiento a
          WHERE a.id_movimiento_anula = m.id_movimiento
      )
`;

const SQL_TIQUETES = `
    SELECT m.id_producto,
           p.nombre AS producto,
           p.precio::numeric AS precio,
           COALESCE(SUM(
               CASE WHEN m.tipo = 'ABONO' THEN m.tiquetes ELSE -m.tiquetes END
           ), 0)::int AS disponibles
    FROM restaurante.rest_cuenta_movimiento m
    JOIN restaurante.carta_producto p ON p.id_producto = m.id_producto
    WHERE m.id_cuenta = :idCuenta
      AND m.tiquetes > 0
      AND m.id_movimiento_anula IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM restaurante.rest_cuenta_movimiento a
          WHERE a.id_movimiento_anula = m.id_movimiento
      )
    GROUP BY m.id_producto, p.nombre, p.precio
    HAVING COALESCE(SUM(
        CASE WHEN m.tipo = 'ABONO' THEN m.tiquetes ELSE -m.tiquetes END
    ), 0) <> 0
    ORDER BY p.nombre
`;

async function getSaldo(idCuenta, { transaction } = {}) {
    const [fila] = await sequelize.query(SQL_SALDO, {
        replacements: { idCuenta },
        type: sequelize.QueryTypes.SELECT,
        transaction,
    });
    return Number(fila?.saldo ?? 0);
}

async function getTiquetes(idCuenta, { transaction } = {}) {
    const filas = await sequelize.query(SQL_TIQUETES, {
        replacements: { idCuenta },
        type: sequelize.QueryTypes.SELECT,
        transaction,
    });
    return filas.map((f) => ({
        id_producto: Number(f.id_producto),
        producto: f.producto,
        precio: Number(f.precio),
        disponibles: Number(f.disponibles),
    }));
}

// ============================================================
// Consultas
// ============================================================

/**
 * La lista de cuentas del negocio con su saldo.
 *
 * El saldo se calcula en la misma consulta —no una por cliente— porque esta pantalla se abre
 * entera y un restaurante con cien clientes haría cien viajes a la base en un servidor de un
 * núcleo.
 */
async function listarCuentas({ idNegocio, busqueda = null, filtro = 'todos', limite = 100, offset = 0 }) {
    // Las eliminadas (`estado = 'E'`) no se listan: su libro sigue en la base, pero para el
    // negocio ya no existen — ni aquí ni en el selector de cliente del cobro, que usa esta lista.
    const condiciones = ['c.id_negocio = :idNegocio', `c.estado <> 'E'`];
    if (busqueda) condiciones.push(`(pn.nombre_mostrado ILIKE :busqueda OR pn.telefono_e164 ILIKE :busqueda)`);

    // `deben` y `a_favor` se filtran sobre el saldo ya calculado, así que van en el HAVING de
    // la subconsulta lateral, no aquí.
    const filtroSaldo = {
        deben: 'AND s.saldo < 0',
        a_favor: 'AND (s.saldo > 0 OR t.restantes > 0)',
        todos: '',
    }[filtro] ?? '';

    // Los tiquetes salen del libro con el mismo criterio que el saldo: los apuntes anulados y sus
    // reversas no cuentan. «Comprados» son todos los que entraron (ventas y ajustes a favor);
    // «restantes», los que le quedan por comer.
    const filas = await sequelize.query(
        `
        SELECT c.id_cuenta, c.modo, c.cupo::numeric AS cupo, c.estado, c.nota,
               c.id_persona_negocio,
               pn.nombre_mostrado AS cliente,
               pn.telefono_e164   AS telefono,
               s.saldo::numeric   AS saldo,
               COALESCE(t.restantes, 0)::int AS tiquetes_restantes,
               COALESCE(t.comprados, 0)::int AS tiquetes_comprados,
               t.productos,
               m.ultimo_movimiento
        FROM restaurante.rest_cuenta c
        JOIN platform.persona_negocio pn
          ON pn.id_persona_negocio = c.id_persona_negocio
         AND pn.id_negocio = c.id_negocio
        LEFT JOIN LATERAL (${SQL_SALDO.replace(':idCuenta', 'c.id_cuenta')}) s ON true
        LEFT JOIN LATERAL (
            SELECT SUM(CASE WHEN mm.tipo = 'ABONO' THEN mm.tiquetes ELSE -mm.tiquetes END) AS restantes,
                   SUM(CASE WHEN mm.tipo = 'ABONO' THEN mm.tiquetes ELSE 0 END)            AS comprados,
                   STRING_AGG(DISTINCT p.nombre, ', ')                                      AS productos
            FROM restaurante.rest_cuenta_movimiento mm
            JOIN restaurante.carta_producto p ON p.id_producto = mm.id_producto
            WHERE mm.id_cuenta = c.id_cuenta
              AND mm.tiquetes > 0
              AND mm.id_movimiento_anula IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM restaurante.rest_cuenta_movimiento a
                  WHERE a.id_movimiento_anula = mm.id_movimiento
              )
        ) t ON true
        LEFT JOIN LATERAL (
            SELECT MAX(mv.fecha) AS ultimo_movimiento
            FROM restaurante.rest_cuenta_movimiento mv
            WHERE mv.id_cuenta = c.id_cuenta
        ) m ON true
        WHERE ${condiciones.join(' AND ')}
        ${filtroSaldo}
        ORDER BY (s.saldo < 0) DESC, pn.nombre_mostrado NULLS LAST
        LIMIT :limite OFFSET :offset
        `,
        {
            replacements: {
                idNegocio,
                busqueda: busqueda ? `%${busqueda}%` : null,
                limite: Math.min(Number(limite) || 100, 500),
                offset: Number(offset) || 0,
            },
            type: sequelize.QueryTypes.SELECT,
        },
    );

    return filas.map((f) => ({
        id_cuenta: Number(f.id_cuenta),
        id_persona_negocio: f.id_persona_negocio,
        cliente: f.cliente || 'Sin nombre',
        telefono: f.telefono,
        modo: f.modo,
        cupo: Number(f.cupo),
        estado: f.estado,
        nota: f.nota,
        saldo: Number(f.saldo),
        tiquetes_comprados: Number(f.tiquetes_comprados),
        tiquetes_restantes: Number(f.tiquetes_restantes),
        // Se conserva con su nombre de siempre: son los que le quedan, y hay pantallas que lo leen.
        total_tiquetes: Number(f.tiquetes_restantes),
        productos: f.productos || null,
        ultimo_movimiento: f.ultimo_movimiento,
    }));
}

/** Una cuenta con su saldo y, si lleva tiquetes, el desglose por producto. */
async function getCuenta({ idNegocio, idCuenta, transaction = null }) {
    const [fila] = await sequelize.query(
        `
        SELECT c.id_cuenta, c.id_negocio, c.id_persona_negocio, c.modo, c.cupo::numeric AS cupo,
               c.estado, c.nota, c.fecha_creacion,
               pn.nombre_mostrado AS cliente, pn.telefono_e164 AS telefono
        FROM restaurante.rest_cuenta c
        JOIN platform.persona_negocio pn
          ON pn.id_persona_negocio = c.id_persona_negocio AND pn.id_negocio = c.id_negocio
        WHERE c.id_cuenta = :idCuenta AND c.id_negocio = :idNegocio AND c.estado <> 'E'
        `,
        { replacements: { idCuenta, idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
    );
    if (!fila) return null;

    const [saldo, tiquetes] = await Promise.all([
        getSaldo(idCuenta, { transaction }),
        fila.modo === MODO.TIQUETES ? getTiquetes(idCuenta, { transaction }) : Promise.resolve([]),
    ]);

    return {
        id_cuenta: Number(fila.id_cuenta),
        id_negocio: Number(fila.id_negocio),
        id_persona_negocio: fila.id_persona_negocio,
        cliente: fila.cliente || 'Sin nombre',
        telefono: fila.telefono,
        modo: fila.modo,
        cupo: Number(fila.cupo),
        estado: fila.estado,
        nota: fila.nota,
        fecha_creacion: fila.fecha_creacion,
        saldo,
        tiquetes,
        // Lo que puede gastar hoy: su saldo más lo que se le fía.
        disponible: fila.modo === MODO.DINERO ? saldo + Number(fila.cupo) : null,
    };
}

async function listarMovimientos({ idNegocio, idCuenta, limite = 100, offset = 0 }) {
    return sequelize.query(
        `
        SELECT m.id_movimiento, m.tipo, m.monto::numeric AS monto, m.tiquetes, m.concepto,
               m.fecha, m.id_orden, m.id_movimiento_anula,
               o.numero_orden,
               p.nombre AS producto,
               u.primer_nombre, u.primer_apellido,
               mp.nombre AS metodo_pago,
               -- Lo que el cliente pagó en caja por este apunte. En una tiquetera de tiquetes el
               -- libro cuenta unidades, así que el dinero solo se ve aquí.
               mc.monto::numeric AS valor_pagado,
               EXISTS (
                   SELECT 1 FROM restaurante.rest_cuenta_movimiento a
                   WHERE a.id_movimiento_anula = m.id_movimiento
               ) AS anulado
        FROM restaurante.rest_cuenta_movimiento m
        LEFT JOIN restaurante.pedid_orden o    ON o.id_orden = m.id_orden
        LEFT JOIN restaurante.carta_producto p ON p.id_producto = m.id_producto
        LEFT JOIN general.gener_usuario u      ON u.id_usuario = m.id_usuario
        LEFT JOIN restaurante.rest_movimiento_caja mc ON mc.id_movimiento = m.id_movimiento_caja
        LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = mc.id_metodo_pago
        WHERE m.id_cuenta = :idCuenta AND m.id_negocio = :idNegocio
        ORDER BY m.fecha DESC, m.id_movimiento DESC
        LIMIT :limite OFFSET :offset
        `,
        {
            replacements: {
                idCuenta,
                idNegocio,
                limite: Math.min(Number(limite) || 100, 500),
                offset: Number(offset) || 0,
            },
            type: sequelize.QueryTypes.SELECT,
        },
    );
}

// ============================================================
// Alta y edición
// ============================================================

/**
 * Crea la cuenta de un cliente.
 *
 * El teléfono es **opcional** a propósito: media clientela de tiquetera de un restaurante de
 * barrio no lo da, y exigirlo obligaría a inventar números. Cuando sí lo hay se resuelve por
 * `persona_negocio` para que sea la MISMA ficha que usa el asistente de WhatsApp; cuando no,
 * se crea una ficha solo con el nombre.
 */
async function crearCuenta({ idNegocio, nombre, telefono = null, modo = MODO.DINERO, cupo = 0, nota = null }) {
    const nombreLimpio = String(nombre || '').trim();
    if (!nombreLimpio) throw error('El nombre del cliente es obligatorio.', 'NOMBRE_REQUERIDO', 422);
    if (![MODO.DINERO, MODO.TIQUETES].includes(modo)) {
        throw error('El modo debe ser DINERO o TIQUETES.', 'MODO_INVALIDO', 422);
    }

    const t = await sequelize.transaction();
    try {
        let idPersonaNegocio = null;
        let idCuentaEliminada = null;

        if (telefono) {
            idPersonaNegocio = await personaNegocioDao.resolverOCrear(
                { idNegocio, telefono, nombre: nombreLimpio },
                { transaction: t },
            );
            if (!idPersonaNegocio) {
                throw error('El teléfono no es válido para el país del negocio.', 'TELEFONO_INVALIDO', 422);
            }

            const [yaTiene] = await sequelize.query(
                `SELECT id_cuenta, estado FROM restaurante.rest_cuenta
                  WHERE id_negocio = :idNegocio AND id_persona_negocio = :idPersonaNegocio`,
                { replacements: { idNegocio, idPersonaNegocio }, type: sequelize.QueryTypes.SELECT, transaction: t },
            );
            if (yaTiene && yaTiene.estado !== 'E') {
                throw error('Ese cliente ya tiene una cuenta.', 'CUENTA_DUPLICADA', 409);
            }
            // Tenía una cuenta y se eliminó. Hay UNA cuenta por cliente
            // (`uq_rest_cuenta_negocio_persona`) y su libro nunca se borra, así que se reactiva con
            // su historia: lo que tuviera a favor o debiendo sigue siendo suyo.
            if (yaTiene) idCuentaEliminada = Number(yaTiene.id_cuenta);
        } else {
            const [fila] = await sequelize.query(
                `INSERT INTO platform.persona_negocio (id_negocio, nombre_mostrado)
                 VALUES (:idNegocio, :nombre)
                 RETURNING id_persona_negocio`,
                { replacements: { idNegocio, nombre: nombreLimpio }, type: sequelize.QueryTypes.SELECT, transaction: t },
            );
            idPersonaNegocio = fila.id_persona_negocio;
        }

        let cuenta;
        if (idCuentaEliminada) {
            cuenta = await Models.RestCuenta.findByPk(idCuentaEliminada, { transaction: t });
            if (modo !== cuenta.modo) await exigirSaldosEnCero(idCuentaEliminada, { transaction: t });
            await cuenta.update({
                estado: 'A',
                modo,
                cupo: Number(cupo) || 0,
                nota: nota || null,
                fecha_actualizacion: new Date(),
            }, { transaction: t });
        } else {
            cuenta = await Models.RestCuenta.create({
                id_negocio: idNegocio,
                id_persona_negocio: idPersonaNegocio,
                modo,
                cupo: Number(cupo) || 0,
                nota: nota || null,
                estado: 'A',
            }, { transaction: t });
        }

        avisarTrasCommit(t, idNegocio, TEMAS.CLIENTES);
        await t.commit();
        return getCuenta({ idNegocio, idCuenta: cuenta.id_cuenta });
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Cambia los datos de la cuenta.
 *
 * El **modo solo se puede cambiar con los dos saldos en cero**. Cambiarlo con saldo vivo
 * dejaría plata o tiquetes varados en una unidad que la cuenta ya no usa: el cliente pagó algo
 * que no podría gastar, y no hay forma honesta de convertir 8 almuerzos en pesos sin decidir
 * por él a qué precio.
 */
async function actualizarCuenta({ idNegocio, idCuenta, modo, cupo, estado, nota }) {
    const cuenta = await Models.RestCuenta.findOne({ where: { id_cuenta: idCuenta, id_negocio: idNegocio } });
    if (!cuenta || cuenta.estado === 'E') return null;

    if (modo && modo !== cuenta.modo) await exigirSaldosEnCero(idCuenta);

    await cuenta.update({
        modo: modo ?? cuenta.modo,
        cupo: cupo != null ? Number(cupo) : cuenta.cupo,
        estado: estado ?? cuenta.estado,
        nota: nota !== undefined ? nota : cuenta.nota,
        fecha_actualizacion: new Date(),
    });

    avisar(idNegocio, TEMAS.CLIENTES);
    return getCuenta({ idNegocio, idCuenta });
}

// ============================================================
// Abonos — aquí SÍ entra plata
// ============================================================

/**
 * Vender una tiquetera o recibir el pago de una cuenta.
 *
 * **Esto NO crea un pedido.** Es la mitad del reparto que impide contar la plata dos veces: el
 * dinero entra al cajón hoy, pero la venta se registrará el día que el cliente coma. Si esto
 * creara un pedido, el informe del día mostraría una venta de comida que no existió.
 *
 * Exige caja abierta por el mismo motivo que cualquier cobro: es dinero físico que alguien
 * tiene que cuadrar al cerrar el turno.
 *
 * ## En tiquetes, el valor lo pone la carta (desde 2026-09-14)
 *
 * Una tiquetera se paga por adelantado: vale **precio del producto × cantidad**, menos el
 * descuento que el negocio quiera hacer por comprarla entera. Ese valor se calcula AQUÍ, con el
 * precio de la carta, y lo que mande el navegador como `monto` se ignora. Antes lo escribía el
 * cajero a mano, y un error de dedo dejaba 20 almuerzos vendidos por lo que valen dos sin que
 * nada lo advirtiera. El descuento sí es decisión del negocio, y por eso es lo único que se pide.
 *
 * En dinero no hay producto que valga nada: el monto es el que el cliente entrega.
 *
 * El concepto en caja es siempre «Tiquetera <cliente>»; la nota, si la hay, queda en el libro del
 * cliente y no ensucia el listado del turno.
 */
async function registrarAbono({
    idNegocio, idCuenta, idUsuario, idMetodoPago,
    monto = 0, tiquetes = 0, idProducto = null, descuento = 0, concepto = null,
}) {
    const cajaService = require('./cajaService');

    const t = await sequelize.transaction();
    try {
        const cuenta = await bloquearCuenta({ idNegocio, idCuenta, transaction: t });

        const unidades = Number(tiquetes) || 0;
        const rebaja = redondear(Number(descuento) || 0);
        const nota = concepto ? String(concepto).trim() : '';

        let dineroRecibido;
        let detalle;

        if (cuenta.modo === MODO.TIQUETES) {
            if (!Number.isInteger(unidades) || unidades <= 0) {
                throw error('Indica cuántos tiquetes se compran.', 'TIQUETES_REQUERIDOS', 422);
            }
            if (!idProducto) throw error('Indica de qué producto son los tiquetes.', 'PRODUCTO_REQUERIDO', 422);

            const producto = await Models.CartaProducto.findOne({
                where: { id_producto: idProducto, id_negocio: idNegocio },
                attributes: ['id_producto', 'nombre', 'precio'],
                transaction: t,
            });
            if (!producto) {
                throw error('Ese producto no está en la carta del negocio.', 'PRODUCTO_INVALIDO', 422);
            }

            const subtotal = redondear(Number(producto.precio) * unidades);
            // El descuento no puede comerse la tiquetera entera: un ingreso de cero pesos en caja
            // por 20 almuerzos es un regalo, y los regalos van por «Corregir saldo», que deja motivo.
            if (rebaja < 0 || rebaja >= subtotal) {
                throw error(
                    'El descuento debe ser menor que el valor de la tiquetera.',
                    'DESCUENTO_INVALIDO',
                    422,
                );
            }
            dineroRecibido = redondear(subtotal - rebaja);
            detalle = `${unidades} x ${producto.nombre} a ${pesos(producto.precio)}`
                + (rebaja > 0 ? ` — descuento ${pesos(rebaja)}` : '');
        } else {
            if (rebaja > 0) {
                throw error('El descuento solo aplica a tiqueteras por producto.', 'DESCUENTO_INVALIDO', 422);
            }
            dineroRecibido = redondear(Number(monto) || 0);
            if (dineroRecibido <= 0) throw error('El monto debe ser mayor a cero.', 'MONTO_INVALIDO', 422);
            detalle = `Abono de ${pesos(dineroRecibido)}`;
        }

        const caja = await cajaService.requireCajaAbierta(idNegocio, { transaction: t });

        const mp = await validarMetodoPagoCobrable({ idMetodoPago, idNegocio, transaction: t });

        const etiquetaCaja = `Tiquetera ${cuenta.nombre}`.slice(0, 255);
        const etiqueta = (nota ? `${detalle} — ${nota}` : detalle).slice(0, 255);

        const movCaja = await cajaService.registrarMovimiento({
            idCaja: caja.id_caja,
            tipo: 'INGRESO',
            monto: dineroRecibido,
            concepto: etiquetaCaja,
            idUsuario,
            idMetodoPago: mp.id_metodo_pago,
            transaction: t,
        });

        await Models.RestCuentaMovimiento.create({
            id_cuenta: idCuenta,
            id_negocio: idNegocio,
            tipo: TIPO.ABONO,
            // En modo tiquetes el libro cuenta TIQUETES, no pesos: el dinero ya quedó en caja.
            monto: cuenta.modo === MODO.TIQUETES ? 0 : dineroRecibido,
            tiquetes: cuenta.modo === MODO.TIQUETES ? unidades : 0,
            id_producto: cuenta.modo === MODO.TIQUETES ? idProducto : null,
            id_caja: caja.id_caja,
            id_movimiento_caja: movCaja.id_movimiento,
            id_usuario: idUsuario,
            concepto: etiqueta,
        }, { transaction: t });

        avisarTrasCommit(t, idNegocio, TEMAS.CLIENTES, TEMAS.CAJA);
        await t.commit();
        return getCuenta({ idNegocio, idCuenta });
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Corrige un saldo sin que se mueva plata: perdonar una deuda, regalar un almuerzo, arreglar
 * una equivocación.
 *
 * **No toca la caja**, y por eso es la operación más delicada del módulo: permite hacer
 * desaparecer una deuda sin que entre un peso. Va detrás del subnivel `clientes_ajustar`, que
 * el cajero no tiene.
 */
async function registrarAjuste({ idNegocio, idCuenta, idUsuario, tipo, monto = 0, tiquetes = 0, idProducto = null, concepto }) {
    if (![TIPO.ABONO, TIPO.CARGO].includes(tipo)) {
        throw error('El ajuste debe ser ABONO o CARGO.', 'TIPO_INVALIDO', 422);
    }
    if (!concepto || !String(concepto).trim()) {
        // Un ajuste sin explicación es un agujero en la contabilidad del cliente.
        throw error('Un ajuste necesita un motivo escrito.', 'CONCEPTO_REQUERIDO', 422);
    }

    const t = await sequelize.transaction();
    try {
        const cuenta = await bloquearCuenta({ idNegocio, idCuenta, transaction: t });

        const importe = Number(monto) || 0;
        const unidades = Number(tiquetes) || 0;
        if (cuenta.modo === MODO.TIQUETES) {
            if (unidades <= 0 || !idProducto) {
                throw error('Indica cuántos tiquetes y de qué producto.', 'TIQUETES_REQUERIDOS', 422);
            }
        } else if (importe <= 0) {
            throw error('El monto debe ser mayor a cero.', 'MONTO_INVALIDO', 422);
        }

        await Models.RestCuentaMovimiento.create({
            id_cuenta: idCuenta,
            id_negocio: idNegocio,
            tipo,
            monto: cuenta.modo === MODO.TIQUETES ? 0 : importe,
            tiquetes: cuenta.modo === MODO.TIQUETES ? unidades : 0,
            id_producto: cuenta.modo === MODO.TIQUETES ? idProducto : null,
            id_usuario: idUsuario,
            concepto: `Ajuste: ${String(concepto).trim()}`,
        }, { transaction: t });

        avisarTrasCommit(t, idNegocio, TEMAS.CLIENTES);
        await t.commit();
        return getCuenta({ idNegocio, idCuenta });
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

// ============================================================
// Consumo — el cliente come contra su cuenta
// ============================================================

/**
 * ¿Cuánto de este pedido puede pagar la cuenta?
 *
 * Se calcula SIEMPRE en el servidor, tanto para pintarlo en el POS como al cobrar de verdad.
 * Lo que mande el navegador es una propuesta, nunca la última palabra: si se confiara en ella,
 * bastaría un `curl` para fiarle a alguien por encima de su cupo.
 *
 * @returns {{monto_cubierto:number, tiquetes:Array, faltante:number}}
 */
async function calcularCobertura({ idNegocio, idCuenta, idOrden = null, total = null, transaction = null }) {
    const cuenta = await getCuenta({ idNegocio, idCuenta, transaction });
    if (!cuenta) throw error('La cuenta no existe.', 'CUENTA_NO_EXISTE', 404);
    if (cuenta.estado !== 'A') throw error('La cuenta está inactiva.', 'CUENTA_INACTIVA', 409);

    let totalPedido = total != null ? Number(total) : 0;
    let detalles = [];

    if (idOrden) {
        const filas = await sequelize.query(
            `SELECT d.id_producto, d.cantidad, d.precio_unitario::numeric AS precio_unitario,
                    p.nombre AS producto, o.total::numeric AS total
               FROM restaurante.pedid_detalle d
               JOIN restaurante.pedid_orden o ON o.id_orden = d.id_orden
               LEFT JOIN restaurante.carta_producto p ON p.id_producto = d.id_producto
              WHERE d.id_orden = :idOrden AND o.id_negocio = :idNegocio`,
            { replacements: { idOrden, idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
        );
        detalles = filas;
        if (filas.length) totalPedido = Number(filas[0].total);
    }

    if (cuenta.modo === MODO.DINERO) {
        const cubierto = Math.max(0, Math.min(totalPedido, cuenta.disponible));
        return {
            modo: cuenta.modo,
            monto_cubierto: cubierto,
            tiquetes: [],
            faltante: Math.max(0, totalPedido - cubierto),
            saldo: cuenta.saldo,
            disponible: cuenta.disponible,
        };
    }

    // Modo tiquetes: cada tiquete cubre UNA unidad del producto para el que se compró. Lo que
    // el cliente pida de más (una gaseosa, un postre) no lo cubre la tiquetera y se paga aparte
    // — que es exactamente cómo funciona una tiquetera de papel.
    const disponiblesPorProducto = new Map(cuenta.tiquetes.map((t) => [t.id_producto, t.disponibles]));
    const consumo = [];
    let cubierto = 0;

    for (const d of detalles) {
        const disponibles = disponiblesPorProducto.get(Number(d.id_producto)) || 0;
        if (disponibles <= 0) continue;

        const usar = Math.min(disponibles, Number(d.cantidad));
        if (usar <= 0) continue;

        disponiblesPorProducto.set(Number(d.id_producto), disponibles - usar);
        const valor = usar * Number(d.precio_unitario);
        cubierto += valor;
        consumo.push({
            id_producto: Number(d.id_producto),
            producto: d.producto,
            cantidad: usar,
            valor,
        });
    }

    // Nunca puede cubrir más que el total: si el pedido lleva un descuento, el valor de los
    // tiquetes podría pasarse y estaríamos regalando plata contra la caja.
    if (cubierto > totalPedido) cubierto = totalPedido;

    return {
        modo: cuenta.modo,
        monto_cubierto: cubierto,
        tiquetes: consumo,
        faltante: Math.max(0, totalPedido - cubierto),
        saldo: cuenta.saldo,
        disponible: null,
    };
}

/**
 * Aplica el consumo de un pedido contra la cuenta. Se llama DENTRO de la transacción del cobro.
 *
 * Solo anota el CARGO en el libro del cliente (pesos o tiquetes). **No toca la caja**: el cobro
 * ya registró su INGRESO sin la parte que paga la cuenta (`registrarIngresoOrden` con
 * `montoContraCuenta`), así que no hay nada que compensar. Hasta el 2026-09-14 aquí se escribía un
 * EGRESO por este importe, que la pantalla de Caja pintaba como un pago de domicilio.
 *
 * @param {number} monto — cuánto del pedido se carga a la cuenta (puede ser parte del total,
 *                         si el resto se pagó con otra forma de pago).
 */
async function aplicarConsumo({
    idNegocio, idCuenta, idOrden, numeroOrden, monto, idUsuario, transaction,
}) {
    const cuenta = await bloquearCuenta({ idNegocio, idCuenta, transaction });
    const importe = Number(monto) || 0;
    if (importe <= 0) throw error('El importe a cargar debe ser mayor a cero.', 'MONTO_INVALIDO', 422);

    const cobertura = await calcularCobertura({ idNegocio, idCuenta, idOrden, transaction });
    if (importe > cobertura.monto_cubierto + 0.009) {
        throw error(
            cuenta.modo === MODO.TIQUETES
                ? 'La tiquetera no alcanza para este pedido.'
                : `La cuenta solo cubre ${cobertura.monto_cubierto}. Cobra la diferencia de otra forma.`,
            'CUENTA_SIN_SALDO',
            409,
        );
    }

    const etiqueta = `Consumo de ${cuenta.cliente} — orden ${numeroOrden}`;

    if (cuenta.modo === MODO.TIQUETES) {
        // Un apunte por producto: así el cliente puede ver «te gasté 1 almuerzo», que es lo que
        // él lleva en la cabeza, y no un importe que tendría que traducir.
        for (const linea of cobertura.tiquetes) {
            await Models.RestCuentaMovimiento.create({
                id_cuenta: idCuenta,
                id_negocio: idNegocio,
                tipo: TIPO.CARGO,
                monto: 0,
                tiquetes: linea.cantidad,
                id_producto: linea.id_producto,
                id_orden: idOrden,
                id_usuario: idUsuario,
                concepto: `${linea.cantidad} x ${linea.producto} — orden ${numeroOrden}`,
            }, { transaction });
        }
    } else {
        await Models.RestCuentaMovimiento.create({
            id_cuenta: idCuenta,
            id_negocio: idNegocio,
            tipo: TIPO.CARGO,
            monto: importe,
            tiquetes: 0,
            id_orden: idOrden,
            id_usuario: idUsuario,
            concepto: etiqueta,
        }, { transaction });
    }

    avisarTrasCommit(transaction, idNegocio, TEMAS.CLIENTES);
    return { id_cuenta: idCuenta, monto: importe, modo: cuenta.modo };
}

/**
 * Deshace los cargos que un pedido dejó en cuentas de cliente.
 *
 * Se llama al anular un pedido ya cobrado. No borra: escribe la reversa, igual que caja, para
 * que el cliente pueda ver qué pasó con su tiquetera si algún día lo pregunta.
 */
async function revertirConsumoDeOrden({ idNegocio, idOrden, idUsuario, transaction }) {
    const cargos = await sequelize.query(
        `SELECT * FROM restaurante.rest_cuenta_movimiento
          WHERE id_orden = :idOrden AND id_negocio = :idNegocio AND tipo = 'CARGO'
            AND NOT EXISTS (
                SELECT 1 FROM restaurante.rest_cuenta_movimiento a
                WHERE a.id_movimiento_anula = restaurante.rest_cuenta_movimiento.id_movimiento
            )`,
        { replacements: { idOrden, idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
    );

    for (const cargo of cargos) {
        await Models.RestCuentaMovimiento.create({
            id_cuenta: cargo.id_cuenta,
            id_negocio: idNegocio,
            tipo: TIPO.ABONO,
            monto: cargo.monto,
            tiquetes: cargo.tiquetes,
            id_producto: cargo.id_producto,
            id_orden: idOrden,
            id_usuario: idUsuario,
            concepto: `Devolución: ${cargo.concepto || 'consumo anulado'}`,
            id_movimiento_anula: cargo.id_movimiento,
        }, { transaction });
    }

    if (cargos.length) avisarTrasCommit(transaction, idNegocio, TEMAS.CLIENTES);
    return cargos.length;
}

// ============================================================
// Eliminar
// ============================================================

/**
 * Elimina la cuenta de un cliente. Detrás del subnivel `clientes_eliminar`, que nace denegado
 * para todos —administrador incluido— y se concede en Usuarios → Roles y permisos.
 *
 * **No borra nada: marca `estado = 'E'`.** El libro cuelga de pedidos (`id_orden`) y de movimientos
 * de caja (`id_movimiento_caja`) con `ON DELETE RESTRICT`, y aunque no colgara, borrarlo haría
 * imposible explicarle a un cliente qué pasó con su tiquetera. La cuenta deja de salir en la
 * pantalla y en el cobro, y si el cliente vuelve con el mismo teléfono se reactiva con su historia.
 *
 * **Tampoco devuelve plata.** Lo que el cliente pagó entró a una caja y quizá a un turno ya
 * cerrado; si hay que devolverlo, es un egreso de caja con su propio responsable. Por eso se
 * devuelve lo que le quedaba, para que la pantalla lo confirme antes y la auditoría lo guarde.
 */
async function eliminarCuenta({ idNegocio, idCuenta }) {
    const t = await sequelize.transaction();
    try {
        const [fila] = await sequelize.query(
            `SELECT c.id_cuenta, c.modo, pn.nombre_mostrado AS cliente
               FROM restaurante.rest_cuenta c
               JOIN platform.persona_negocio pn
                 ON pn.id_persona_negocio = c.id_persona_negocio AND pn.id_negocio = c.id_negocio
              WHERE c.id_cuenta = :idCuenta AND c.id_negocio = :idNegocio AND c.estado <> 'E'
              FOR UPDATE OF c`,
            { replacements: { idCuenta, idNegocio }, type: sequelize.QueryTypes.SELECT, transaction: t },
        );
        if (!fila) throw error('La cuenta no existe.', 'CUENTA_NO_EXISTE', 404);

        const [saldo, tiquetes] = await Promise.all([
            getSaldo(idCuenta, { transaction: t }),
            getTiquetes(idCuenta, { transaction: t }),
        ]);

        await sequelize.query(
            `UPDATE restaurante.rest_cuenta
                SET estado = 'E', fecha_actualizacion = CURRENT_TIMESTAMP
              WHERE id_cuenta = :idCuenta AND id_negocio = :idNegocio`,
            { replacements: { idCuenta, idNegocio }, transaction: t },
        );

        avisarTrasCommit(t, idNegocio, TEMAS.CLIENTES);
        await t.commit();
        return {
            id_cuenta: Number(fila.id_cuenta),
            cliente: fila.cliente || 'Sin nombre',
            modo: fila.modo,
            saldo,
            tiquetes_restantes: tiquetes.reduce((suma, x) => suma + x.disponibles, 0),
        };
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

// ============================================================
// Internos
// ============================================================

const redondear = (valor) => Math.round(Number(valor) * 100) / 100;

const pesos = (valor) => `$${Number(valor).toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;

/**
 * Cambiar el modo con saldo vivo dejaría plata o tiquetes varados en una unidad que la cuenta ya
 * no usa: el cliente pagó algo que no podría gastar.
 */
async function exigirSaldosEnCero(idCuenta, { transaction } = {}) {
    const [saldo, tiquetes] = await Promise.all([
        getSaldo(idCuenta, { transaction }),
        getTiquetes(idCuenta, { transaction }),
    ]);
    if (saldo !== 0 || tiquetes.some((x) => x.disponibles !== 0)) {
        throw error(
            'Para cambiar el tipo de cuenta, el saldo y los tiquetes deben estar en cero.',
            'CUENTA_CON_SALDO',
            409,
        );
    }
}

/**
 * Lee la cuenta bloqueando su fila.
 *
 * El `FOR UPDATE` no es decorativo: dos cajeros cobrando a la vez contra la misma tiquetera
 * leerían el mismo saldo y los dos lo darían por suficiente. Con el bloqueo, el segundo espera
 * y vuelve a calcular sobre el saldo ya descontado.
 */
async function bloquearCuenta({ idNegocio, idCuenta, transaction }) {
    const [fila] = await sequelize.query(
        `SELECT c.id_cuenta, c.modo, c.cupo::numeric AS cupo, c.estado,
                pn.nombre_mostrado AS cliente
           FROM restaurante.rest_cuenta c
           JOIN platform.persona_negocio pn
             ON pn.id_persona_negocio = c.id_persona_negocio AND pn.id_negocio = c.id_negocio
          WHERE c.id_cuenta = :idCuenta AND c.id_negocio = :idNegocio AND c.estado <> 'E'
          FOR UPDATE OF c`,
        { replacements: { idCuenta, idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
    );

    if (!fila) throw error('La cuenta no existe.', 'CUENTA_NO_EXISTE', 404);
    if (fila.estado !== 'A') throw error('La cuenta está inactiva.', 'CUENTA_INACTIVA', 409);

    return {
        ...fila,
        cliente: fila.cliente || 'el cliente',
        // Para etiquetas que empiezan por el nombre («Tiquetera Juan»): ahí «el cliente» no sirve.
        nombre: fila.cliente || 'Sin nombre',
        cupo: Number(fila.cupo),
    };
}

/** Una forma de pago del negocio que sirva para RECIBIR dinero (no la de la propia cuenta). */
async function validarMetodoPagoCobrable({ idMetodoPago, idNegocio, transaction }) {
    if (!idMetodoPago) throw error('La forma de pago es obligatoria.', 'METODO_PAGO_REQUERIDO', 422);

    const mp = await Models.RestMetodoPago.findOne({
        where: { id_metodo_pago: idMetodoPago, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!mp) throw error('Método de pago inválido para este negocio.', 'METODO_PAGO_INVALIDO', 422);
    if (mp.es_cuenta) {
        // Abonar a una cuenta pagando "con la cuenta" sería crear plata de la nada.
        throw error('Un abono no se puede pagar con la propia cuenta.', 'METODO_PAGO_INVALIDO', 422);
    }
    return mp;
}

/** La forma de pago marcada como cuenta para este negocio, si existe. */
async function getMetodoPagoCuenta(idNegocio, { transaction } = {}) {
    return Models.RestMetodoPago.findOne({
        where: { id_negocio: idNegocio, es_cuenta: true, estado: 'A' },
        transaction,
    });
}

module.exports = {
    MODO,
    TIPO,
    listarCuentas,
    getCuenta,
    listarMovimientos,
    crearCuenta,
    actualizarCuenta,
    registrarAbono,
    registrarAjuste,
    calcularCobertura,
    aplicarConsumo,
    revertirConsumoDeOrden,
    eliminarCuenta,
    getMetodoPagoCuenta,
    getSaldo,
    getTiquetes,
};
