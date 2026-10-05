'use strict';
/**
 * compraService — compras a proveedores y su entrada al inventario.
 *
 * ## Qué es una compra aquí y qué no es
 *
 * Es la **factura de la mercancía que entró**: el dueño le pagó al distribuidor de pollo y
 * llegaron 20 kilos. No es un movimiento de caja y no pretende serlo: `rest_movimiento_caja`
 * lleva el turno del cajero y lo que se le vende al cliente, y meter ahí lo que el dueño paga
 * a sus proveedores descuadraría todos los arqueos. Se cruzan solo en el informe de gasto,
 * que es donde esa pregunta se hace.
 *
 * ## La parte que de verdad importa: el stock
 *
 * Un renglón ligado a un `carta_ingrediente` **suma stock**. Es la entrada de mercancía que
 * al inventario del restaurante le faltaba: hasta ahora el stock solo bajaba (al vender) y
 * subía a mano, con el ajuste rápido.
 *
 * Lo que se suma se guarda renglón a renglón en `stock_sumado` en vez de recalcularse al
 * anular. La diferencia importa: entre registrar y anular puede haberse editado el insumo,
 * cambiado su unidad o borrado el vínculo con el ingrediente, y un recálculo devolvería al
 * inventario una cantidad distinta de la que le entró. Guardado, la reversa es exacta.
 *
 * ## Conversión de unidades
 *
 * La compra viene en la unidad del PROVEEDOR (una caja de 12, un bulto de 50 kg) y el
 * inventario lleva la suya (`carta_ingrediente.unidad_medida`). `convertir()` traduce lo que
 * sabe traducir —peso con peso, volumen con volumen— y **no inventa el resto**: si no puede,
 * suma 0 y lo dice en la respuesta. Un número inventado en el stock es peor que no tenerlo.
 */
const { QueryTypes } = require('sequelize');
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const { fijarActor } = require('../../app_core/helpers/auditActor');
const Prov = require('./proveedorService');

const { domainError, negocioDe, exigir, hoyBogota } = Prov;

/**
 * Factores a una unidad canónica por familia. Caja, bulto y paquete no están: son recipientes,
 * no medidas, y lo que llevan dentro lo dice `cantidad_presentacion` del insumo.
 */
const FACTORES = {
    KG: { familia: 'peso', aCanonica: 1000 },      // canónica: gramo
    G: { familia: 'peso', aCanonica: 1 },
    L: { familia: 'volumen', aCanonica: 1000 },    // canónica: mililitro
    ML: { familia: 'volumen', aCanonica: 1 },
    UN: { familia: 'conteo', aCanonica: 1 },
};

/** Lo que el inventario usa hoy en `carta_ingrediente.unidad_medida` (texto libre, minúsculas). */
function unidadInventario(raw) {
    const u = String(raw || 'g').trim().toLowerCase();
    if (['kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos'].includes(u)) return 'KG';
    if (['g', 'gr', 'gramo', 'gramos'].includes(u)) return 'G';
    if (['l', 'lt', 'litro', 'litros'].includes(u)) return 'L';
    if (['ml', 'mililitro', 'mililitros'].includes(u)) return 'ML';
    if (['un', 'und', 'unidad', 'unidades', 'u'].includes(u)) return 'UN';
    return null;
}

/**
 * Convierte `cantidad` de `desde` a `hacia`. Devuelve `null` cuando no se puede — y ese `null`
 * es una respuesta, no un fallo: el renglón se registra igual como gasto y la pantalla avisa
 * de que ese no entró al inventario.
 */
function convertir(cantidad, desde, hacia) {
    const a = FACTORES[desde];
    const b = FACTORES[hacia];
    if (!a || !b || a.familia !== b.familia) return null;
    return (Number(cantidad) * a.aCanonica) / b.aCanonica;
}

const numero = (v, porDefecto = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : porDefecto;
};

const texto = (v, max) => {
    if (v === undefined || v === null) return null;
    const limpio = String(v).trim().replace(/\s+/g, ' ');
    if (!limpio) return null;
    return max ? limpio.slice(0, max) : limpio;
};

// ============================================================
// Registro de una compra
// ============================================================

/**
 * Registra una compra entera en una sola transacción: cabecera, renglones, entrada de stock y
 * precios al histórico. O queda todo o no queda nada — una compra a medias dejaría stock
 * sumado sin factura que lo explique.
 */
async function crear(idUsuario, payload = {}) {
    const idNegocio = await negocioDe(idUsuario, payload.id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_compras', 'No tienes permiso para registrar compras.');

    const renglones = Array.isArray(payload.detalles) ? payload.detalles : [];
    if (!renglones.length) {
        throw domainError('La compra necesita al menos un producto.', 'COMPRA_SIN_DETALLE', 400);
    }
    if (renglones.length > 100) {
        throw domainError('Demasiados renglones en una sola compra.', 'COMPRA_MUY_LARGA', 400);
    }

    const afectaInventario = payload.afecta_inventario !== false;

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });

        const prov = await Models.RestProveedor.findOne({
            where: { id_proveedor: Number(payload.id_proveedor), estado: 'A' },
            transaction: t,
        });
        if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

        // Solo se le compra a un proveedor que esté en MI lista. Registrar una compra a uno
        // del directorio que nunca agregué es casi siempre un clic en la fila equivocada.
        const vinculo = await Models.RestProveedorNegocio.findOne({
            where: { id_proveedor: prov.id_proveedor, id_negocio: idNegocio },
            transaction: t,
        });
        if (!vinculo) {
            throw domainError('Agrega el proveedor a tu lista antes de registrarle una compra.',
                'SIN_VINCULO', 409);
        }

        if (payload.id_metodo_pago != null) {
            const mp = await Models.RestMetodoPago.findOne({
                where: { id_metodo_pago: Number(payload.id_metodo_pago), id_negocio: idNegocio },
                transaction: t,
            });
            if (!mp) throw domainError('Forma de pago no válida.', 'METODO_PAGO_INVALIDO', 400);
        }

        const compra = await Models.RestCompra.create({
            id_negocio: idNegocio,
            id_proveedor: prov.id_proveedor,
            fecha: texto(payload.fecha, 10) || hoyBogota(),
            referencia: texto(payload.referencia, 60),
            subtotal: 0,
            descuento: Math.max(0, numero(payload.descuento, 0)),
            impuesto: Math.max(0, numero(payload.impuesto, 0)),
            total: 0,
            id_metodo_pago: payload.id_metodo_pago == null ? null : Number(payload.id_metodo_pago),
            observaciones: texto(payload.observaciones, 2000),
            adjunto_url: texto(payload.adjunto_url, 255),
            afecta_inventario: afectaInventario,
            id_usuario: idUsuario,
        }, { transaction: t });

        let subtotal = 0;
        const avisos = [];

        for (const [i, r] of renglones.entries()) {
            const cantidad = numero(r.cantidad, 0);
            if (!(cantidad > 0)) {
                throw domainError(`El renglón ${i + 1} necesita una cantidad mayor que cero.`,
                    'CANTIDAD_INVALIDA', 400);
            }

            const precioUnitario = Math.max(0, numero(r.precio_unitario, 0));
            const descuentoLinea = Math.max(0, numero(r.descuento, 0));
            const totalLinea = Math.max(0, cantidad * precioUnitario - descuentoLinea);
            subtotal += totalLinea;

            // El insumo, si se eligió uno, tiene que ser de ESTE negocio y de ESTE proveedor.
            let insumo = null;
            if (r.id_proveedor_insumo != null) {
                insumo = await Models.RestProveedorInsumo.findOne({
                    where: {
                        id_proveedor_insumo: Number(r.id_proveedor_insumo),
                        id_negocio: idNegocio,
                        id_proveedor: prov.id_proveedor,
                        estado: 'A',
                    },
                    transaction: t,
                    lock: t.LOCK.UPDATE,
                });
                if (!insumo) {
                    throw domainError(`El insumo del renglón ${i + 1} no existe para este proveedor.`,
                        'INSUMO_NO_ENCONTRADO', 404);
                }
            }

            const unidadRenglon = String(r.unidad || insumo?.unidad || 'UN').toUpperCase();
            const descripcion = texto(r.descripcion, 160) || insumo?.nombre || 'Sin descripción';

            // ── Entrada al inventario ──
            const idIngrediente = r.id_ingrediente != null
                ? Number(r.id_ingrediente)
                : (insumo?.id_ingrediente ?? null);

            let stockSumado = 0;
            if (afectaInventario && idIngrediente) {
                const ing = await Models.CartaIngrediente.findOne({
                    where: { id_ingrediente: idIngrediente, id_negocio: idNegocio, estado: 'A' },
                    transaction: t,
                    lock: t.LOCK.UPDATE,
                });
                if (!ing) {
                    throw domainError(`El insumo de inventario del renglón ${i + 1} no existe.`,
                        'INGREDIENTE_NO_ENCONTRADO', 404);
                }

                // Lo que entra no es la cantidad: es la cantidad POR lo que trae cada
                // presentación. 3 cajas de 12 son 36 unidades, no 3.
                const contenido = insumo?.cantidad_presentacion == null
                    ? 1
                    : Number(insumo.cantidad_presentacion);
                const enUnidadProveedor = cantidad * (contenido > 0 ? contenido : 1);

                const destino = unidadInventario(ing.unidad_medida);
                const convertido = destino ? convertir(enUnidadProveedor, unidadRenglon, destino) : null;

                if (convertido == null) {
                    avisos.push({
                        renglon: i + 1,
                        descripcion,
                        motivo: 'UNIDAD_NO_CONVERTIBLE',
                        detalle: `No se pudo pasar ${unidadRenglon} a ${ing.unidad_medida}: el stock no cambió.`,
                    });
                } else {
                    stockSumado = convertido;
                    await ing.update(
                        { stock_actual: Number(ing.stock_actual ?? 0) + convertido },
                        { transaction: t },
                    );
                }
            }

            await Models.RestCompraDetalle.create({
                id_compra: compra.id_compra,
                id_proveedor_insumo: insumo?.id_proveedor_insumo ?? null,
                id_ingrediente: stockSumado > 0 ? idIngrediente : (idIngrediente ?? null),
                descripcion,
                cantidad,
                unidad: unidadRenglon,
                precio_unitario: precioUnitario,
                descuento: descuentoLinea,
                total: totalLinea,
                stock_sumado: stockSumado,
            }, { transaction: t });

            // ── El precio de la factura manda sobre el que había guardado ──
            //
            // Un precio salido de una factura vale más que uno escrito de memoria, así que
            // actualiza la ficha del insumo y entra al histórico marcado como COMPRA.
            if (insumo && precioUnitario > 0 && Number(insumo.precio ?? -1) !== precioUnitario) {
                await insumo.update({
                    precio: precioUnitario,
                    fecha_precio: compra.fecha,
                    fecha_actualizacion: new Date(),
                }, { transaction: t });
                await Prov.registrarPrecio(insumo, {
                    idNegocio,
                    idUsuario,
                    precio: precioUnitario,
                    origen: 'COMPRA',
                    idCompra: compra.id_compra,
                    transaction: t,
                });
            }
        }

        const descuento = Math.max(0, numero(payload.descuento, 0));
        const impuesto = Math.max(0, numero(payload.impuesto, 0));
        const total = Math.max(0, subtotal - descuento + impuesto);

        await compra.update({ subtotal, total }, { transaction: t });

        await Audit.registrarEvento({
            modulo: 'proveedores',
            accion: 'compra_registrada',
            idUsuario,
            idNegocio,
            detalle: {
                id_compra: compra.id_compra,
                id_proveedor: prov.id_proveedor,
                proveedor: prov.nombre_comercial,
                total,
                renglones: renglones.length,
                afecta_inventario: afectaInventario,
                avisos: avisos.length,
            },
            transaction: t,
        });

        const detalleCompra = await detalleEnTransaccion(compra.id_compra, idNegocio, t);
        return { ...detalleCompra, avisos };
    });
}

/**
 * Anula una compra. No la borra: `estado = 'N'`, y se devuelve al inventario exactamente lo
 * que cada renglón sumó (`stock_sumado`), ni más ni menos.
 *
 * El stock no baja de 0: si entre medias se consumió lo comprado, la reversa deja el insumo en
 * cero en vez de en negativo, que es lo que el resto del módulo de inventario ya hace.
 */
async function anular(idUsuario, idCompra, { id_negocio, motivo }) {
    const idNegocio = await negocioDe(idUsuario, id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_compras', 'No tienes permiso para anular compras.');

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });

        const compra = await Models.RestCompra.findOne({
            where: { id_compra: idCompra, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!compra) throw domainError('Compra no encontrada.', 'COMPRA_NO_ENCONTRADA', 404);
        if (compra.estado === 'N') {
            throw domainError('Esta compra ya estaba anulada.', 'COMPRA_YA_ANULADA', 409);
        }

        const detalles = await Models.RestCompraDetalle.findAll({
            where: { id_compra: idCompra }, transaction: t,
        });

        for (const d of detalles) {
            const sumado = Number(d.stock_sumado ?? 0);
            if (!(sumado > 0) || !d.id_ingrediente) continue;

            const ing = await Models.CartaIngrediente.findOne({
                where: { id_ingrediente: d.id_ingrediente, id_negocio: idNegocio },
                transaction: t,
                lock: t.LOCK.UPDATE,
            });
            if (!ing) continue;

            const nuevo = Math.max(0, Number(ing.stock_actual ?? 0) - sumado);
            await ing.update({ stock_actual: nuevo }, { transaction: t });
        }

        await compra.update({
            estado: 'N',
            motivo_anulacion: texto(motivo, 200),
            fecha_anulacion: new Date(),
        }, { transaction: t });

        await Audit.registrarEvento({
            modulo: 'proveedores',
            accion: 'compra_anulada',
            idUsuario,
            idNegocio,
            detalle: { id_compra: idCompra, total: Number(compra.total), motivo: texto(motivo, 200) },
            transaction: t,
        });

        return { id_compra: idCompra, estado: 'N' };
    });
}

// ============================================================
// Historial
// ============================================================

async function listar(idUsuario, {
    idNegocio: idNegocioPedido,
    idProveedor = null,
    idIngrediente = null,
    busqueda = null,
    desde = null,
    hasta = null,
    incluirAnuladas = false,
    limite = 50,
    offset = 0,
} = {}) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_precios',
        'No tienes permiso para consultar el historial de compras.');

    const condiciones = ['c.id_negocio = :idNegocio'];
    const repl = { idNegocio, limite: Math.min(Number(limite) || 50, 200), offset: Number(offset) || 0 };

    if (!incluirAnuladas) condiciones.push("c.estado = 'A'");
    if (idProveedor) {
        condiciones.push('c.id_proveedor = :idProveedor');
        repl.idProveedor = Number(idProveedor);
    }
    if (desde) {
        condiciones.push('c.fecha >= :desde');
        repl.desde = desde;
    }
    if (hasta) {
        condiciones.push('c.fecha <= :hasta');
        repl.hasta = hasta;
    }
    if (idIngrediente) {
        condiciones.push(`EXISTS (
            SELECT 1 FROM restaurante.rest_compra_detalle d
             WHERE d.id_compra = c.id_compra AND d.id_ingrediente = :idIngrediente
        )`);
        repl.idIngrediente = Number(idIngrediente);
    }
    const q = texto(busqueda, 120);
    if (q) {
        condiciones.push(`(
            c.referencia ILIKE :q
            OR p.nombre_comercial ILIKE :q
            OR EXISTS (
                SELECT 1 FROM restaurante.rest_compra_detalle d
                 WHERE d.id_compra = c.id_compra AND d.descripcion ILIKE :q
            )
        )`);
        repl.q = `%${q}%`;
    }

    const filas = await Models.sequelize.query(`
        SELECT c.id_compra, c.fecha, c.referencia, c.subtotal, c.descuento, c.impuesto, c.total,
               c.estado, c.observaciones, c.adjunto_url, c.afecta_inventario, c.motivo_anulacion,
               c.id_proveedor, p.nombre_comercial AS proveedor,
               mp.nombre AS metodo_pago,
               u.primer_nombre, u.primer_apellido,
               (SELECT COUNT(*) FROM restaurante.rest_compra_detalle d
                 WHERE d.id_compra = c.id_compra)::int AS renglones,
               COUNT(*) OVER()::int AS total_filas
          FROM restaurante.rest_compra c
          JOIN restaurante.rest_proveedor p ON p.id_proveedor = c.id_proveedor
          LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = c.id_metodo_pago
          LEFT JOIN general.gener_usuario u ON u.id_usuario = c.id_usuario
         WHERE ${condiciones.join(' AND ')}
         ORDER BY c.fecha DESC, c.id_compra DESC
         LIMIT :limite OFFSET :offset;
    `, { replacements: repl, type: QueryTypes.SELECT });

    return {
        items: filas.map(aPlanoCompra),
        total: filas.length ? Number(filas[0].total_filas) : 0,
        limite: repl.limite,
        offset: repl.offset,
    };
}

function aPlanoCompra(f) {
    return {
        id_compra: f.id_compra,
        fecha: f.fecha,
        referencia: f.referencia,
        id_proveedor: f.id_proveedor,
        proveedor: f.proveedor,
        subtotal: Number(f.subtotal ?? 0),
        descuento: Number(f.descuento ?? 0),
        impuesto: Number(f.impuesto ?? 0),
        total: Number(f.total ?? 0),
        estado: f.estado,
        motivo_anulacion: f.motivo_anulacion ?? null,
        observaciones: f.observaciones ?? null,
        adjunto_url: f.adjunto_url ?? null,
        afecta_inventario: Boolean(f.afecta_inventario),
        metodo_pago: f.metodo_pago ?? null,
        renglones: Number(f.renglones ?? 0),
        usuario: [f.primer_nombre, f.primer_apellido].filter(Boolean).join(' ') || null,
    };
}

async function detalleEnTransaccion(idCompra, idNegocio, transaction = null) {
    const [cab] = await Models.sequelize.query(`
        SELECT c.id_compra, c.fecha, c.referencia, c.subtotal, c.descuento, c.impuesto, c.total,
               c.estado, c.observaciones, c.adjunto_url, c.afecta_inventario, c.motivo_anulacion,
               c.id_proveedor, p.nombre_comercial AS proveedor,
               mp.nombre AS metodo_pago,
               u.primer_nombre, u.primer_apellido,
               0 AS renglones
          FROM restaurante.rest_compra c
          JOIN restaurante.rest_proveedor p ON p.id_proveedor = c.id_proveedor
          LEFT JOIN restaurante.rest_metodo_pago mp ON mp.id_metodo_pago = c.id_metodo_pago
          LEFT JOIN general.gener_usuario u ON u.id_usuario = c.id_usuario
         WHERE c.id_compra = :idCompra AND c.id_negocio = :idNegocio;
    `, { replacements: { idCompra, idNegocio }, type: QueryTypes.SELECT, transaction });

    if (!cab) throw domainError('Compra no encontrada.', 'COMPRA_NO_ENCONTRADA', 404);

    const detalles = await Models.sequelize.query(`
        SELECT d.id_detalle, d.id_proveedor_insumo, d.id_ingrediente, d.descripcion, d.cantidad,
               d.unidad, d.precio_unitario, d.descuento, d.total, d.stock_sumado,
               g.nombre AS ingrediente, g.unidad_medida AS unidad_inventario
          FROM restaurante.rest_compra_detalle d
          LEFT JOIN restaurante.carta_ingrediente g ON g.id_ingrediente = d.id_ingrediente
         WHERE d.id_compra = :idCompra
         ORDER BY d.id_detalle;
    `, { replacements: { idCompra }, type: QueryTypes.SELECT, transaction });

    return {
        ...aPlanoCompra({ ...cab, renglones: detalles.length }),
        detalles: detalles.map((d) => ({
            id_detalle: d.id_detalle,
            id_proveedor_insumo: d.id_proveedor_insumo,
            id_ingrediente: d.id_ingrediente,
            ingrediente: d.ingrediente ?? null,
            unidad_inventario: d.unidad_inventario ?? null,
            descripcion: d.descripcion,
            cantidad: Number(d.cantidad),
            unidad: d.unidad,
            precio_unitario: Number(d.precio_unitario),
            descuento: Number(d.descuento),
            total: Number(d.total),
            stock_sumado: Number(d.stock_sumado),
        })),
    };
}

async function detalle(idUsuario, idCompra, idNegocioPedido) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_precios',
        'No tienes permiso para consultar el historial de compras.');
    return detalleEnTransaccion(idCompra, idNegocio);
}

// ============================================================
// Resumen de gasto y evolución de precios
// ============================================================

/**
 * Cuánto se gastó por periodo y en quién, para la pregunta de fin de mes. Solo compras
 * vigentes: una anulada no es gasto.
 */
async function resumen(idUsuario, { idNegocio: idNegocioPedido, desde = null, hasta = null } = {}) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_precios',
        'No tienes permiso para consultar el gasto.');

    const repl = { idNegocio, desde, hasta };
    const filtroFecha = `${desde ? ' AND c.fecha >= :desde' : ''}${hasta ? ' AND c.fecha <= :hasta' : ''}`;

    const [totales] = await Models.sequelize.query(`
        SELECT COALESCE(SUM(c.total), 0) AS total,
               COUNT(*)::int AS compras,
               COALESCE(AVG(c.total), 0) AS promedio
          FROM restaurante.rest_compra c
         WHERE c.id_negocio = :idNegocio AND c.estado = 'A'${filtroFecha};
    `, { replacements: repl, type: QueryTypes.SELECT });

    const porMes = await Models.sequelize.query(`
        SELECT to_char(date_trunc('month', c.fecha), 'YYYY-MM') AS periodo,
               COALESCE(SUM(c.total), 0) AS total,
               COUNT(*)::int AS compras
          FROM restaurante.rest_compra c
         WHERE c.id_negocio = :idNegocio AND c.estado = 'A'${filtroFecha}
         GROUP BY 1 ORDER BY 1;
    `, { replacements: repl, type: QueryTypes.SELECT });

    const porProveedor = await Models.sequelize.query(`
        SELECT c.id_proveedor, p.nombre_comercial AS proveedor,
               COALESCE(SUM(c.total), 0) AS total, COUNT(*)::int AS compras
          FROM restaurante.rest_compra c
          JOIN restaurante.rest_proveedor p ON p.id_proveedor = c.id_proveedor
         WHERE c.id_negocio = :idNegocio AND c.estado = 'A'${filtroFecha}
         GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10;
    `, { replacements: repl, type: QueryTypes.SELECT });

    return {
        total: Number(totales.total),
        compras: Number(totales.compras),
        promedio: Number(totales.promedio),
        por_mes: porMes.map((f) => ({
            periodo: f.periodo, total: Number(f.total), compras: Number(f.compras),
        })),
        por_proveedor: porProveedor.map((f) => ({
            id_proveedor: f.id_proveedor,
            proveedor: f.proveedor,
            total: Number(f.total),
            compras: Number(f.compras),
        })),
    };
}

/**
 * Cómo se movió el precio de un insumo en el tiempo. Mezcla las dos fuentes —el histórico de
 * precios y lo que se pagó en cada factura— porque son la misma pregunta vista de dos lados, y
 * marca cada punto con su origen para que se note cuál es un dato y cuál una anotación.
 */
async function evolucionPrecio(idUsuario, { idNegocio: idNegocioPedido, idInsumo = null, idIngrediente = null } = {}) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_precios',
        'No tienes permiso para consultar precios.');

    if (!idInsumo && !idIngrediente) {
        throw domainError('Indica el insumo cuya evolución quieres ver.', 'INSUMO_REQUERIDO', 400);
    }

    const condicion = idInsumo
        ? 'h.id_proveedor_insumo = :idInsumo'
        : 'i.id_ingrediente = :idIngrediente';

    const filas = await Models.sequelize.query(`
        SELECT h.fecha, h.precio, h.origen, h.id_compra,
               i.id_proveedor_insumo, i.nombre AS insumo, i.unidad,
               p.nombre_comercial AS proveedor
          FROM restaurante.rest_proveedor_precio h
          JOIN restaurante.rest_proveedor_insumo i ON i.id_proveedor_insumo = h.id_proveedor_insumo
          JOIN restaurante.rest_proveedor p ON p.id_proveedor = i.id_proveedor
         WHERE h.id_negocio = :idNegocio AND ${condicion}
         ORDER BY h.fecha ASC
         LIMIT 500;
    `, {
        replacements: { idNegocio, idInsumo: Number(idInsumo) || null, idIngrediente: Number(idIngrediente) || null },
        type: QueryTypes.SELECT,
    });

    return filas.map((f) => ({
        fecha: f.fecha,
        precio: Number(f.precio),
        origen: f.origen,
        id_compra: f.id_compra,
        id_proveedor_insumo: f.id_proveedor_insumo,
        insumo: f.insumo,
        unidad: f.unidad,
        proveedor: f.proveedor,
    }));
}

module.exports = {
    crear,
    anular,
    listar,
    detalle,
    resumen,
    evolucionPrecio,
    // expuestos para los tests
    convertir,
    unidadInventario,
};
