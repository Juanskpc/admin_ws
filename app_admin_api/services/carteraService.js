/**
 * Cartera — el libro de caja de EscalApp como empresa. Solo super admin.
 *
 * Ver `docs/cartera.md`. Junta en un solo sitio lo que entra (las mensualidades, que llegan
 * solas desde Cobranza, y lo que se le cobra a otros negocios: desarrollos, facturación a
 * terceros…) y lo que sale, con lo que se queda por el camino a la vista:
 *
 *   - **comisión de la pasarela** (Wompi, dLocal Go) — real si alguien la tecleó al confirmar el
 *     pago, ESTIMADA con la tarifa de lista si no (Wompi no la devuelve por API);
 *   - **4x1000 (GMF)** de cada salida de una cuenta que lo paga;
 *   - **retenciones** que nos practican los clientes empresa — que NO son gasto: son un anticipo
 *     de impuestos que se descuenta al declarar. Por eso el resultado del período no las resta y
 *     la caja sí.
 *
 * ## Errores
 *
 * Tipados con `.code` y `.statusCode`; el controlador los reenvía sin re-envolverlos.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const Dao = require('../../app_core/dao/carteraDao');
const Audit = require('../../app_core/helpers/auditHelper');
const { trmVigente } = require('./trmService');

const sequelize = Models.sequelize;

/** Gravamen a los Movimientos Financieros: 4 por mil de cada débito (Art. 871 E.T.). */
const TASA_GMF = 0.004;
/** La mitad del GMF pagado (certificado por el banco) es deducible en renta (Art. 115 E.T.). */
const GMF_DEDUCIBLE = 0.5;

const TIPOS = ['ingreso', 'egreso', 'transferencia'];

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

function hoyBogota() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/** Pesos sin centavos: así los cobra el banco y así se leen en el extracto. */
function pesos(valor) {
    return Math.round(Number(valor) || 0);
}

function centavos(valor) {
    return Math.round((Number(valor) || 0) * 100) / 100;
}

// ── Cálculos puros (probados en __tests__/cartera/calculos.test.js) ─────────────────────

/**
 * La comisión que se lleva una pasarela por un cobro, según su tarifa de lista.
 *
 * `completa = false` cuando la tarifa tiene un fijo en USD y no hay TRM: la comisión devuelta
 * solo tiene la parte porcentual. Mejor quedarse corto y decirlo que inventarse la tasa.
 *
 * @returns {{ comision: number, iva_comision: number, retencion: number, completa: boolean }}
 */
function estimarComision({ montoCop, tarifa, trm = null }) {
    if (!tarifa) return { comision: 0, iva_comision: 0, retencion: 0, completa: true };
    const monto = Number(montoCop) || 0;
    let fijo = Number(tarifa.fijo) || 0;
    let completa = true;
    if (fijo > 0 && tarifa.fijo_moneda && tarifa.fijo_moneda !== 'COP') {
        if (tarifa.fijo_moneda === 'USD' && trm > 0) fijo *= trm;
        else {
            fijo = 0;
            completa = false;
        }
    }
    const comision = pesos((monto * Number(tarifa.porcentaje || 0)) / 100 + fijo);
    return {
        comision,
        iva_comision: pesos((comision * Number(tarifa.iva_pct || 0)) / 100),
        retencion: pesos((monto * Number(tarifa.retencion_pct || 0)) / 100),
        completa,
    };
}

/**
 * El 4x1000 de un movimiento. Solo lo pagan las SALIDAS (egresos y traslados) de una cuenta que
 * lo cobra; la base es todo lo que se debita de esa cuenta: el monto más los cargos.
 */
function calcularGmf({ tipo, montoCop, comision = 0, ivaComision = 0, aplicaGmf, exento = false }) {
    if (tipo === 'ingreso' || !aplicaGmf || exento) return 0;
    const base = (Number(montoCop) || 0) + (Number(comision) || 0) + (Number(ivaComision) || 0);
    return pesos(base * TASA_GMF);
}

/**
 * Cuánto sube o baja cada cuenta con un movimiento. Misma regla que `DELTAS_SQL` del DAO: si se
 * toca una, se toca la otra.
 */
function efectoEnCuentas(m) {
    const monto = Number(m.monto_cop) || 0;
    const cargos = (Number(m.comision) || 0) + (Number(m.iva_comision) || 0) + (Number(m.gmf) || 0);
    if (m.tipo === 'ingreso') {
        return [{ id_cuenta: m.id_cuenta, delta: monto - cargos - (Number(m.retencion) || 0) }];
    }
    const salida = { id_cuenta: m.id_cuenta, delta: -(monto + cargos) };
    if (m.tipo === 'transferencia') return [salida, { id_cuenta: m.id_cuenta_destino, delta: monto }];
    return [salida];
}

/**
 * Las cifras del período a partir de los totales del DAO.
 *
 *   resultado = ingresos − egresos − comisiones − 4x1000      (lo que ganó la empresa)
 *   caja      = resultado − retenciones                        (lo que de verdad entró al banco)
 *
 * La retención no baja el resultado porque se recupera al declarar renta; sí baja la caja,
 * porque esa plata no llegó. Es la diferencia que hace que «el banco no cuadra».
 */
function cifrasDelPeriodo(t) {
    const comisiones = (t.comisiones_pasarela || 0) + (t.comisiones_bancarias || 0);
    const resultado = (t.ingresos || 0) - (t.egresos || 0) - comisiones - (t.gmf || 0);
    return {
        ingresos: t.ingresos || 0,
        egresos: t.egresos || 0,
        comisiones_pasarela: t.comisiones_pasarela || 0,
        comisiones_bancarias: t.comisiones_bancarias || 0,
        iva_comisiones: t.iva_comisiones || 0,
        comisiones,
        gmf: t.gmf || 0,
        gmf_deducible: pesos((t.gmf || 0) * GMF_DEDUCIBLE),
        retenciones: t.retenciones || 0,
        iva_compras: t.iva_compras || 0,
        resultado,
        caja_neta: resultado - (t.retenciones || 0),
        margen: t.ingresos > 0 ? resultado / t.ingresos : null,
        n_ingresos: t.n_ingresos || 0,
        n_egresos: t.n_egresos || 0,
        estimados: t.estimados || 0,
        sin_tasa: t.sin_tasa || 0,
    };
}

// ── Sincronización: lo que entra solo ───────────────────────────────────────────────────

let sincronizando = null;

/**
 * Copia a la Cartera las mensualidades pagadas y las recargas de OpenAI que aún no están, y
 * anula las que se deshicieron en su origen. Idempotente (UNIQUE en `id_factura` y `id_recarga`)
 * y barata cuando no hay nada nuevo: dos NOT EXISTS.
 *
 * Se llama al abrir la Cartera y no desde `aplicarPagoAprobado`, para que un fallo aquí nunca
 * tumbe un pago (ver la cabecera de la migración). Dos llamadas a la vez comparten la misma
 * promesa; aun sin eso, el UNIQUE impediría duplicar.
 */
async function sincronizarAutomaticos() {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
        const resultado = { mensualidades: 0, recargas: 0, anulados: 0 };
        const facturas = await Dao.facturasSinMovimiento();
        const recargas = await Dao.recargasSinMovimiento();
        if (facturas.length === 0 && recargas.length === 0) {
            resultado.anulados = await Dao.anularHuerfanos();
            return resultado;
        }

        const trm = (await trmVigente())?.valor ?? null;
        const tarifas = new Map((await Dao.listarTarifas()).map((t) => [t.pasarela, t]));

        if (facturas.length) {
            const idCategoria = await Dao.idCategoriaPorCodigo('MENSUALIDADES');
            for (const f of facturas) {
                const cuenta = await Dao.cuentaDePasarela(f.pasarela);
                if (!cuenta || !idCategoria) break; // sin cuentas sembradas: migración a medias
                const datos = movimientoDeFactura(f, { cuenta, idCategoria, tarifa: tarifas.get(f.pasarela), trm });
                if (await Dao.insertarMovimiento(datos)) resultado.mensualidades += 1;
            }
        }

        if (recargas.length) {
            const idCategoria = await Dao.idCategoriaPorCodigo('IA');
            const cuenta = await Dao.cuentaDePasarela('manual');
            if (cuenta && idCategoria) {
                for (const r of recargas) {
                    const datos = movimientoDeRecarga(r, { cuenta, idCategoria, trm });
                    if (await Dao.insertarMovimiento(datos)) resultado.recargas += 1;
                }
            }
        }

        resultado.anulados = await Dao.anularHuerfanos();
        return resultado;
    })();
    try {
        return await sincronizando;
    } finally {
        sincronizando = null;
    }
}

/**
 * El movimiento de una mensualidad pagada. La comisión real manda si alguien la tecleó en
 * Cobranza; si no, se estima con la tarifa y el movimiento queda «estimado».
 */
function movimientoDeFactura(f, { cuenta, idCategoria, tarifa, trm }) {
    const enPesos = f.moneda === 'COP';
    const tasa = enPesos ? 1 : f.moneda === 'USD' && trm ? trm : null;
    const montoCop = tasa ? centavos(f.total * tasa) : null;

    let comision = pesos(f.comision_pasarela);
    let ivaComision = 0;
    let retencionTarifa = 0;
    let estimado = !tasa;
    if (comision === 0 && f.pasarela !== 'manual' && montoCop) {
        const e = estimarComision({ montoCop, tarifa, trm });
        comision = e.comision;
        ivaComision = e.iva_comision;
        retencionTarifa = e.retencion;
        estimado = estimado || comision > 0 || !e.completa;
    }

    return {
        tipo: 'ingreso',
        fecha: f.fecha,
        id_categoria: idCategoria,
        id_cuenta: cuenta.id_cuenta,
        tercero: f.negocio,
        id_negocio: f.id_negocio,
        descripcion: `Mensualidad ${f.referencia}${f.medio_pago_texto ? ` · ${f.medio_pago_texto}` : ''}`.slice(0, 300),
        soporte: f.numero_factura || f.referencia,
        moneda: f.moneda,
        monto: f.total,
        tasa_cop: tasa,
        monto_cop: montoCop,
        comision,
        iva_comision: ivaComision,
        // La retención del cliente empresa (Cobranza) más la que practique la pasarela.
        retencion: pesos(f.retencion_declarada) + retencionTarifa,
        gmf: 0,
        estimado,
        origen: 'cobranza',
        id_factura: f.id_factura,
    };
}

/** Una recarga de saldo de OpenAI (Terceros): sale del banco en USD a la TRM del día. */
function movimientoDeRecarga(r, { cuenta, idCategoria, trm }) {
    const montoCop = trm ? centavos(r.monto_usd * trm) : null;
    return {
        tipo: 'egreso',
        fecha: r.fecha,
        id_categoria: idCategoria,
        id_cuenta: cuenta.id_cuenta,
        tercero: 'OpenAI',
        descripcion: `Recarga de saldo de IA${r.nota ? ` · ${r.nota}` : ''}`.slice(0, 300),
        moneda: 'USD',
        monto: r.monto_usd,
        tasa_cop: trm,
        monto_cop: montoCop,
        // Se paga con tarjeta: si la cuenta paga 4x1000, la compra también.
        gmf: montoCop ? calcularGmf({ tipo: 'egreso', montoCop, aplicaGmf: cuenta.aplica_gmf }) : 0,
        // La tasa es la de hoy, no la que usó el banco: siempre queda por revisar.
        estimado: true,
        origen: 'recarga_ia',
        id_recarga: r.id_recarga,
        id_usuario: r.id_usuario,
    };
}

// ── Lectura ─────────────────────────────────────────────────────────────────────────────

function rangoPorDefecto({ desde, hasta }) {
    const hoy = hoyBogota();
    return { desde: desde || `${hoy.slice(0, 7)}-01`, hasta: hasta || hoy };
}

function validarRango({ desde, hasta }) {
    if (desde > hasta) throw error('La fecha inicial no puede ser posterior a la final.', 'RANGO_INVALIDO', 422);
}

async function catalogos() {
    const [cuentas, categorias, tarifas, trm] = await Promise.all([
        Dao.listarCuentas(),
        Dao.listarCategorias(),
        Dao.listarTarifas(),
        trmVigente(),
    ]);
    return { cuentas, categorias, tarifas, trm, tasa_gmf: TASA_GMF };
}

async function resumen(filtros = {}) {
    const rango = rangoPorDefecto(filtros);
    validarRango(rango);
    const sincronizacion = await sincronizarAutomaticos();

    const [totales, categorias, terceros, meses, cuentas, cobrar] = await Promise.all([
        Dao.totalesPeriodo(rango),
        Dao.porCategoria(rango),
        Dao.ingresosPorTercero(rango),
        Dao.porMes({ hasta: rango.hasta, meses: 12 }),
        Dao.saldosCuentas({ hasta: rango.hasta }),
        Dao.porCobrar(),
    ]);

    const cifras = cifrasDelPeriodo(totales);
    return {
        rango,
        cifras,
        ingresos_por_categoria: categorias.filter((c) => c.tipo === 'ingreso'),
        egresos_por_categoria: categorias.filter((c) => c.tipo === 'egreso'),
        ingresos_por_tercero: terceros,
        por_mes: meses.map((m) => ({
            ...m,
            resultado: m.ingresos - m.egresos - m.costos_financieros,
        })),
        cuentas,
        saldo_total: cuentas.filter((c) => c.estado === 'A').reduce((s, c) => s + c.saldo, 0),
        por_cobrar: cobrar,
        sincronizacion,
    };
}

async function listarMovimientos(filtros = {}) {
    const rango = rangoPorDefecto(filtros);
    validarRango(rango);
    await sincronizarAutomaticos();
    return Dao.listarMovimientos({ ...filtros, ...rango });
}

// ── Escritura de movimientos ────────────────────────────────────────────────────────────

/** Campos que se pueden tocar de un movimiento que creó la plataforma (Cobranza / Terceros). */
const EDITABLES_AUTOMATICO = new Set([
    'fecha', 'id_categoria', 'id_cuenta', 'tercero', 'descripcion', 'soporte', 'tasa_cop',
    'comision', 'iva_comision', 'retencion', 'iva', 'gmf', 'exento_gmf',
]);

/**
 * Normaliza y valida un movimiento completo (el resultado de mezclar lo guardado con lo que llega)
 * y recalcula lo derivado: `monto_cop` desde la tasa y el 4x1000 desde la cuenta, salvo que el
 * dueño haya tecleado el 4x1000 del extracto (`gmf` explícito).
 */
async function prepararMovimiento(m, { gmfExplicito, transaction }) {
    if (!TIPOS.includes(m.tipo)) throw error('Tipo de movimiento inválido.', 'TIPO_INVALIDO', 422);

    const cuenta = await Dao.getCuenta(m.id_cuenta, { transaction });
    if (!cuenta) throw error('La cuenta no existe.', 'CUENTA_NO_ENCONTRADA', 404);
    if (cuenta.estado !== 'A') throw error('La cuenta está inactiva.', 'CUENTA_INACTIVA', 409);

    if (m.tipo === 'transferencia') {
        if (!m.id_cuenta_destino) throw error('Falta la cuenta de destino.', 'CUENTA_DESTINO_REQUERIDA', 422);
        if (Number(m.id_cuenta_destino) === Number(m.id_cuenta)) {
            throw error('La cuenta de origen y la de destino son la misma.', 'CUENTA_DESTINO_IGUAL', 422);
        }
        const destino = await Dao.getCuenta(m.id_cuenta_destino, { transaction });
        if (!destino || destino.estado !== 'A') {
            throw error('La cuenta de destino no existe o está inactiva.', 'CUENTA_NO_ENCONTRADA', 404);
        }
        m.id_categoria = null;
        m.retencion = 0;
    } else {
        m.id_cuenta_destino = null;
        if (!m.id_categoria) throw error('Elige una categoría.', 'CATEGORIA_REQUERIDA', 422);
        const categoria = await Dao.getCategoria(m.id_categoria, { transaction });
        if (!categoria) throw error('La categoría no existe.', 'CATEGORIA_NO_ENCONTRADA', 404);
        if (categoria.tipo !== m.tipo) {
            throw error(`Esa categoría es de ${categoria.tipo}s, no de ${m.tipo}s.`, 'CATEGORIA_NO_CORRESPONDE', 422);
        }
        // La retención es la que NOS practican al pagarnos; en un egreso no aplica.
        if (m.tipo === 'egreso') m.retencion = 0;
    }

    m.moneda = (m.moneda || 'COP').toUpperCase();
    m.monto = centavos(m.monto);
    if (!(m.monto > 0)) throw error('El monto debe ser mayor que cero.', 'MONTO_INVALIDO', 422);
    if (m.moneda === 'COP') m.tasa_cop = 1;
    m.tasa_cop = m.tasa_cop ? Number(m.tasa_cop) : null;
    m.monto_cop = m.tasa_cop ? centavos(m.monto * m.tasa_cop) : null;

    for (const c of ['comision', 'iva_comision', 'retencion', 'iva']) m[c] = pesos(m[c]);
    m.exento_gmf = !!m.exento_gmf;
    m.gmf = gmfExplicito
        ? pesos(m.gmf)
        : calcularGmf({
            tipo: m.tipo,
            montoCop: m.monto_cop ?? 0,
            comision: m.comision,
            ivaComision: m.iva_comision,
            aplicaGmf: cuenta.aplica_gmf,
            exento: m.exento_gmf,
        });
    if (m.tipo === 'ingreso' && m.comision + m.iva_comision + m.retencion + m.gmf > (m.monto_cop ?? Infinity)) {
        throw error('Los descuentos no pueden superar el monto recibido.', 'MONTO_INVALIDO', 422);
    }
    return m;
}

async function crearMovimiento(datos, { idUsuario } = {}) {
    const transaction = await sequelize.transaction();
    try {
        const m = await prepararMovimiento(
            {
                tipo: datos.tipo,
                fecha: datos.fecha || hoyBogota(),
                id_categoria: datos.id_categoria ?? null,
                id_cuenta: datos.id_cuenta,
                id_cuenta_destino: datos.id_cuenta_destino ?? null,
                tercero: datos.tercero?.trim() || null,
                id_negocio: datos.id_negocio ?? null,
                descripcion: datos.descripcion?.trim() || null,
                soporte: datos.soporte?.trim() || null,
                moneda: datos.moneda,
                monto: datos.monto,
                tasa_cop: datos.tasa_cop ?? null,
                comision: datos.comision,
                iva_comision: datos.iva_comision,
                retencion: datos.retencion,
                iva: datos.iva,
                gmf: datos.gmf,
                exento_gmf: datos.exento_gmf,
            },
            { gmfExplicito: datos.gmf !== undefined && datos.gmf !== null, transaction }
        );
        const id = await Dao.insertarMovimiento(
            { ...m, origen: 'manual', estimado: m.tasa_cop === null, id_usuario: idUsuario ?? null },
            { transaction }
        );
        await Audit.registrarEvento({
            modulo: 'cartera',
            accion: 'movimiento_creado',
            detalle: { id_movimiento: id, tipo: m.tipo, monto_cop: m.monto_cop, gmf: m.gmf },
            transaction,
        });
        await transaction.commit();
        return Dao.getMovimiento(id);
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

/**
 * Edita un movimiento. De uno automático solo se tocan las cifras que no vienen de Cobranza
 * (comisión real, retención, 4x1000, tasa…): el monto lo fijó el pago y cambiarlo aquí haría que
 * la Cartera y Cobranza dijeran cosas distintas. Editar quita la marca «estimado»: alguien lo
 * revisó contra el extracto.
 */
async function actualizarMovimiento(idMovimiento, datos) {
    const transaction = await sequelize.transaction();
    try {
        const actual = await Dao.getMovimiento(idMovimiento, { transaction, lock: true });
        if (!actual) throw error('Movimiento no encontrado.', 'MOVIMIENTO_NO_ENCONTRADO', 404);
        if (actual.estado !== 'A') throw error('El movimiento está anulado.', 'MOVIMIENTO_ANULADO', 409);

        const automatico = actual.origen !== 'manual';
        const entrada = Object.fromEntries(
            Object.entries(datos).filter(
                ([k, v]) => v !== undefined && (!automatico || EDITABLES_AUTOMATICO.has(k))
            )
        );
        if (automatico) {
            const cambiaOrigen = ['tipo', 'monto', 'moneda'].some(
                (k) => datos[k] !== undefined && String(datos[k]) !== String(actual[k])
            );
            if (cambiaOrigen) {
                throw error(
                    'El monto de un movimiento automático lo fija su origen; cámbialo allí.',
                    'MOVIMIENTO_AUTOMATICO',
                    409
                );
            }
        }

        const gmfExplicito = entrada.gmf !== undefined && entrada.gmf !== null;
        const m = await prepararMovimiento(
            { ...actual, ...entrada, gmf: gmfExplicito ? entrada.gmf : actual.gmf },
            {
                // Si no se cambió nada que mueva el 4x1000, se respeta el que ya tenía (quizá
                // tecleado del extracto).
                gmfExplicito: gmfExplicito || !['monto', 'tasa_cop', 'id_cuenta', 'comision',
                    'iva_comision', 'exento_gmf', 'moneda', 'tipo'].some((k) => k in entrada),
                transaction,
            }
        );

        const cambios = {};
        for (const k of [...EDITABLES_AUTOMATICO, 'tipo', 'id_cuenta_destino', 'id_negocio',
            'moneda', 'monto', 'monto_cop']) {
            if (m[k] !== actual[k]) cambios[k] = m[k] ?? null;
        }
        cambios.estimado = m.tasa_cop === null;
        await Dao.actualizarMovimiento(idMovimiento, cambios, { transaction });
        await transaction.commit();
        return Dao.getMovimiento(idMovimiento);
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

/** Anular nunca borra: el movimiento queda con su motivo, y deja de sumar. */
async function anularMovimiento(idMovimiento, { motivo }) {
    const actual = await Dao.getMovimiento(idMovimiento);
    if (!actual) throw error('Movimiento no encontrado.', 'MOVIMIENTO_NO_ENCONTRADO', 404);
    if (actual.estado !== 'A') throw error('El movimiento ya está anulado.', 'MOVIMIENTO_ANULADO', 409);
    await Dao.actualizarMovimiento(idMovimiento, { estado: 'E', motivo_anulacion: motivo.trim() });
    await Audit.registrarEvento({
        modulo: 'cartera',
        accion: 'movimiento_anulado',
        detalle: { id_movimiento: idMovimiento, origen: actual.origen, monto_cop: actual.monto_cop, motivo },
    });
    return { id_movimiento: idMovimiento, estado: 'E' };
}

// ── Cuentas, categorías y tarifas ───────────────────────────────────────────────────────

async function crearCuenta(datos) {
    const id = await Dao.crearCuenta({
        nombre: datos.nombre.trim(),
        tipo: datos.tipo || 'banco',
        moneda: (datos.moneda || 'COP').toUpperCase(),
        aplica_gmf: !!datos.aplica_gmf,
        saldo_inicial: centavos(datos.saldo_inicial),
        fecha_saldo: datos.fecha_saldo || null,
        nota: datos.nota?.trim() || null,
    });
    return { id_cuenta: id };
}

async function actualizarCuenta(idCuenta, datos) {
    const cuenta = await Dao.getCuenta(idCuenta);
    if (!cuenta) throw error('La cuenta no existe.', 'CUENTA_NO_ENCONTRADA', 404);
    if (datos.estado === 'I' && cuenta.pasarela) {
        throw error(
            'Esta cuenta recibe los pagos de una pasarela: no se puede desactivar.',
            'CUENTA_DE_PASARELA',
            409
        );
    }
    const cambios = {};
    for (const k of ['nombre', 'tipo', 'aplica_gmf', 'saldo_inicial', 'fecha_saldo', 'nota', 'estado']) {
        if (datos[k] !== undefined) cambios[k] = typeof datos[k] === 'string' ? datos[k].trim() || null : datos[k];
    }
    if (cambios.nombre === null) throw error('El nombre es obligatorio.', 'NOMBRE_REQUERIDO', 422);
    await Dao.actualizarCuenta(idCuenta, cambios);
    return { id_cuenta: idCuenta };
}

function codigoDe(nombre) {
    return nombre
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        .slice(0, 34);
}

async function crearCategoria({ nombre, tipo }) {
    const base = codigoDe(nombre) || 'CATEGORIA';
    // Dos nombres pueden dar el mismo código («Cafetería» y «cafeteria»): se numera.
    for (let i = 0; i < 20; i += 1) {
        const id = await Dao.crearCategoria({ codigo: i ? `${base}_${i}` : base, nombre: nombre.trim(), tipo });
        if (id) return { id_categoria: id };
    }
    throw error('No se pudo crear la categoría.', 'CATEGORIA_DUPLICADA', 409);
}

async function actualizarCategoria(idCategoria, { nombre, estado }) {
    const categoria = await Dao.getCategoria(idCategoria);
    if (!categoria) throw error('La categoría no existe.', 'CATEGORIA_NO_ENCONTRADA', 404);
    if (estado === 'I' && categoria.sistema) {
        throw error('Esta categoría la llena la plataforma: no se puede desactivar.', 'CATEGORIA_DE_SISTEMA', 409);
    }
    const cambios = {};
    if (nombre !== undefined) cambios.nombre = nombre.trim();
    if (estado !== undefined) cambios.estado = estado;
    await Dao.actualizarCategoria(idCategoria, cambios);
    return { id_categoria: idCategoria };
}

/**
 * Cambia la tarifa con la que se ESTIMAN las comisiones. No recalcula los movimientos ya
 * guardados: lo pasado se cobró con la tarifa de entonces.
 */
async function actualizarTarifa(pasarela, datos) {
    const ok = await Dao.actualizarTarifa(pasarela, {
        porcentaje: Number(datos.porcentaje) || 0,
        fijo: Number(datos.fijo) || 0,
        fijo_moneda: (datos.fijo_moneda || 'COP').toUpperCase(),
        iva_pct: Number(datos.iva_pct) || 0,
        retencion_pct: Number(datos.retencion_pct) || 0,
        nota: datos.nota?.trim() || null,
    });
    if (!ok) throw error('Esa pasarela no tiene tarifa.', 'TARIFA_NO_ENCONTRADA', 404);
    return { pasarela };
}

// ── Exportación para la contadora ───────────────────────────────────────────────────────

/** Número con coma decimal: lo que entiende Excel en español sin preguntar. */
function numeroCsv(valor) {
    if (valor === null || valor === undefined) return '';
    return String(centavos(valor)).replace('.', ',');
}

function celdaCsv(valor) {
    const texto = valor === null || valor === undefined ? '' : String(valor);
    return /[";\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

const TIPO_CSV = { ingreso: 'Ingreso', egreso: 'Egreso', transferencia: 'Traslado' };

async function exportarCsv(filtros = {}) {
    const filas = await listarMovimientos(filtros);
    const encabezado = [
        'Fecha', 'Tipo', 'Categoría', 'Cuenta', 'Cuenta destino', 'Tercero', 'Descripción',
        'Soporte', 'Moneda', 'Monto', 'Tasa', 'Monto COP', 'Comisión', 'IVA comisión',
        'Retención', 'IVA', '4x1000', 'Neto en cuenta', 'Origen', 'Estimado',
    ];
    const lineas = filas.map((m) => {
        const neto = efectoEnCuentas(m)[0].delta;
        return [
            m.fecha, TIPO_CSV[m.tipo], m.categoria, m.cuenta, m.cuenta_destino,
            m.negocio || m.tercero, m.descripcion, m.soporte, m.moneda,
            numeroCsv(m.monto), numeroCsv(m.tasa_cop), numeroCsv(m.monto_cop),
            numeroCsv(m.comision), numeroCsv(m.iva_comision), numeroCsv(m.retencion),
            numeroCsv(m.iva), numeroCsv(m.gmf), numeroCsv(neto), m.origen, m.estimado ? 'Sí' : 'No',
        ].map(celdaCsv).join(';');
    });
    // BOM: sin él, Excel abre las tildes como «CategorÃ­a».
    return '﻿' + [encabezado.join(';'), ...lineas].join('\r\n');
}

module.exports = {
    TASA_GMF,
    estimarComision,
    calcularGmf,
    efectoEnCuentas,
    cifrasDelPeriodo,
    movimientoDeFactura,
    movimientoDeRecarga,
    sincronizarAutomaticos,
    catalogos,
    resumen,
    listarMovimientos,
    crearMovimiento,
    actualizarMovimiento,
    anularMovimiento,
    crearCuenta,
    actualizarCuenta,
    crearCategoria,
    actualizarCategoria,
    actualizarTarifa,
    exportarCsv,
    _codigoDe: codigoDe,
};
