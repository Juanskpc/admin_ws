/**
 * cobranzaService — las reglas del cobro de NUESTRAS mensualidades.
 *
 * Ver `docs/cobro-mensualidades.md`. Este servicio es dueño de tres decisiones:
 *   1. qué período cubre una factura,
 *   2. qué pasa en la base cuando alguien paga,
 *   3. quién puede cobrarse solo y quién no.
 *
 * ## El impuesto va en cero, y no es un olvido
 *
 * EscalApp no es responsable de IVA hoy, así que las mensualidades salen sin IVA y en la
 * factura el tributo va como `ZZ` (no causa) — `docs/obligaciones-escalapp.md` §2. La columna
 * `impuestos` existe y se escribe explícitamente en 0 para que el día que eso cambie sea un
 * cálculo, no una migración de datos.
 *
 * ## Lo que este servicio NO hace
 *
 * No cobra automáticamente. La única pasarela implementada es `manual` (F0), y un cobro manual
 * lo confirma un humano. El cron de cobro llega con dLocal (F1) y se apoya exactamente en
 * `generarFacturaPeriodo` + el adaptador, que ya existen.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const Dao = require('../../app_core/dao/cobranzaDao');
const { getAdaptador, getAdaptadorListo } = require('../../app_core/cobranza');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');
// El país del negocio es `gener_negocio.pais` (migrate:pais-negocio, 2026-09-09), NO el de la ficha
// fiscal: ese vale 'CO' por defecto y solo se llena al activar facturación. Leerlo de ahí le
// ofrecía Wompi —que solo cobra en Colombia— a un negocio chileno.
const { paisDeNegocio } = require('../../app_core/helpers/paisNegocio');
const { getLimitesNegocio } = require('../../app_core/helpers/limitesNegocio');

const sequelize = Models.sequelize;

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

// ── Fechas ──────────────────────────────────────────────────────────────────────────────
//
// Todo lo de aquí trabaja con 'YYYY-MM-DD' como string y no con Date. Un período de
// facturación es una fecha de calendario, no un instante: el 1 de octubre es el 1 de octubre
// en Bogotá y en Santiago, y meter husos en esto solo produce facturas que empiezan el 30 de
// septiembre a las 19:00.

/** Hoy en Bogotá, como 'YYYY-MM-DD'. `toISOString()` daría el día equivocado de noche. */
function hoyBogota() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function partes(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return { a, m, d };
}

function diasDelMes(anio, mes) {
    return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function comoIso(a, m, d) {
    return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Suma un ciclo a una fecha, respetando el fin de mes.
 *
 * El 31 de enero + 1 mes es el 28 de febrero, no el 3 de marzo. Es el bug clásico de la
 * facturación mensual y se cobra caro: un cliente al que se le corre el ciclo tres días cada
 * mes termina pagando trece veces al año.
 */
function sumarCiclo(iso, ciclo) {
    const { a, m, d } = partes(iso);
    if (ciclo === 'anual') return comoIso(a + 1, m, Math.min(d, diasDelMes(a + 1, m)));
    const mesTotal = m + 1;
    const anio = a + Math.floor((mesTotal - 1) / 12);
    const mes = ((mesTotal - 1) % 12) + 1;
    return comoIso(anio, mes, Math.min(d, diasDelMes(anio, mes)));
}

/** El día anterior. El período cubre [inicio, fin], ambos incluidos. */
function diaAnterior(iso) {
    const { a, m, d } = partes(iso);
    const fecha = new Date(Date.UTC(a, m - 1, d));
    fecha.setUTCDate(fecha.getUTCDate() - 1);
    return fecha.toISOString().slice(0, 10);
}

/** El fin del período como instante de pared Bogotá, para empujar `gener_negocio_plan`. */
function finDeDiaBogota(iso) {
    return new Date(`${iso}T23:59:59-05:00`);
}

/** `EA-<id_negocio>-<AAAAMM>`: la llave de idempotencia. Ver el modelo `cob_factura`. */
function construirReferencia(idNegocio, periodoInicio) {
    const { a, m } = partes(periodoInicio);
    return `EA-${idNegocio}-${a}${String(m).padStart(2, '0')}`;
}

// ── Consulta ────────────────────────────────────────────────────────────────────────────

/**
 * Todo lo que el inquilino necesita ver de su suscripción, y lo que el super-admin necesita
 * para atenderlo: estado, plan, precio vigente, historial y opciones de pago de su país.
 */
async function getResumenNegocio(idNegocio) {
    const suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
    const pais = await paisDeNegocio(idNegocio);
    const pasarelas = await Dao.listarPasarelas({ pais });

    if (!suscripcion) {
        return { suscripcion: null, precio: null, facturas: [], pasarelas, pais };
    }

    const facturas = await Dao.listarFacturasDeNegocio(idNegocio);

    // El precio puede no estar configurado para esta moneda todavía (el caso de Chile hasta que
    // el dueño fije la cifra). Eso no debe romper la pantalla: se devuelve null y la vista lo dice.
    let precio = null;
    try {
        precio = await Dao.getPrecio({
            idPlan: suscripcion.id_plan,
            moneda: suscripcion.moneda,
            ciclo: suscripcion.ciclo,
            idNegocio,
        });
    } catch (err) {
        if (err.code !== 'PRECIO_NO_CONFIGURADO') throw err;
    }

    return {
        suscripcion,
        precio,
        facturas,
        pasarelas,
        pais,
    };
}

async function listarCartera(filtros) {
    return Dao.listarCartera(filtros);
}

async function resumenIngresos(opciones) {
    return Dao.resumenIngresos(opciones);
}

// ── Configuración de la suscripción ─────────────────────────────────────────────────────

/**
 * Crea o actualiza cómo nos paga un negocio. Solo super-admin: si el inquilino pudiera tocar
 * su propia suscripción, se regala el producto.
 *
 * La pasarela se valida contra el catálogo Y contra los adaptadores implementados. Son dos
 * comprobaciones distintas: una fila activa en `cob_pasarela` sin código detrás es un error de
 * configuración, y dejarlo pasar produce una suscripción que nadie puede cobrar.
 */
async function configurarSuscripcion(idNegocio, datos, { transaction } = {}) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio'],
        transaction,
    });
    if (!negocio) throw error('Negocio no encontrado.', 'NEGOCIO_NO_ENCONTRADO', 404);

    const pais = await paisDeNegocio(idNegocio, { transaction });
    const disponibles = await Dao.listarPasarelas({ pais });
    // Por defecto, la primera pasarela activa del país. Antes era 'manual' fijo, y desde que la
    // transferencia se desactivó (migrate:cobranza-solo-wompi) ese defecto hacía fallar la
    // configuración de cualquier suscripción que no dijera su pasarela.
    const pasarela = datos.pasarela || disponibles[0]?.codigo || 'wompi';

    if (!disponibles.some((p) => p.codigo === pasarela)) {
        throw error(
            `La pasarela '${pasarela}' no está disponible para un negocio de ${pais}.`,
            'PASARELA_NO_DISPONIBLE_PAIS',
            409
        );
    }
    getAdaptador(pasarela); // lanza 501 si el catálogo promete algo que el código no cumple

    const plan = await Models.GenerPlan.findOne({
        where: { id_plan: datos.id_plan, estado: 'A' },
        attributes: ['id_plan'],
    });
    if (!plan) throw error('Plan no encontrado o inactivo.', 'PLAN_NO_ENCONTRADO', 404);

    const existente = await Dao.getSuscripcionPorNegocio(idNegocio, { transaction });

    // `proximo_cobro` solo tiene sentido si algo puede cobrar solo. Ponérselo a una suscripción
    // manual sería prometer un cobro automático que nadie va a ejecutar.
    const adaptador = getAdaptador(pasarela);
    const automatica = adaptador.soportaRecurrente && !datos.es_retenedor;

    const campos = {
        id_plan: datos.id_plan,
        ciclo: datos.ciclo || 'mensual',
        moneda: datos.moneda || 'COP',
        pasarela,
        es_retenedor: Boolean(datos.es_retenedor),
        dia_cobro: datos.dia_cobro ?? null,
        notas: datos.notas ?? null,
        proximo_cobro: automatica ? (datos.proximo_cobro ?? null) : null,
    };

    setAuditNegocio(idNegocio);

    if (existente) {
        const actualizada = await Dao.actualizarSuscripcion(existente.id_suscripcion, campos, { transaction });
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'suscripcion_actualizada',
            idNegocio,
            detalle: { id_suscripcion: existente.id_suscripcion, ...campos },
            transaction,
        });
        return actualizada;
    }

    const creada = await Dao.crearSuscripcion(
        { id_negocio: idNegocio, estado: 'activa', ...campos },
        { transaction }
    );
    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'suscripcion_creada',
        idNegocio,
        detalle: { id_suscripcion: creada.id_suscripcion, ...campos },
        transaction,
    });
    return creada;
}

/**
 * Los complementos de un negocio para la consola: **todo el catálogo**, con lo que tenga
 * contratado puesto encima.
 *
 * Se devuelve el catálogo entero y no solo lo contratado porque la pantalla es un editor: quien
 * mira tiene que poder añadir lo que aún no tiene sin adivinar qué existe. Lo no contratado
 * viene en cero.
 */
async function getComplementosNegocio(idNegocio) {
    const suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
    const moneda = suscripcion?.moneda || 'COP';
    const ciclo = suscripcion?.ciclo || 'mensual';

    const catalogo = await Dao.listarComplementosCatalogo({ moneda, ciclo });
    const contratados = suscripcion
        ? await Dao.listarComplementosSuscripcion(suscripcion.id_suscripcion, { moneda, ciclo })
        : [];

    const items = catalogo.map((c) => {
        const mio = contratados.find((x) => x.id_complemento === c.id_complemento);
        const cantidad = mio?.cantidad ?? 0;
        const facturable = mio ? Number(mio.cantidad_facturable ?? mio.cantidad) : 0;
        // Lo pedido y sin pagar: `null` cuando no hay nada pendiente. La pantalla lo usa para
        // decir «tienes 2, pediste 4» en vez de mentir con uno de los dos números.
        const solicitada = mio?.cantidad_solicitada ?? null;
        return {
            id_complemento: c.id_complemento,
            codigo: c.codigo,
            nombre: c.nombre,
            descripcion: c.descripcion,
            amplia: c.amplia,
            cantidad_maxima: c.cantidad_maxima,
            precio: c.precio,
            cantidad,
            cantidad_facturable: facturable,
            cantidad_solicitada: solicitada == null ? null : Number(solicitada),
            cortesia: Math.max(0, cantidad - facturable),
            subtotal: facturable * c.precio,
        };
    });

    return {
        moneda,
        ciclo,
        tiene_suscripcion: Boolean(suscripcion),
        complementos: items,
        total_mensual: items.reduce((suma, i) => suma + i.subtotal, 0),
        limites: await getLimitesNegocio(idNegocio),
    };
}

/**
 * Fija los complementos de un negocio desde la consola de super-admin.
 *
 * Dos cantidades por complemento: lo que el negocio **puede usar** y lo que se le **cobra**. La
 * diferencia es cortesía y es la forma de regularizar a quien ya venía usando más de lo que su
 * plan incluye sin cobrarle de golpe algo que nunca pactó.
 *
 * Si hay una factura pendiente, se recalcula aquí mismo: si no, el cambio no se vería hasta el
 * mes siguiente y el cobro que el cliente tiene delante seguiría diciendo otra cosa.
 */
async function fijarComplementosNegocio(idNegocio, lista) {
    const suscripcion = await Dao.exigirSuscripcion(idNegocio);
    const catalogo = await Dao.listarComplementosCatalogo({
        moneda: suscripcion.moneda,
        ciclo: suscripcion.ciclo,
    });

    const resueltos = [];
    for (const item of lista || []) {
        const codigo = String(item?.codigo ?? '').trim().toUpperCase();
        const c = catalogo.find((x) => x.codigo === codigo);
        if (!c) throw error(`El complemento ${codigo} no existe o no tiene precio.`, 'COMPLEMENTO_NO_DISPONIBLE', 422);

        const cantidad = Number(item.cantidad ?? 0);
        const facturable = Number(item.cantidad_facturable ?? cantidad);

        if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > c.cantidad_maxima) {
            throw error(
                `«${c.nombre}»: la cantidad debe estar entre 0 y ${c.cantidad_maxima}.`,
                'COMPLEMENTO_CANTIDAD',
                422
            );
        }
        if (!Number.isInteger(facturable) || facturable < 0 || facturable > cantidad) {
            throw error(
                `«${c.nombre}»: lo que se cobra no puede ser más que lo asignado.`,
                'COMPLEMENTO_FACTURABLE',
                422
            );
        }
        if (cantidad === 0) continue;
        resueltos.push({ id_complemento: c.id_complemento, cantidad, cantidad_facturable: facturable });
    }

    setAuditNegocio(idNegocio);
    await Dao.fijarComplementosSuscripcion(suscripcion.id_suscripcion, idNegocio, resueltos);

    const pendiente = await Models.CobFactura.findOne({
        where: { id_negocio: idNegocio, estado: 'pendiente' },
        order: [['periodo_inicio', 'DESC']],
    });
    if (pendiente) await recalcularFacturaPendiente(pendiente.id_factura);

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'complementos_actualizados',
        idNegocio,
        detalle: {
            complementos: resueltos.map((r) => ({
                id_complemento: r.id_complemento,
                cantidad: r.cantidad,
                cobrados: r.cantidad_facturable,
            })),
            factura_recalculada: pendiente?.referencia ?? null,
        },
    });

    return getComplementosNegocio(idNegocio);
}

// ── Facturación ─────────────────────────────────────────────────────────────────────────

/**
 * La última factura que cuenta: la de período más reciente que no esté anulada. Anular es
 * justamente decir «ese período no cuenta», así que no cierra el paso a rehacerlo.
 */
async function ultimaFactura(idNegocio, { transaction } = {}) {
    const [fila] = await sequelize.query(
        `SELECT id_factura, periodo_fin, estado
           FROM cobranza.cob_factura
          WHERE id_negocio = :idNegocio AND estado <> 'anulada'
          ORDER BY periodo_fin DESC
          LIMIT 1;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    return fila || null;
}

function sumarDias(iso, dias) {
    const { a, m, d } = partes(iso);
    const fecha = new Date(Date.UTC(a, m - 1, d));
    fecha.setUTCDate(fecha.getUTCDate() + dias);
    return fecha.toISOString().slice(0, 10);
}

function sumarDia(iso) {
    return sumarDias(iso, 1);
}

/**
 * Genera (o recupera) la factura del período que toca.
 *
 * **Es idempotente, y hacen falta DOS guardas para conseguirlo:**
 *
 * 1. `referencia` es UNIQUE, así que la misma factura del mismo mes no se puede duplicar.
 * 2. **Si el negocio ya tiene período cubierto hacia adelante, no se genera nada.** Esta es la
 *    que de verdad importa y es fácil de olvidar: sin ella, la primera guarda no salta —porque
 *    la segunda llamada calcula el mes SIGUIENTE, con otra referencia— y un doble clic en
 *    «Generar cobro» le factura dos meses al cliente. Un cron que corriera dos veces el mismo
 *    día haría lo mismo.
 *
 * Para adelantar un período a propósito está `desde`, que salta la guarda 2 explícitamente.
 * Un cobro anticipado tiene que ser una decisión, no un accidente.
 */
async function generarFacturaPeriodo(idNegocio, { desde = null, transaction: txExterna = null } = {}) {
    // Con `transaction` la factura se genera DENTRO de la transacción de quien llama (que la
    // confirma o la deshace); sin ella, esta función abre y cierra la suya, como siempre.
    const transaction = txExterna ?? undefined;
    const suscripcion = await Dao.exigirSuscripcion(idNegocio, { transaction });

    if (suscripcion.estado === 'cancelada') {
        throw error(
            'La suscripción está cancelada: no se pueden generar cobros nuevos.',
            'SUSCRIPCION_CANCELADA',
            409
        );
    }

    const ultima = await ultimaFactura(idNegocio, { transaction });
    const hoy = hoyBogota();

    // El plan de MAYOR cobertura del negocio: el mismo que renueva un pago.
    const [plan] = await sequelize.query(
        `SELECT to_char(fecha_fin::date, 'YYYY-MM-DD') AS fin
           FROM general.gener_negocio_plan
          WHERE id_negocio = :idNegocio AND estado = 'A'
          ORDER BY fecha_fin DESC NULLS FIRST
          LIMIT 1;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction }
    );

    // **Solo se cobra un plan vencido o a punto de vencer.** Sin esto, «Generar cobro» le ponía
    // algo que pagar a un cliente que acababa de pagar: el super admin podía crear el cobro de
    // mayo de 2027 en septiembre de 2026, y al cliente le aparecía en su portal (2026-09-15).
    //
    // La ventana es la misma que usa el cron (5 días antes), así que el botón no puede hacer nada
    // que la generación automática no fuera a hacer sola. `desde` explícito la salta: es la vía
    // para un cobro deliberado fuera de ciclo.
    if (!desde) {
        if (!plan?.fin) {
            throw error(
                'El plan de este negocio no tiene fecha de vencimiento: no hay nada que cobrar.',
                'PLAN_SIN_VENCIMIENTO',
                409
            );
        }
        if (plan.fin > sumarDias(hoy, DIAS_ANTICIPACION_COBRO)) {
            throw error(
                `El plan está vigente hasta el ${plan.fin}. El cobro se genera solo, ` +
                    `${DIAS_ANTICIPACION_COBRO} días antes de esa fecha.`,
                'PLAN_VIGENTE',
                409
            );
        }
    }

    // Guarda contra el doble clic (y el cron que corre dos veces): si ya hay un cobro PENDIENTE que
    // cubre hoy o más adelante, se devuelve ese. Solo si está pendiente: una factura PAGADA que
    // cubre hasta el vencimiento no significa «nada que cobrar». Cinco días antes de vencer es
    // justo cuando toca la siguiente, y con la guarda sobre cualquier estado la renovación
    // automática no habría salido nunca.
    if (
        !desde &&
        ultima &&
        ultima.estado === 'pendiente' &&
        String(ultima.periodo_fin).slice(0, 10) >= hoy
    ) {
        const vigente = await Dao.getFactura(ultima.id_factura, { transaction });
        return { factura: vigente, ya_existia: true };
    }

    // El período que se cobra es la RENOVACIÓN, con la misma regla que se aplicará al pagar
    // (`calcularRenovacion`): un ciclo desde el fin de lo ya cubierto. «Lo cubierto» es lo más
    // tardío entre el vencimiento del plan y la última factura: si alguien extendió el plan a mano
    // en Negocios no se cobra un período que ya tiene, y si hay una factura pagada por delante no
    // se repite.
    //
    // Es una ESTIMACIÓN. El cliente puede pagar días después de generada, así que al pagar se
    // recalcula desde el vencimiento real y la factura se corrige con el período que compró.
    let periodoInicio;
    let periodoFin;
    if (desde) {
        periodoInicio = desde;
        periodoFin = diaAnterior(sumarCiclo(desde, suscripcion.ciclo));
    } else {
        // `plan` se leyó arriba, con la validación de la ventana: una sola consulta y una sola
        // verdad sobre cuál es el plan de mayor cobertura.
        const porFactura = ultima ? String(ultima.periodo_fin).slice(0, 10) : null;
        const porPlan = plan?.fin ?? null;
        const cubiertoHasta = porFactura && (!porPlan || porFactura > porPlan) ? porFactura : porPlan;
        const renovacion = calcularRenovacion({ fin: cubiertoHasta, hoy, ciclo: suscripcion.ciclo });
        periodoInicio = renovacion.inicio;
        periodoFin = renovacion.fin;
    }
    const referencia = construirReferencia(idNegocio, periodoInicio);

    // La referencia es UNIQUE. Si ya existe una factura con ella:
    //   - pendiente o pagada → es la de este período y se devuelve (idempotencia).
    //   - ANULADA → se reactiva como cobro nuevo, con el precio y la pasarela de hoy. Antes se
    //     devolvía la anulada tal cual, y ese período ya no se podía volver a cobrar nunca: el
    //     UNIQUE impedía crear otra y «Generar cobro» respondía «ya existía» (2026-09-15).
    const yaExiste = await Dao.getFacturaPorReferencia(referencia, { transaction });
    if (yaExiste && yaExiste.estado !== 'anulada') return { factura: yaExiste, ya_existia: true };

    // El plan que se cobra es el que el cliente ELIGIÓ, si eligió uno y aún no lo ha pagado.
    // `id_plan` de la suscripción sigue siendo el que tiene contratado hoy: cambiarlo antes de
    // cobrar sería regalarle el plan nuevo.
    const idPlanACobrar = suscripcion.id_plan_solicitado || suscripcion.id_plan;
    // Plan + complementos contratados, a precio de hoy. Es lo que hace que una renovación cobre
    // lo mismo que el alta: el cliente no eligió «un plan», eligió un plan con dos usuarios más.
    const cobro = await calcularCobro(suscripcion, idPlanACobrar, { transaction });

    setAuditNegocio(idNegocio);

    const campos = {
        id_suscripcion: suscripcion.id_suscripcion,
        id_negocio: idNegocio,
        id_plan: idPlanACobrar,
        referencia,
        periodo_inicio: periodoInicio,
        periodo_fin: periodoFin,
        moneda: suscripcion.moneda,
        subtotal: cobro.total,
        impuestos: 0, // Sin IVA: no somos responsables. Ver cabecera y obligaciones §2.
        total: cobro.total,
        estado: 'pendiente',
        pasarela: suscripcion.pasarela,
    };

    // Factura y detalle juntos: un total sin sus líneas no se puede explicar al cliente.
    const propia = txExterna ? null : await sequelize.transaction();
    const tx = txExterna ?? propia;
    let factura;
    try {
        factura = yaExiste
            ? await Dao.actualizarFactura(
                  yaExiste.id_factura,
                  {
                      ...campos,
                      fecha_pago: null,
                      comision_pasarela: 0,
                      retencion_declarada: 0,
                      neto_recibido: null,
                      nota: null,
                  },
                  { transaction: tx }
              )
            : await Dao.crearFactura(campos, { transaction: tx });
        await Dao.reemplazarDetalleFactura(factura.id_factura, cobro.lineas, { transaction: tx });
        if (propia) await propia.commit();
    } catch (err) {
        // La transacción ajena la deshace quien la abrió: aquí solo se propaga el error.
        if (propia) await propia.rollback();
        throw err;
    }

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'factura_generada',
        idNegocio,
        detalle: {
            referencia,
            periodo_inicio: periodoInicio,
            periodo_fin: periodoFin,
            total: cobro.total,
            lineas: cobro.lineas.length,
        },
        transaction: txExterna ?? undefined,
    });

    return { factura, ya_existia: false };
}

/**
 * Lo que se cobra en un período: el plan más cada complemento contratado, con sus líneas.
 *
 * **Único sitio donde se decide un total.** Lo usan la generación de facturas (alta y
 * renovación) y el recálculo de una factura pendiente; si cada uno sumara por su lado, el día
 * que se añada un complemento nuevo uno lo cobraría y el otro no.
 *
 * Todo a precio de hoy, igual que el plan siempre se ha cobrado. Un complemento contratado que
 * perdió su precio en la moneda de la suscripción NO se cobra a cero ni se omite en silencio:
 * falla, porque cualquiera de las dos cosas es regalar o esconder algo.
 */
/** Unidades regaladas por el super-admin. Se conservan cuando el cliente sube o baja cantidad. */
function cortesiaDe(complemento) {
    return Math.max(
        0,
        Number(complemento.cantidad ?? 0) - Number(complemento.cantidad_facturable ?? complemento.cantidad ?? 0)
    );
}

/** Lo contratado de un complemento contando lo pedido y aún no pagado. */
function cantidadObjetivo(complemento) {
    return complemento.cantidad_solicitada == null
        ? Number(complemento.cantidad ?? 0)
        : Number(complemento.cantidad_solicitada);
}

/** Lo que se cobraría de un complemento con lo pedido aplicado, respetando la cortesía. */
function facturableObjetivo(complemento) {
    return Math.max(0, cantidadObjetivo(complemento) - cortesiaDe(complemento));
}

async function calcularCobro(suscripcion, idPlan, { transaction } = {}) {
    const moneda = suscripcion.moneda;
    const ciclo = suscripcion.ciclo;

    // El precio del aplicativo del negocio (Reserva no paga lo mismo que Restaurante).
    const precioPlan = await Dao.getPrecio(
        { idPlan, moneda, ciclo, idNegocio: suscripcion.id_negocio },
        { transaction }
    );
    const plan = await Models.GenerPlan.findByPk(idPlan, { attributes: ['nombre'], transaction });
    const complementos = await Dao.listarComplementosSuscripcion(
        suscripcion.id_suscripcion,
        { moneda, ciclo },
        { transaction }
    );

    const lineas = [
        {
            tipo: 'plan',
            id_plan: idPlan,
            descripcion: plan?.nombre ?? 'Plan',
            cantidad: 1,
            precio_unitario: precioPlan,
            subtotal: precioPlan,
        },
    ];

    for (const c of complementos) {
        // Lo que se cobra es `cantidad_facturable`, no lo contratado: la diferencia es cortesía
        // del super-admin y el cliente la usa sin pagarla. Un complemento entero de cortesía no
        // genera línea — una línea de cero en la factura solo invita a preguntar por qué está.
        //
        // Y si hay un cambio pedido y no pagado, la renovación cobra LO PEDIDO: el período que
        // se está cobrando es justo aquel en el que ese cambio entra en vigor. La cortesía se
        // conserva en unidades, así que quien tenía 5 gratis de 8 y pide 10 sigue con 5 gratis.
        const facturable = facturableObjetivo(c);
        if (facturable <= 0) continue;

        if (c.precio == null) {
            throw error(
                `El complemento «${c.nombre}» no tiene precio en ${moneda}/${ciclo}.`,
                'PRECIO_COMPLEMENTO_NO_CONFIGURADO',
                409
            );
        }
        lineas.push({
            tipo: 'complemento',
            id_complemento: c.id_complemento,
            descripcion: c.nombre,
            cantidad: facturable,
            precio_unitario: c.precio,
            subtotal: c.precio * facturable,
        });
    }

    const total = lineas.reduce((suma, l) => suma + l.subtotal, 0);
    return { lineas, total };
}

/**
 * Vuelve a calcular una factura **pendiente** con lo que la suscripción tiene hoy.
 *
 * Existe por la compra desde la web: quien abandona el checkout y vuelve puede haber cambiado de
 * plan o de complementos, pero `generarFacturaPeriodo` es idempotente por referencia y le
 * devolvería la factura vieja con el total viejo. Una factura pagada, fallida o anulada no se
 * toca nunca: es un documento cerrado.
 */
async function recalcularFacturaPendiente(idFactura) {
    const transaction = await sequelize.transaction();
    try {
        const factura = await Models.CobFactura.findByPk(idFactura, {
            transaction,
            lock: transaction.LOCK.UPDATE,
        });
        if (!factura || factura.estado !== 'pendiente') {
            await transaction.rollback();
            return factura;
        }

        const suscripcion = await Dao.exigirSuscripcion(factura.id_negocio, { transaction });
        const idPlan = suscripcion.id_plan_solicitado || suscripcion.id_plan;
        const cobro = await calcularCobro(suscripcion, idPlan, { transaction });

        setAuditNegocio(factura.id_negocio);
        const actualizada = await Dao.actualizarFactura(
            idFactura,
            { id_plan: idPlan, subtotal: cobro.total, total: cobro.total, pasarela: suscripcion.pasarela },
            { transaction }
        );
        await Dao.reemplazarDetalleFactura(idFactura, cobro.lineas, { transaction });
        await transaction.commit();

        if (Number(factura.total) !== cobro.total) {
            await Audit.registrarEvento({
                modulo: 'cobranza',
                accion: 'factura_recalculada',
                idNegocio: factura.id_negocio,
                detalle: { referencia: factura.referencia, antes: Number(factura.total), ahora: cobro.total },
            });
        }
        return actualizada;
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

/**
 * Aplica un pago aprobado: marca la factura, extiende el acceso y pone la suscripción al día.
 *
 * **Es el único sitio donde un pago se convierte en días de servicio**, y por eso lo comparten
 * el pago manual y el que confirma la pasarela por webhook. Duplicar estas quince líneas era la
 * forma segura de que dentro de un mes el webhook extendiera el plan y el manual no —o al revés—
 * y de que nadie lo notara hasta que un cliente se quede fuera del sistema habiendo pagado.
 *
 * Asume que quien llama ya tomó el `FOR UPDATE` de la factura y validó su estado.
 */
async function aplicarPagoAprobado(factura, suscripcion, datos, transaction) {
    const total = Number(factura.total);
    const comision = Number(datos.comision_pasarela ?? 0);
    const retencion = Number(datos.retencion_declarada ?? 0);

    if (comision < 0 || retencion < 0) {
        throw error('La comisión y la retención no pueden ser negativas.', 'MONTO_INVALIDO', 422);
    }
    if (comision + retencion > total) {
        throw error(
            'La comisión más la retención no pueden superar el total facturado.',
            'MONTO_INVALIDO',
            422
        );
    }

    setAuditNegocio(factura.id_negocio);
    const fechaPago = datos.fecha_pago ? new Date(datos.fecha_pago) : new Date();

    // ── La renovación se calcula AL PAGAR, desde el vencimiento real del plan ──
    //
    // Regla del dueño (2026-09-15): un pago compra UN ciclo que se suma a la fecha de vencimiento,
    // no al día del pago. Antes el pago extendía hasta el fin del período fijado al GENERAR la
    // factura, y esa fecha envejece: el cobro automático sale 5 días antes de vencer, y quien
    // pagaba tarde quedaba con un período que ya no correspondía. La factura guarda abajo el
    // período que de verdad compró. Detalle de la regla en `calcularRenovacion`.
    const plan = await Dao.planParaRenovar(factura.id_negocio, { transaction });

    // Un AJUSTE no compra tiempo: cobra la diferencia por subir de plan a mitad de ciclo. Sumarle
    // un ciclo sería regalar un mes por pagar unos pocos miles de pesos. La vigencia se queda
    // exactamente donde está; lo que cambia es QUÉ plan se disfruta hasta esa fecha.
    const esAjuste = factura.tipo === 'ajuste';
    const renovacion =
        esAjuste || (plan && !plan.fin)
            ? null // plan sin fecha de fin: no vence, y un pago no debe ponerle fecha de corte
            : calcularRenovacion({ fin: plan?.fin ?? null, hoy: hoyBogota(), ciclo: suscripcion.ciclo });

    // El ajuste sí cambia el plan del negocio, aunque no mueva la fecha: se pagó por estrenarlo hoy.
    if (esAjuste && factura.id_plan && Number(factura.id_plan) !== Number(suscripcion.id_plan)) {
        await Dao.fijarVencimientoPlan(
            {
                idNegocio: factura.id_negocio,
                idNegocioPlan: plan?.id_negocio_plan ?? null,
                idPlan: Number(factura.id_plan),
                inicio: plan?.inicio ?? hoyBogota(),
                hasta: plan?.fin ? finDeDiaBogota(plan.fin) : null,
            },
            { transaction }
        );
    }

    if (renovacion) {
        await Dao.fijarVencimientoPlan(
            {
                idNegocio: factura.id_negocio,
                idNegocioPlan: plan?.id_negocio_plan ?? null,
                // El plan que queda en el negocio es el que COBRÓ esta factura, no el que tenga
                // la suscripción hoy: si el cliente eligió otro plan, esta factura es la que lo
                // pagó. Las facturas viejas (sin `id_plan`) caen al plan de la suscripción.
                idPlan: factura.id_plan || suscripcion.id_plan,
                inicio: renovacion.inicio,
                hasta: finDeDiaBogota(renovacion.fin),
            },
            { transaction }
        );
    }

    const actualizada = await Dao.actualizarFactura(
        factura.id_factura,
        {
            estado: 'pagada',
            fecha_pago: fechaPago,
            // El período que el pago compró de verdad, que puede no ser el estimado al generar.
            periodo_inicio: renovacion?.inicio ?? factura.periodo_inicio,
            periodo_fin: renovacion?.fin ?? factura.periodo_fin,
            comision_pasarela: comision,
            retencion_declarada: retencion,
            neto_recibido: total - comision - retencion,
            medio_pago_texto: datos.medio_pago_texto ?? factura.medio_pago_texto,
            numero_factura: datos.numero_factura ?? factura.numero_factura,
            cufe: datos.cufe ?? factura.cufe,
            nota: datos.nota ?? factura.nota,
        },
        { transaction }
    );

    // Quien ya cerró el intento pendiente de la pasarela (la conciliación) pide no duplicar la fila.
    if (!datos.omitir_registro_transaccion) {
        await Dao.registrarTransaccion(
            {
                id_factura: factura.id_factura,
                pasarela: factura.pasarela,
                estado: 'aprobada',
                id_externo: datos.id_externo ?? null,
                codigo_respuesta: datos.codigo_respuesta ?? 'CONFIRMACION_MANUAL',
                mensaje: datos.medio_pago_texto || 'Pago confirmado.',
                payload: { referencia: factura.referencia, confirmado_en: fechaPago.toISOString() },
            },
            { transaction }
        );
    }

    // Quien paga vuelve a estar al día: se sale de gracia/suspensión y se limpian reintentos. El
    // próximo cobro automático, si lo hay, es el día siguiente al vencimiento que acaba de comprar.
    const finCubierto = renovacion?.fin ?? String(factura.periodo_fin).slice(0, 10);
    const adaptador = getAdaptador(suscripcion.pasarela);
    // Si esta factura cobró el plan que el cliente había elegido, ese plan pasa a ser el suyo y la
    // solicitud se limpia. Es el único momento en que el cambio de plan se hace efectivo: elegirlo
    // no basta, hay que pagarlo.
    const cumplioSolicitud =
        suscripcion.id_plan_solicitado &&
        Number(suscripcion.id_plan_solicitado) === Number(factura.id_plan);

    await Dao.actualizarSuscripcion(
        suscripcion.id_suscripcion,
        {
            estado: 'activa',
            reintentos: 0,
            proximo_cobro:
                adaptador.soportaRecurrente && !suscripcion.es_retenedor ? sumarDia(finCubierto) : null,
            ...(cumplioSolicitud
                ? { id_plan: Number(factura.id_plan), id_plan_solicitado: null }
                : {}),
        },
        { transaction }
    );

    // Y los complementos que estaban pedidos y sin pagar entran ahora, por el mismo motivo que el
    // plan: el pago es lo que los hace efectivos. Vale para los dos tipos de factura — el ajuste
    // los estrena a mitad de ciclo y la renovación los estrena con el período nuevo.
    await Dao.aplicarComplementosSolicitados(suscripcion.id_suscripcion, { transaction });

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'pago_registrado',
        idNegocio: factura.id_negocio,
        detalle: {
            referencia: factura.referencia,
            origen: datos.origen ?? 'manual',
            total,
            comision,
            retencion,
            neto: total - comision - retencion,
            medio: datos.medio_pago_texto ?? null,
            vencia: plan?.fin ?? null,
            plan_hasta: renovacion ? renovacion.fin : 'sin vencimiento',
        },
        transaction,
    });

    return actualizada;
}

/**
 * Carga la factura con bloqueo y comprueba que se pueda cobrar. Devuelve `{ factura,
 * suscripcion }` o lanza el error tipado que corresponda.
 *
 * El `FOR UPDATE` no es decorativo: sin él, el webhook de la pasarela y el clic del
 * administrador pueden confirmar el mismo pago a la vez y extender el plan dos veces.
 */
async function cargarFacturaCobrable(idFactura, transaction) {
    const factura = await Dao.getFactura(idFactura, { transaction, lock: true });
    if (!factura) throw error('Factura no encontrada.', 'FACTURA_NO_ENCONTRADA', 404);

    if (factura.estado === 'pagada') {
        throw error(`La factura ${factura.referencia} ya está pagada.`, 'FACTURA_YA_PAGADA', 409);
    }
    if (factura.estado === 'anulada') {
        throw error(`La factura ${factura.referencia} está anulada.`, 'FACTURA_ANULADA', 409);
    }

    const suscripcion = await Models.CobSuscripcion.findByPk(factura.id_suscripcion, { transaction });
    if (!suscripcion) throw error('Suscripción no encontrada.', 'SUSCRIPCION_NO_ENCONTRADA', 404);

    return { factura, suscripcion };
}

/**
 * Confirma un pago que entró por transferencia. Es la operación más delicada del módulo: o pasa
 * entera o no pasa nada.
 *
 * `retencion` y `comision` se teclean, no se calculan: la retención la practica el cliente y
 * solo se sabe mirando lo que consignó (obligaciones §3).
 */
async function registrarPagoManual(idFactura, datos) {
    const transaction = await sequelize.transaction();
    try {
        const { factura, suscripcion } = await cargarFacturaCobrable(idFactura, transaction);
        const actualizada = await aplicarPagoAprobado(
            factura,
            suscripcion,
            {
                ...datos,
                origen: 'manual',
                medio_pago_texto: datos.medio_pago_texto || 'Pago confirmado por un administrador.',
            },
            transaction
        );
        await transaction.commit();
        return actualizada;
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

/**
 * Cobra una factura por su pasarela. Es lo que llama el cron (y el botón «reintentar»).
 *
 * Los tres desenlaces posibles se tratan distinto, y la diferencia importa:
 *
 *   - **aprobada**  → se aplica el pago y el cliente sigue trabajando.
 *   - **pendiente** → la pasarela aceptó el cobro pero el dinero no ha entrado (checkout
 *     alojado, PSE). La factura NO se toca: la cerrará el webhook. Devolver aquí un «pagado»
 *     optimista es exactamente cómo se regalan meses de servicio.
 *   - **rechazada** → se anota el intento y sube el contador de reintentos (dunning).
 *
 * Un fallo de RED no es un rechazo: si la llamada revienta, la factura se queda pendiente y se
 * reintenta. Dar por rechazado lo que quizá se cobró es peor que esperar un día.
 */
async function cobrarFactura(idFactura, { usarMetodoGuardado = true, urlRetorno = null } = {}) {
    const transaction = await sequelize.transaction();
    let factura;
    let suscripcion;
    try {
        ({ factura, suscripcion } = await cargarFacturaCobrable(idFactura, transaction));
        await transaction.commit();
    } catch (err) {
        await transaction.rollback();
        throw err;
    }

    const adaptador = getAdaptadorListo(factura.pasarela);
    const negocio = await Models.GenerNegocio.findByPk(factura.id_negocio, {
        attributes: ['email_contacto'],
    });
    // `usarMetodoGuardado = false` es lo que usa el portal de pagos: sin token no hay débito, y
    // la pasarela abre checkout. Sin este flag, saberse la cédula de un cliente bastaría para
    // cargarle un cobro a su tarjeta guardada.
    const metodo =
        usarMetodoGuardado && suscripcion.id_metodo_pago
            ? await Models.CobMetodoPago.findByPk(suscripcion.id_metodo_pago)
            : null;

    const resultado = await adaptador.cobrar({
        referencia: factura.referencia,
        monto: Number(factura.total),
        moneda: factura.moneda,
        pais: await paisDeNegocio(factura.id_negocio),
        token: metodo?.token_externo ?? null,
        email: negocio?.email_contacto ?? undefined,
        descripcion: `EscalApp ${factura.referencia}`,
        urlRetorno,
    });

    setAuditNegocio(factura.id_negocio);

    await Dao.registrarTransaccion({
        id_factura: factura.id_factura,
        pasarela: factura.pasarela,
        estado: resultado.estado,
        id_externo: resultado.idExterno,
        codigo_respuesta: resultado.codigoRespuesta,
        mensaje: resultado.mensaje,
        payload: resultado.payload ?? null,
    });

    if (resultado.estado === 'aprobada') {
        const t2 = await sequelize.transaction();
        try {
            const recargada = await cargarFacturaCobrable(factura.id_factura, t2);
            const pagada = await aplicarPagoAprobado(
                recargada.factura,
                recargada.suscripcion,
                {
                    origen: factura.pasarela,
                    id_externo: resultado.idExterno,
                    codigo_respuesta: resultado.codigoRespuesta,
                    medio_pago_texto: `Cobro automático (${factura.pasarela})`,
                },
                t2
            );
            await t2.commit();
            return { estado: 'aprobada', factura: pagada, urlPago: null };
        } catch (err) {
            await t2.rollback();
            throw err;
        }
    }

    if (resultado.estado === 'rechazada') {
        await registrarIntentoFallido(suscripcion, factura, resultado);
        return { estado: 'rechazada', factura, urlPago: null, mensaje: resultado.mensaje };
    }

    return {
        estado: 'pendiente',
        factura,
        urlPago: resultado.urlPago ?? null,
        // El id de la transacción viaja al frontend para poder confirmar la vuelta del checkout.
        // Wompi devuelve `?id=` en la URL de retorno, pero dLocal NO devuelve nada: sin esto, el
        // cliente vuelve y no hay forma de saber qué pago consultar.
        idExterno: resultado.idExterno ?? null,
        mensaje: resultado.mensaje,
    };
}

/**
 * Un cobro que la pasarela rechaza. Sube el contador y, pasado el límite, degrada la suscripción.
 *
 * El orden importa y es deliberado: **primero gracia, después suspensión**. Cortarle la caja a
 * un restaurante el viernes por una tarjeta vencida no cobra la deuda, pierde al cliente.
 */
async function registrarIntentoFallido(suscripcion, factura, resultado) {
    const reintentos = Number(suscripcion.reintentos ?? 0) + 1;
    const limite = Number(process.env.COBRANZA_MAX_REINTENTOS || 3);

    // Regla fija del proyecto: id_negocio=6 es cliente pagador y no se suspende nunca.
    const protegido = Number(factura.id_negocio) === 6;
    const estado = reintentos >= limite && !protegido ? 'suspendida' : 'en_gracia';

    await Dao.actualizarSuscripcion(suscripcion.id_suscripcion, {
        estado,
        reintentos,
        // Se reintenta cada 3 días; el cron mira esta fecha.
        proximo_cobro: estado === 'en_gracia' ? sumarDias(hoyBogota(), 3) : null,
    });

    setAuditNegocio(factura.id_negocio);
    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: estado === 'suspendida' ? 'suscripcion_suspendida' : 'cobro_fallido',
        resultado: 'error',
        idNegocio: factura.id_negocio,
        detalle: {
            referencia: factura.referencia,
            reintentos,
            motivo: resultado?.mensaje ?? null,
            codigo: resultado?.codigoRespuesta ?? null,
        },
    });
}

/**
 * Anula una factura. No se borra: una factura emitida que desaparece es un agujero en la
 * conciliación y, si ya tenía número fiscal, un problema con la DIAN. Se marca y se explica.
 */
async function anularFactura(idFactura, { motivo }) {
    const factura = await Dao.getFactura(idFactura);
    if (!factura) throw error('Factura no encontrada.', 'FACTURA_NO_ENCONTRADA', 404);
    if (factura.estado === 'pagada') {
        throw error(
            'Una factura pagada no se anula: registre la devolución.',
            'FACTURA_YA_PAGADA',
            409
        );
    }

    setAuditNegocio(factura.id_negocio);
    const anulada = await Dao.actualizarFactura(idFactura, {
        estado: 'anulada',
        nota: motivo || factura.nota,
    });

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'factura_anulada',
        idNegocio: factura.id_negocio,
        detalle: { referencia: factura.referencia, motivo: motivo ?? null },
    });

    return anulada;
}

// ── Portal del cliente: consultar y pagar lo que se debe ────────────────────────────────

/**
 * Pasarelas con las que un negocio de este país puede pagar HOY: activas en la base **y** con
 * credenciales. Ofrecer un botón de dLocal sin llaves configuradas es mandar al cliente a un
 * error 503 justo cuando tiene la tarjeta en la mano.
 */
async function pasarelasParaPagar(pais) {
    const activas = await Dao.listarPasarelas({ pais });
    return activas
        .filter((p) => {
            const adaptador = getAdaptador(p.codigo);
            return adaptador.estaConfigurada ? adaptador.estaConfigurada() : true;
        })
        .map((p) => ({ ...p, recomendada: p.codigo === pasarelaRecomendada(pais) }))
        // La recomendada va PRIMERA: es la que debe encontrar el ojo, y en ambas vistas se pinta
        // de izquierda a derecha. El orden se decide aquí y no en cada frontend para que las dos
        // muestren lo mismo. `sort` es estable, así que el resto conserva el `orden` de la tabla.
        .sort((a, b) => Number(b.recomendada) - Number(a.recomendada));
}

/**
 * Cuál sugerir cuando hay más de una.
 *
 * En Colombia, Wompi: cobra en pesos, ofrece PSE y Nequi —que es como paga la mayoría de los
 * negocios de aquí— y su comisión es la que ya conocemos. Fuera de Colombia, dLocal Go, que es la
 * única que cobra en la moneda del país. La recomendación la calcula el BACKEND porque es el que
 * sabe el país del negocio; el frontend solo la pinta, y así no hay dos reglas que mantener.
 */
function pasarelaRecomendada(pais) {
    return pais === 'CO' ? 'wompi' : 'dlocal';
}

/**
 * A dónde devuelve la pasarela al cliente cuando termina de pagar.
 *
 * Son dos sitios distintos y la diferencia importa: quien paga desde el portal público vuelve al
 * portal, y quien paga con sesión iniciada vuelve a «Mis pagos» —**sin perder la sesión**, que es
 * lo que pasaba cuando ambos caían en `/pagar`—.
 *
 * `APP_FRONTEND_URL` es la base de la app **incluyendo el baseHref**: en producción la consola se
 * sirve bajo `/admin/` (Caddy la monta con `handle_path /admin/*`), así que vale
 * `https://escalapp.cloud/admin`. De ahí que «Mis pagos» quede en `/admin/mis-pagos` colgando de
 * esa base y termine en `…/admin/admin/mis-pagos`: feo, pero es la URL que de verdad resuelve.
 */
function urlRetornoDe(origen) {
    const base = (process.env.APP_FRONTEND_URL || '').replace(/\/+$/, '');
    if (!base) return process.env.COBRANZA_SUCCESS_URL || null;
    if (origen === 'app') return `${base}/admin/mis-pagos`;
    // La compra desde la web vuelve a su propia pantalla, que es la que confirma el pago y
    // enseña las credenciales. Mandarla a /pagar dejaba al comprador en el portal de cobros de
    // los clientes que ya existen, con un «pago confirmado» genérico y sin saber cómo entrar.
    if (origen === 'adquirir') return `${base}/adquirir`;
    return `${base}/pagar`;
}

/**
 * ¿Es este usuario ADMINISTRADOR de este negocio?
 *
 * No basta con estar en `gener_negocio_usuario`: un cajero también lo está, y enseñarle al cajero
 * la deuda del negocio —o dejarle pagarla— no es lo que nadie espera. Tiene que ser el rol.
 */
async function usuarioAdministraNegocio(idUsuario, idNegocio) {
    const filas = await sequelize.query(
        `SELECT 1
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          WHERE ur.id_usuario = :idUsuario
            AND ur.id_negocio = :idNegocio
            AND ur.estado = 'A'
            AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR'
          LIMIT 1;`,
        { replacements: { idUsuario, idNegocio }, type: sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

/**
 * Los negocios que administra un usuario, cada uno con sus facturas pendientes y los medios con
 * los que puede pagarlas. Es la fuente común de «Mis pagos» (con sesión) y del portal público.
 *
 * @param {object} [opciones]
 * @param {boolean} [opciones.incluirSinSuscripcion=false] «Mis pagos» los quiere TODOS: también el
 *        negocio que todavía no tiene suscripción de cobro, marcado `sin_plan: true` si además no
 *        tiene ningún plan vigente. El portal público no: solo cuenta a quien tiene algo que pagar,
 *        y para él la lista sigue siendo la de siempre.
 */
/** Los negocios activos en los que el usuario tiene el rol ADMINISTRADOR. */
async function negociosQueAdministra(idUsuario) {
    const filas = await sequelize.query(
        `SELECT DISTINCT ur.id_negocio
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r     ON r.id_rol = ur.id_rol AND r.estado = 'A'
           JOIN general.gener_negocio n ON n.id_negocio = ur.id_negocio AND n.estado = 'A'
          WHERE ur.id_usuario = :idUsuario
            AND ur.estado = 'A'
            AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR';`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT }
    );
    return filas.map((f) => Number(f.id_negocio));
}

async function cobrosDeUsuario(idUsuario, { incluirSinSuscripcion = false } = {}) {
    // Antes de mirar nada, se pone al día lo que el negocio deba: si su plan venció —o vence
    // dentro de la ventana— y no hay cobro, se genera aquí mismo. Esperar al cron de las 08:00
    // dejaba al cliente con «aún no hay un cobro» justo cuando entraba a pagar.
    //
    // Va sobre los negocios que ADMINISTRA, leídos aparte y no de la consulta de abajo: esa cruza
    // `cob_suscripcion` y deja fuera precisamente a los que todavía no la tienen, que son los que
    // nunca verían un cobro. `asegurarCobroPendiente` se la estrena.
    const administrados = (await negociosQueAdministra(idUsuario)).map((id_negocio) => ({ id_negocio }));
    for (const { id_negocio } of administrados) {
        await asegurarCobroPendiente(id_negocio);
    }

    const negocios = await sequelize.query(
        `SELECT DISTINCT n.id_negocio, n.nombre AS negocio, n.pais, s.id_suscripcion, s.estado,
                s.moneda, s.ciclo, s.id_plan, p.nombre AS plan,
                s.id_plan_solicitado, ps.nombre AS plan_solicitado
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r        ON r.id_rol = ur.id_rol AND r.estado = 'A'
           JOIN general.gener_negocio n    ON n.id_negocio = ur.id_negocio AND n.estado = 'A'
           LEFT JOIN cobranza.cob_suscripcion s ON s.id_negocio = n.id_negocio
           LEFT JOIN general.gener_plan p       ON p.id_plan = s.id_plan
           LEFT JOIN general.gener_plan ps      ON ps.id_plan = s.id_plan_solicitado
          WHERE ur.id_usuario = :idUsuario
            AND ur.estado = 'A'
            AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR'
          ORDER BY n.nombre;`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT }
    ).then((filas) => (incluirSinSuscripcion ? filas : filas.filter((n) => n.id_suscripcion)));

    // La vigencia del PLAN, no el estado de la suscripción de cobro. Mostrar «Al día» a partir de
    // `cob_suscripcion.estado` era un error: esa columna sigue en 'activa' aunque el plan haya
    // vencido. La vigencia la calcula `planHelper`, la misma fuente que el dashboard y Negocios.
    const { getPlanesActivosPorNegocio } = require('../../app_core/helpers/planHelper');
    const vigencias = await getPlanesActivosPorNegocio(negocios.map((n) => n.id_negocio));

    const resultado = [];
    for (const n of negocios) {
        const v = vigencias.get(Number(n.id_negocio));

        // Sin suscripción de cobro no hay moneda ni ciclo guardados: se usan los del país, que son
        // los que tendría al crearla. Y «sin plan» es no tener NINGÚN plan vigente ni suscripción:
        // un negocio en su prueba de 7 días no tiene suscripción pero sí plan, y no es lo mismo.
        n.sin_plan = !n.id_suscripcion && !v;
        if (!n.id_suscripcion) {
            n.moneda = MONEDA_POR_PAIS[n.pais] || 'COP';
            n.ciclo = 'mensual';
            n.plan = v?.nombre ?? null;
        }
        delete n.id_suscripcion;
        delete n.pais;
        n.vigencia = v
            ? {
                  fecha_inicio: v.fecha_inicio,
                  fecha_fin: v.fecha_fin,
                  dias_restantes: v.dias_restantes,
                  estado: v.estado,
                  dias_gracia_restantes: v.dias_gracia_restantes,
                  fecha_limite_gracia: v.fecha_limite_gracia,
              }
            : null;

        const facturas = await Models.CobFactura.findAll({
            where: { id_negocio: n.id_negocio, estado: 'pendiente' },
            attributes: [
                'id_factura', 'referencia', 'periodo_inicio', 'periodo_fin', 'total', 'moneda',
                'tipo', 'id_plan',
            ],
            order: [['periodo_inicio', 'ASC']],
        });

        // Cada cobro dice QUÉ plan cobra y con qué líneas. Sin esto la pantalla titulaba el cobro
        // con el plan actual de la suscripción, y un cliente que acababa de pedir el Avanzado veía
        // «Plan Básico · $59.999»: el nombre de un plan con el precio de otro.
        const detalladas = [];
        for (const f of facturas) {
            const json = f.toJSON();
            const plan = json.id_plan
                ? await Models.GenerPlan.findByPk(json.id_plan, { attributes: ['nombre'] })
                : null;
            detalladas.push({
                ...json,
                total: Number(json.total),
                plan: plan?.nombre ?? n.plan,
                lineas: await Dao.listarDetalleFactura(json.id_factura),
            });
        }

        resultado.push({
            ...n,
            facturas: detalladas,
            // Lo que tiene contratado y lo que dejó pedido, para que la pantalla pueda pintar el
            // estado real («tienes 2 usuarios extra, pediste 4») sin una segunda consulta.
            complementos: await getComplementosNegocio(n.id_negocio),
            pasarelas: await pasarelasParaPagar(await paisDeNegocio(n.id_negocio)),
            // Los planes entre los que puede elegir, con su precio en su moneda. La prueba de
            // 7 días no está: no se elige ni se paga, se asigna al registrar el negocio.
            planes: await Dao.listarPlanesParaCliente({
                moneda: n.moneda,
                ciclo: n.ciclo,
                idNegocio: n.id_negocio,
            }),
        });
    }
    return resultado;
}

/**
 * Inicia el pago de una factura con la pasarela que eligió el cliente.
 *
 * ⚠️ **Nunca debita un medio guardado**: siempre abre checkout. Esta función la llaman el portal
 * público —donde basta una cédula— y «Mis pagos»; si usara la tarjeta guardada, conocer la cédula
 * de un cliente bastaría para cargarle un cobro. El débito automático es cosa del cron, y solo.
 */
async function iniciarPago(idFactura, { pasarela, origen = 'publico' }) {
    const factura = await Dao.getFactura(idFactura);
    if (!factura || factura.estado !== 'pendiente') {
        throw error('No encontramos un cobro pendiente con esos datos.', 'COBRO_NO_DISPONIBLE', 404);
    }

    const disponibles = await pasarelasParaPagar(await paisDeNegocio(factura.id_negocio));
    if (!disponibles.some((p) => p.codigo === pasarela)) {
        throw error('Ese medio de pago no está disponible.', 'PASARELA_NO_DISPONIBLE_PAIS', 409);
    }

    setAuditNegocio(factura.id_negocio);
    if (factura.pasarela !== pasarela) {
        await Dao.actualizarFactura(idFactura, { pasarela });
    }

    const base = {
        pasarela,
        referencia: factura.referencia,
        total: Number(factura.total),
        moneda: factura.moneda,
    };

    if (pasarela === 'manual') {
        return {
            ...base,
            estado: 'pendiente',
            urlPago: null,
            instrucciones:
                process.env.COBRANZA_INSTRUCCIONES_TRANSFERENCIA ||
                'Escríbenos para recibir los datos de la transferencia. Usa la referencia como descripción del pago.',
        };
    }

    const r = await cobrarFactura(idFactura, {
        usarMetodoGuardado: false,
        urlRetorno: urlRetornoDe(origen),
    });
    return {
        ...base,
        estado: r.estado,
        urlPago: r.urlPago ?? null,
        idExterno: r.idExterno ?? null,
        mensaje: r.mensaje ?? null,
    };
}

/** «RESTAURANTE CHAYANE» → «RES******** CHA****». El dueño lo reconoce; un curioso, no del todo. */
function enmascararNombre(nombre) {
    return String(nombre || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((palabra) => (palabra.length <= 3 ? palabra : palabra.slice(0, 3) + '*'.repeat(palabra.length - 3)))
        .join(' ');
}

async function usuarioPorIdentificacion(identificacion) {
    return Models.GenerUsuario.findOne({
        where: { num_identificacion: String(identificacion).trim(), estado: 'A' },
        attributes: ['id_usuario'],
    });
}

/** Solo los últimos 4 dígitos: la auditoría necesita distinguir consultas, no guardar cédulas. */
function identificacionParaAuditoria(identificacion) {
    const limpia = String(identificacion).trim();
    return `***${limpia.slice(-4)}`;
}

/**
 * Consulta pública por cédula.
 *
 * Misma forma de respuesta exista o no la cédula —una lista, quizá vacía—, para no confirmarle a
 * nadie quién es cliente nuestro. Y solo lo imprescindible para pagar: nada de correos, teléfonos
 * ni fechas del plan.
 */
async function consultarPublico(identificacion, { ip } = {}) {
    const usuario = await usuarioPorIdentificacion(identificacion);
    const cobros = usuario ? (await cobrosDeUsuario(usuario.id_usuario)).filter((c) => c.facturas.length) : [];

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'consulta_publica',
        ip,
        detalle: { identificacion: identificacionParaAuditoria(identificacion), resultados: cobros.length },
    });

    return cobros.map((c) => ({
        negocio: enmascararNombre(c.negocio),
        plan: c.plan,
        facturas: c.facturas.map((f) => ({
            referencia: f.referencia,
            periodo_inicio: f.periodo_inicio,
            periodo_fin: f.periodo_fin,
            total: f.total,
            moneda: f.moneda,
        })),
        pasarelas: c.pasarelas.map((p) => ({
            codigo: p.codigo,
            nombre: p.nombre,
            recomendada: Boolean(p.recomendada),
        })),
    }));
}

/**
 * Pago público. La cédula y la referencia tienen que casar: la factura debe ser de un negocio que
 * esa persona administra. Cualquier desajuste responde lo mismo que «no existe», a propósito.
 */
async function pagarPublico({ identificacion, referencia, pasarela, ip }) {
    const usuario = await usuarioPorIdentificacion(identificacion);
    const factura = usuario ? await Dao.getFacturaPorReferencia(referencia) : null;
    const autorizado =
        usuario && factura && (await usuarioAdministraNegocio(usuario.id_usuario, factura.id_negocio));

    if (!autorizado) {
        throw error('No encontramos un cobro pendiente con esos datos.', 'COBRO_NO_DISPONIBLE', 404);
    }

    // El evento se escribe DESPUÉS de iniciar el pago, con su desenlace. Antes se registraba
    // «pago_publico_iniciado» primero y un intento rechazado (pasarela inactiva) quedaba en la
    // auditoría como si hubiera arrancado: un rastro que miente es peor que no tener rastro.
    const detalle = { referencia, pasarela, identificacion: identificacionParaAuditoria(identificacion) };
    try {
        const resultado = await iniciarPago(factura.id_factura, { pasarela });
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_publico_iniciado',
            idNegocio: factura.id_negocio,
            ip,
            detalle: { ...detalle, estado: resultado.estado },
        });
        return resultado;
    } catch (err) {
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_publico_iniciado',
            resultado: 'error',
            idNegocio: factura.id_negocio,
            ip,
            detalle: { ...detalle, motivo: err.code ?? err.message },
        });
        throw err;
    }
}

// ── Generación automática de cobros ─────────────────────────────────────────────────────

/** Moneda con la que estrena su suscripción un negocio de cada país. */
const MONEDA_POR_PAIS = { CO: 'COP', CL: 'CLP' };

/**
 * Cuántos días antes del vencimiento se cobra. Es la ventana ÚNICA del módulo: la usan el cron,
 * la generación bajo demanda y la validación de «Generar cobro». Un solo número para que el botón
 * no pueda hacer nada que la automatización no fuera a hacer sola.
 */
const DIAS_ANTICIPACION_COBRO = 5;

/**
 * Se asegura de que un negocio tenga su cobro listo, si le toca. Se llama al CONSULTAR («Mis
 * pagos» y el portal público), no solo desde el cron.
 *
 * Existe porque el cron de las 08:00 no basta: si el super admin le pone hoy una fecha de
 * vencimiento pasada a un negocio, el cliente entraría a pagar y vería «aún no hay un cobro»
 * hasta el día siguiente (2026-09-15).
 *
 * También **estrena la suscripción** del negocio que no la tenga: la mitad de los negocios de la
 * base no la tienen, y sin ella la consulta de cobros ni siquiera los mira.
 *
 * Silenciosa por diseño: si no se puede generar —sin precio en su moneda, sin pasarela activa en
 * su país, suscripción cancelada— devuelve null y la consulta sigue. Una pantalla de pagos no se
 * cae porque falte configurar un precio.
 */
async function asegurarCobroPendiente(idNegocio) {
    try {
        const [plan] = await sequelize.query(
            `SELECT p.id_plan, to_char(p.fecha_fin::date, 'YYYY-MM-DD') AS fin, n.pais
               FROM general.gener_negocio n
               JOIN LATERAL (
                     SELECT id_plan, fecha_fin
                       FROM general.gener_negocio_plan
                      WHERE id_negocio = n.id_negocio AND estado = 'A'
                      ORDER BY fecha_fin DESC NULLS FIRST
                      LIMIT 1
               ) p ON true
              WHERE n.id_negocio = :idNegocio AND n.estado = 'A';`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
        );

        // Sin plan, o con un plan que no vence, no hay nada que cobrar.
        if (!plan?.fin) return null;
        if (plan.fin > sumarDias(hoyBogota(), DIAS_ANTICIPACION_COBRO)) return null;

        let suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
        if (!suscripcion) {
            const activas = await Dao.listarPasarelas({ pais: plan.pais || 'CO' });
            if (!activas.length) return null;
            suscripcion = await Dao.crearSuscripcion({
                id_negocio: idNegocio,
                id_plan: plan.id_plan,
                ciclo: 'mensual',
                moneda: MONEDA_POR_PAIS[plan.pais] || 'COP',
                pasarela: activas[0].codigo,
                estado: 'activa',
                notas: 'Creada al consultar los cobros del negocio.',
            });
        }
        if (suscripcion.estado === 'cancelada') return null;

        const pendiente = await Models.CobFactura.findOne({
            where: { id_negocio: idNegocio, estado: 'pendiente' },
            order: [['periodo_inicio', 'ASC']],
        });
        if (pendiente) return pendiente;

        const { factura } = await generarFacturaPeriodo(idNegocio);
        return factura;
    } catch (err) {
        const esperados = [
            'PLAN_VIGENTE',
            'PLAN_SIN_VENCIMIENTO',
            'PRECIO_NO_CONFIGURADO',
            'SUSCRIPCION_CANCELADA',
            'SUSCRIPCION_NO_ENCONTRADA',
            'FACTURA_DUPLICADA',
        ];
        if (!esperados.includes(err.code)) {
            console.warn(`[Cobranza/bajo-demanda] negocio ${idNegocio}: ${err.code || ''} ${err.message}`);
        }
        return null;
    }
}

/**
 * Genera el cobro de renovación de los negocios cuyo plan vence en `dias` días o menos.
 *
 * Lo llama la verificación diaria de vencimientos (`notificacionService`, 08:00 Bogotá) ANTES del
 * aviso de 5 días, para que el correo llegue con algo que pagar. Reemplaza al botón «Generar
 * cobro» como forma normal de cobrar; el botón queda para excepciones.
 *
 * ## Quién entra
 *
 * - **Negocio activo con plan activo que tenga fecha de fin.** Se mira el plan de MAYOR cobertura
 *   del negocio, no una fila cualquiera: hay planes con inicio futuro, y un plan sin fecha de fin
 *   (el que no vence) gana y deja al negocio fuera — no vence, no se le cobra.
 * - **Que vence entre hace 30 días y dentro de `dias`.** Los vencidos recientes entran para que
 *   puedan reactivarse pagando; los vencidos hace más de un mes no, para no llenar la cartera de
 *   cobros a pruebas abandonadas.
 * - **Sin ningún cobro pendiente.** Si ya debe algo, se le cobra eso y no se apila otro.
 *
 * ## Lo que arregla por el camino
 *
 * - El negocio **sin suscripción de cobro** la estrena aquí. Sin esto, todo negocio registrado
 *   después de la migración —los de prueba incluidos— no recibiría cobro nunca.
 * - Si el plan se cambió en Negocios, la suscripción **se pone al día con el plan vigente**: se
 *   cobra lo que el negocio tiene, no lo que tenía.
 *
 * Negocio a negocio y con try por negocio: que uno falle no deja sin cobrar a los demás.
 */
async function generarCobrosPorVencer({ dias = 5 } = {}) {
    const hoy = hoyBogota();

    const candidatos = await sequelize.query(
        `SELECT p.id_negocio, p.id_plan, n.pais,
                to_char(p.fecha_fin::date, 'YYYY-MM-DD') AS fin
           FROM general.gener_negocio n
           JOIN LATERAL (
                 SELECT id_negocio, id_plan, fecha_fin
                   FROM general.gener_negocio_plan
                  WHERE id_negocio = n.id_negocio AND estado = 'A'
                  ORDER BY fecha_fin DESC NULLS FIRST
                  LIMIT 1
           ) p ON true
          WHERE n.estado = 'A'
            AND p.fecha_fin IS NOT NULL
            AND p.fecha_fin::date BETWEEN (:hoy::date - 30) AND (:hoy::date + :dias::int)
            AND NOT EXISTS (
                  SELECT 1 FROM cobranza.cob_factura f
                   WHERE f.id_negocio = n.id_negocio AND f.estado = 'pendiente'
            )
          ORDER BY p.fecha_fin ASC;`,
        { replacements: { hoy, dias }, type: sequelize.QueryTypes.SELECT }
    );

    let generados = 0;
    let existentes = 0;
    let omitidos = 0;

    for (const c of candidatos) {
        try {
            let suscripcion = await Dao.getSuscripcionPorNegocio(c.id_negocio);

            if (!suscripcion) {
                const activas = await Dao.listarPasarelas({ pais: c.pais || 'CO' });
                if (!activas.length) {
                    omitidos += 1;
                    console.warn(
                        `[Cobranza/auto] negocio ${c.id_negocio}: no hay pasarela activa para ${c.pais}.`
                    );
                    continue;
                }
                suscripcion = await Dao.crearSuscripcion({
                    id_negocio: c.id_negocio,
                    id_plan: c.id_plan,
                    ciclo: 'mensual',
                    moneda: MONEDA_POR_PAIS[c.pais] || 'COP',
                    pasarela: activas[0].codigo,
                    estado: 'activa',
                    notas: 'Creada por la generación automática de cobros.',
                });
            } else if (
                Number(suscripcion.id_plan) !== Number(c.id_plan) &&
                !suscripcion.id_plan_solicitado
            ) {
                // Se pone al día con el plan vigente del negocio… salvo que el cliente haya
                // elegido otro y aún no lo pague: esa elección es justamente lo que hay que cobrar,
                // y sincronizar aquí la borraría cada madrugada.
                suscripcion = await Dao.actualizarSuscripcion(suscripcion.id_suscripcion, {
                    id_plan: c.id_plan,
                });
            }

            if (suscripcion.estado === 'cancelada') {
                omitidos += 1;
                continue;
            }

            const { ya_existia } = await generarFacturaPeriodo(c.id_negocio);
            if (ya_existia) existentes += 1;
            else generados += 1;
        } catch (err) {
            // Otro proceso la generó en el mismo instante (dos backends contra la misma base): la
            // referencia UNIQUE lo frenó, y el resultado es el que se quería.
            if (err.code === 'FACTURA_DUPLICADA') {
                existentes += 1;
                continue;
            }
            omitidos += 1;
            console.warn(`[Cobranza/auto] negocio ${c.id_negocio}: ${err.code || ''} ${err.message}`);
        }
    }

    return { revisados: candidatos.length, generados, existentes, omitidos };
}

// ── Renovación ──────────────────────────────────────────────────────────────────────────

/**
 * El período que compra un pago. Regla del dueño (2026-09-15):
 *
 *   - **El ciclo se suma a la fecha de vencimiento, no al día del pago.** Vence el 10-sep, paga
 *     el 15 (dentro de la gracia) → queda hasta el 10-oct. Los días de gracia no se regalan, y
 *     pagar por adelantado no hace perder días.
 *   - **Un pago es UN ciclo**, sin importar cuántos meses tuvo el plan al contratarse.
 *   - **Si ese ciclo ya no alcanza a cubrir hoy** —pagó tanto después de vencer que el mes
 *     comprado ya pasó— arranca el día del pago. Anclado al vencimiento, pagaría y seguiría vencido.
 *
 * El fin es el mismo día del ciclo siguiente, recortado al último día del mes cuando no existe:
 * el mismo criterio de `resolverVigencia` (negocioDao) y de `vigencia.ts` en la consola.
 *
 * Se usa en los dos momentos: al generar el cobro (como estimación) y al pagarlo (el definitivo).
 *
 * @param {{ fin: string|null, hoy: string, ciclo: 'mensual'|'anual' }} p — días 'YYYY-MM-DD'.
 *        `fin` null = no hay nada cubierto: el ciclo arranca hoy.
 * @returns {{ inicio: string, fin: string }}
 */
function calcularRenovacion({ fin, hoy, ciclo }) {
    if (fin) {
        const nuevoFin = sumarCiclo(fin, ciclo);
        if (nuevoFin >= hoy) return { inicio: sumarDia(fin), fin: nuevoFin };
    }
    return { inicio: hoy, fin: sumarCiclo(hoy, ciclo) };
}

// ── Cambios de plan y complementos ──────────────────────────────────────────────────────
//
// La regla, en una línea: **subir se paga y entra hoy; bajar no se cobra y entra al renovar.**
//
// Subir a mitad de ciclo no cobra un mes entero —el cliente ya pagó el suyo— sino la diferencia
// por los días que le quedan. Y no mueve el vencimiento: no compró otro mes, mejoró el actual.
// Bajar no devuelve dinero: ese mes está pagado y lo sigue usando hasta el final.
//
// Lo elegido NUNCA se aplica al elegirlo: vive en `id_plan_solicitado` y `cantidad_solicitada`
// hasta que un pago lo confirma. Aplicarlo antes sería regalarlo.

/** Referencia de un cobro de ajuste: `EA-<negocio>-<AAAAMM>-A<n>`. La de renovación es sin `-A`. */
function construirReferenciaAjuste(idNegocio, hoy, intento) {
    return `${construirReferencia(idNegocio, hoy)}-A${intento}`;
}

/**
 * Lo que vale al mes una configuración concreta: un plan más unos complementos.
 *
 * Es la única cuenta que decide si un cambio es subida o bajada. Se calcula con los precios de
 * hoy, los mismos que cobrará la renovación.
 */
async function precioMensual({ suscripcion, idPlan, complementos, catalogo }) {
    // Un plan sin precio en esta moneda vale cero aquí, y no es un error: es el caso de la prueba
    // de 7 días. Cualquier plan pagado será «subir» frente a ella, que es justo lo que es.
    let precioPlan = 0;
    try {
        precioPlan = await Dao.getPrecio({
            idPlan,
            moneda: suscripcion.moneda,
            ciclo: suscripcion.ciclo,
            idNegocio: suscripcion.id_negocio,
        });
    } catch (err) {
        if (err.code !== 'PRECIO_NO_CONFIGURADO') throw err;
    }

    let total = Number(precioPlan);
    for (const [idComplemento, cantidad] of complementos) {
        const c = catalogo.find((x) => Number(x.id_complemento) === Number(idComplemento));
        if (!c || cantidad <= 0) continue;
        total += Number(c.precio) * cantidad;
    }
    return total;
}

/**
 * Lo que valdría al mes un plan con unos complementos, ANTES de guardarlos. Es la vista previa del
 * editor de negocios: no toca nada.
 *
 * Usa `precioMensual`, la misma cuenta que decide si un cambio sube o baja y la que cobrará la
 * renovación, y los precios del catálogo: así la pantalla no lleva su propia aritmética de
 * precios y no puede desviarse de lo que de verdad se cobra.
 *
 * Un negocio sin suscripción se calcula con la moneda de su país y ciclo mensual, que son los
 * que tendría al crearla. `idPlan` nulo = prueba o sin plan: el plan vale cero.
 *
 * @param {Array<{codigo: string, cantidad_facturable: number}>} complementos lo que SE COBRA
 * @returns {Promise<{moneda, ciclo, precio_plan, complementos, total}>}
 */
async function previsualizarTotalMensual(idNegocio, { idPlan = null, complementos = [] } = {}) {
    const suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
    const pais = await paisDeNegocio(idNegocio);
    const moneda = suscripcion?.moneda || MONEDA_POR_PAIS[pais] || 'COP';
    const ciclo = suscripcion?.ciclo || 'mensual';
    const catalogo = await Dao.listarComplementosCatalogo({ moneda, ciclo });

    const cobrados = new Map();
    const detalle = [];
    for (const item of complementos || []) {
        const codigo = String(item?.codigo ?? '').trim().toUpperCase();
        const c = catalogo.find((x) => x.codigo === codigo);
        if (!c) throw error(`El complemento ${codigo} no existe o no tiene precio.`, 'COMPLEMENTO_NO_DISPONIBLE', 422);

        const cantidad = Number(item.cantidad_facturable ?? 0);
        if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > c.cantidad_maxima) {
            throw error(
                `«${c.nombre}»: la cantidad debe estar entre 0 y ${c.cantidad_maxima}.`,
                'COMPLEMENTO_CANTIDAD',
                422
            );
        }
        if (cantidad > 0) cobrados.set(Number(c.id_complemento), cantidad);
        detalle.push({
            codigo: c.codigo,
            precio: Number(c.precio),
            cantidad_facturable: cantidad,
            subtotal: Number(c.precio) * cantidad,
        });
    }

    const sus = { moneda, ciclo, id_negocio: idNegocio };
    const [precioPlan, total] = await Promise.all([
        precioMensual({ suscripcion: sus, idPlan, complementos: new Map(), catalogo }),
        precioMensual({ suscripcion: sus, idPlan, complementos: cobrados, catalogo }),
    ]);

    return { moneda, ciclo, precio_plan: precioPlan, complementos: detalle, total };
}

/**
 * Qué parte del ciclo le queda al cliente, entre 0 y 1.
 *
 * Es lo que multiplica la diferencia de precio. Un plan que vence mañana casi no cobra nada al
 * subir; uno recién renovado cobra casi la diferencia completa. Sin vigencia conocida se cobra
 * la diferencia entera: es el caso del plan vencido, donde el ciclo entero está por delante.
 */
function proporcionRestante({ fin, hoy, ciclo }) {
    if (!fin || fin < hoy) return 1;

    const restantes = diasQueQuedan({ fin, hoy });
    const totales = Math.round((enMsUTC(sumarCiclo(hoy, ciclo)) - enMsUTC(hoy)) / 86_400_000);
    if (totales <= 0) return 1;
    return Math.max(0, Math.min(1, restantes / totales));
}

function enMsUTC(iso) {
    const { a, m, d } = partes(iso);
    return Date.UTC(a, m - 1, d);
}

/** Días que le quedan al plan contando el de fin. 0 si no hay vigencia. */
function diasQueQuedan({ fin, hoy }) {
    if (!fin || fin < hoy) return 0;
    return Math.round((enMsUTC(fin) - enMsUTC(hoy)) / 86_400_000) + 1;
}

/**
 * LA cuenta del prorrateo, sin tocar la base: lo que cuesta subir de `precioActual` a
 * `precioObjetivo` cuando al plan vigente le quedan los días hasta `fin`.
 *
 * La usan tanto el cobro real (`cobrarDiferenciaAhora`) como la simulación que ve el cliente antes
 * de confirmar (`simularCambioPlan`): así el monto que se muestra es EXACTAMENTE el que se cobra.
 * Se prorratea el TOTAL de la diferencia, no línea a línea: redondear cada línea por separado deja
 * un total que no cuadra con la suma que el cliente ve.
 */
function calcularDiferenciaCambio({ precioActual, precioObjetivo, fin, hoy, ciclo }) {
    const proporcion = proporcionRestante({ fin, hoy, ciclo });
    const diferencia = Math.round((precioObjetivo - precioActual) * proporcion);
    return { proporcion, diferencia, diasRestantes: diasQueQuedan({ fin, hoy }) };
}

/** Los complementos que el cliente tiene contratados hoy, como mapa id → cantidad. */
function mapaDeComplementos(lista, usar) {
    return new Map(lista.map((c) => [Number(c.id_complemento), usar(c)]));
}

/**
 * Lo que `cambiarMiPlan` necesita saber para decidir, SIN escribir nada: la única lectura del
 * cambio pedido. La comparten el cambio de verdad y la simulación (`simularCambioPlan`), para que
 * ninguna de las dos pueda entender distinto lo que el cliente pidió.
 *
 * Lanza los mismos errores tipados de validación que el cambio real.
 */
async function resolverCambio(idNegocio, suscripcion, { idPlan, complementos }) {
    if (suscripcion.estado === 'cancelada') {
        throw error(
            'La suscripción está cancelada: escríbenos para reactivarla.',
            'SUSCRIPCION_CANCELADA',
            409
        );
    }

    const moneda = suscripcion.moneda;
    const ciclo = suscripcion.ciclo;
    const disponibles = await Dao.listarPlanesParaCliente({ moneda, ciclo, idNegocio });
    const catalogo = await Dao.listarComplementosCatalogo({ moneda, ciclo });
    const contratados = await Dao.listarComplementosSuscripcion(suscripcion.id_suscripcion, {
        moneda,
        ciclo,
    });

    // ── El plan objetivo ──
    const idPlanActual = Number(suscripcion.id_plan);
    const idPlanObjetivo = idPlan == null ? idPlanActual : Number(idPlan);
    const planObjetivo = disponibles.find((p) => Number(p.id_plan) === idPlanObjetivo);
    if (!planObjetivo && idPlanObjetivo !== idPlanActual) {
        throw error('Ese plan no está disponible para tu negocio.', 'PLAN_NO_DISPONIBLE', 409);
    }

    // ── Los complementos objetivo ──
    const actuales = mapaDeComplementos(contratados, (c) => Number(c.cantidad ?? 0));
    let objetivo;
    if (complementos == null) {
        // No los toca: sigue queriendo lo que ya pidió, o lo que tiene.
        objetivo = mapaDeComplementos(contratados, cantidadObjetivo);
    } else {
        objetivo = new Map();
        for (const item of complementos) {
            const codigo = String(item?.codigo ?? '').trim().toUpperCase();
            const c = catalogo.find((x) => x.codigo === codigo);
            if (!c) {
                throw error(
                    `El complemento ${codigo} no existe o no está disponible en tu moneda.`,
                    'COMPLEMENTO_NO_DISPONIBLE',
                    422
                );
            }
            const cantidad = Number(item.cantidad ?? 0);
            if (!Number.isInteger(cantidad) || cantidad < 0 || cantidad > c.cantidad_maxima) {
                throw error(
                    `«${c.nombre}»: la cantidad debe estar entre 0 y ${c.cantidad_maxima}.`,
                    'COMPLEMENTO_CANTIDAD',
                    422
                );
            }
            if (cantidad > 0) objetivo.set(Number(c.id_complemento), cantidad);
        }
        // Lo que tiene y no viene en la lista se entiende como «quítamelo».
        for (const id of actuales.keys()) if (!objetivo.has(id)) objetivo.set(id, 0);
    }

    // ── ¿Cambia algo de verdad? ──
    const mismoPlan = idPlanObjetivo === idPlanActual;
    const mismosComplementos = [...new Set([...actuales.keys(), ...objetivo.keys()])].every(
        (id) => (actuales.get(id) ?? 0) === (objetivo.get(id) ?? 0)
    );


    const cambia = !(mismoPlan && mismosComplementos);
    let precioActual = null;
    let precioObjetivo = null;
    if (cambia) {
        [precioActual, precioObjetivo] = await Promise.all([
            precioMensual({ suscripcion, idPlan: idPlanActual, complementos: actuales, catalogo }),
            precioMensual({ suscripcion, idPlan: idPlanObjetivo, complementos: objetivo, catalogo }),
        ]);
    }

    return {
        idPlanActual,
        idPlanObjetivo,
        planObjetivo,
        actuales,
        objetivo,
        catalogo,
        mismoPlan,
        mismosComplementos,
        cambia,
        precioActual,
        precioObjetivo,
        sube: cambia && precioObjetivo > precioActual,
    };
}

/**
 * El administrador del negocio cambia su plan, sus complementos, o los dos a la vez.
 *
 * Devuelve qué pasó, porque de eso depende lo que la pantalla tiene que decirle:
 *   - **`sin_cambios`**: pidió exactamente lo que ya tiene. Si había algo pedido sin pagar, se
 *     deshace — es la forma de cancelar una solicitud.
 *   - **`ajuste`**: sube. Hay un cobro nuevo por la diferencia prorrateada y el cambio entra
 *     cuando lo pague.
 *   - **`renovacion`**: baja (o cuesta lo mismo). No se cobra nada ahora y entra al renovar.
 *
 * @param {number|null} idPlan el plan que quiere. `null` = deja el que tiene.
 * @param {Array<{codigo: string, cantidad: number}>|null} complementos la elección COMPLETA.
 *        `null` = no toca los complementos.
 */
async function cambiarMiPlan(idNegocio, { idPlan = null, complementos = null } = {}) {
    // Sin suscripción de cobro no hay nada que «cambiar»: lo que elige es su PRIMER plan.
    const existente = await Dao.getSuscripcionPorNegocio(idNegocio);
    if (!existente) return contratarPrimerPlan(idNegocio, { idPlan });
    const suscripcion = existente;

    const {
        idPlanActual,
        idPlanObjetivo,
        planObjetivo,
        objetivo,
        catalogo,
        mismoPlan,
        cambia,
        precioActual,
        precioObjetivo,
        sube,
    } = await resolverCambio(idNegocio, suscripcion, { idPlan, complementos });

    setAuditNegocio(idNegocio);

    if (!cambia) {
        return deshacerSolicitud(idNegocio, suscripcion);
    }

    // Lo pedido se anota en los dos casos; lo que cambia es cuándo y cómo se cobra.
    await Dao.actualizarSuscripcion(suscripcion.id_suscripcion, {
        id_plan_solicitado: mismoPlan ? null : idPlanObjetivo,
    });
    if (complementos != null) {
        await Dao.solicitarComplementosSuscripcion(
            suscripcion.id_suscripcion,
            idNegocio,
            [...objetivo].map(([id_complemento, cantidad]) => ({ id_complemento, cantidad }))
        );
    }

    // ¿Tiene un plan que esté disfrutando hoy? Solo entonces tiene sentido un ajuste aparte: se
    // cobra la parte de los días que le quedan. Sin plan vigente —compra web sin pagar, plan
    // vencido, en días de gracia— lo que añada va a la MISMA mensualidad que tiene que pagar
    // para volver a entrar. Un segundo cobro por separado le hacía pagar dos veces los mismos
    // complementos (la renovación ya cobra lo pedido) y no se entendía cuál pagar primero.
    const planNegocio = await Dao.planParaRenovar(idNegocio);
    const planVigente = !!planNegocio && (!planNegocio.fin || planNegocio.fin >= hoyBogota());

    const resultado = !planVigente
        ? await sumarAlCobroPendiente({ idNegocio, precioObjetivo })
        : sube
        ? await cobrarDiferenciaAhora({
              idNegocio,
              suscripcion,
              idPlanObjetivo,
              planObjetivo,
              objetivo,
              catalogo,
              precioActual,
              precioObjetivo,
          })
        : await agendarParaLaRenovacion({ idNegocio, precioObjetivo });

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: !planVigente
            ? 'cambio_plan_en_cobro_pendiente'
            : sube
            ? 'cambio_plan_ajuste'
            : 'cambio_plan_agendado',
        idNegocio,
        detalle: {
            id_plan_anterior: idPlanActual,
            id_plan_solicitado: mismoPlan ? null : idPlanObjetivo,
            complementos: [...objetivo].map(([id, cantidad]) => ({ id_complemento: id, cantidad })),
            precio_actual: precioActual,
            precio_objetivo: precioObjetivo,
            referencia: resultado.referencia ?? null,
            total: resultado.total ?? null,
        },
    });

    return resultado;
}

/**
 * Qué pasaría si el cliente guardara este cambio, SIN hacerlo: ni transacción de escritura, ni
 * factura, ni anotar lo pedido. Lo que devuelve es lo que `cambiarMiPlan` cobraría después, porque
 * usa la misma resolución (`resolverCambio`) y la misma cuenta (`calcularDiferenciaCambio`).
 *
 * `total` solo viene cuando hay un cobro de ajuste que anunciar; en los demás casos es `null` y la
 * pantalla se queda con su texto sin monto.
 */
async function simularCambioPlan(idNegocio, { idPlan = null, complementos = null } = {}) {
    const suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
    if (!suscripcion) {
        return { aplica: 'primer_plan', total: null, moneda: null, dias_restantes: 0, proporcion_restante: null };
    }

    const r = await resolverCambio(idNegocio, suscripcion, { idPlan, complementos });
    const base = { total: null, moneda: suscripcion.moneda, dias_restantes: 0, proporcion_restante: null };
    if (!r.cambia) return { ...base, aplica: 'sin_cambios' };

    const plan = await Dao.planParaRenovar(idNegocio);
    const hoy = hoyBogota();
    const planVigente = !!plan && (!plan.fin || plan.fin >= hoy);
    // Igual que cambiarMiPlan: sin plan vigente o bajando, no hay ajuste que cobrar hoy.
    if (!planVigente || !r.sube) return { ...base, aplica: 'renovacion' };

    const { proporcion, diferencia, diasRestantes } = calcularDiferenciaCambio({
        precioActual: r.precioActual,
        precioObjetivo: r.precioObjetivo,
        fin: plan?.fin ?? null,
        hoy,
        ciclo: suscripcion.ciclo,
    });
    // Una diferencia que se queda en nada entra con la renovación (ver cobrarDiferenciaAhora).
    if (diferencia <= 0) return { ...base, aplica: 'renovacion' };

    return {
        aplica: 'ajuste',
        total: diferencia,
        moneda: suscripcion.moneda,
        dias_restantes: diasRestantes,
        proporcion_restante: Number(proporcion.toFixed(4)),
    };
}

/**
 * El negocio que aún no tiene suscripción de cobro elige su primer plan desde «Mis pagos».
 *
 * Es lo mismo que hace el alta desde la web (`adquirirService.prepararFactura`): crea la
 * suscripción con el plan elegido y genera la factura del primer ciclo desde hoy. El plan se
 * activa cuando esa factura se paga, no antes. Solo entra por aquí quien HOY recibiría
 * `SUSCRIPCION_NO_ENCONTRADA`, así que no cambia nada para quien ya tenía suscripción.
 *
 * Los complementos no se piden en este paso: se ajustan después, cuando ya hay un plan.
 */
async function contratarPrimerPlan(idNegocio, { idPlan }) {
    if (idPlan == null) {
        throw error('Elige el plan que quieres contratar.', 'PLAN_REQUERIDO', 422);
    }

    const pais = await paisDeNegocio(idNegocio);
    const moneda = MONEDA_POR_PAIS[pais] || 'COP';
    const ciclo = 'mensual';
    const disponibles = await Dao.listarPlanesParaCliente({ moneda, ciclo, idNegocio });
    const plan = disponibles.find((p) => Number(p.id_plan) === Number(idPlan));
    if (!plan) {
        throw error('Ese plan no está disponible para tu negocio.', 'PLAN_NO_DISPONIBLE', 409);
    }

    setAuditNegocio(idNegocio);

    // Suscripción, factura y evento de auditoría en UNA transacción: si cualquiera falla no queda
    // una suscripción sin cobro (con ella, «cambiar plan» diría «eso es lo que ya tienes» y el
    // negocio se quedaría sin poder pagar nunca). Ninguno de los tres habla con la pasarela: el
    // checkout se abre después, cuando el cliente pulsa «Pagar».
    const transaction = await sequelize.transaction();
    try {
        await configurarSuscripcion(
            idNegocio,
            {
                id_plan: plan.id_plan,
                ciclo,
                moneda,
                notas: 'Primer plan elegido desde Mis pagos.',
            },
            { transaction }
        );
        // `desde: hoy` salta las guardas de la renovación —no hay plan que vencer— y factura el
        // primer ciclo a partir de hoy, igual que el alta desde la web.
        const { factura } = await generarFacturaPeriodo(idNegocio, {
            desde: hoyBogota(),
            transaction,
        });

        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'primer_plan_elegido',
            idNegocio,
            detalle: { id_plan: plan.id_plan, referencia: factura.referencia, total: Number(factura.total) },
            transaction,
        });

        await transaction.commit();

        return {
            aplica: 'primer_plan',
            cambio: true,
            mensaje: `Listo: te generamos el cobro del ${plan.nombre}. Págalo para activarlo.`,
            referencia: factura.referencia,
            total: Number(factura.total),
        };
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

/** Cancela lo pedido y no pagado, y devuelve el cobro pendiente a lo que el cliente tiene hoy. */
async function deshacerSolicitud(idNegocio, suscripcion) {
    const habiaAlgo =
        suscripcion.id_plan_solicitado != null ||
        (await Dao.listarComplementosSuscripcion(suscripcion.id_suscripcion, {
            moneda: suscripcion.moneda,
            ciclo: suscripcion.ciclo,
        })).some((c) => c.cantidad_solicitada != null);

    if (!habiaAlgo) {
        return { aplica: 'sin_cambios', cambio: false, mensaje: 'Eso es justo lo que ya tienes.' };
    }

    await Dao.actualizarSuscripcion(suscripcion.id_suscripcion, { id_plan_solicitado: null });
    await Dao.limpiarComplementosSolicitados(suscripcion.id_suscripcion);
    // El ajuste sin pagar deja de tener sentido: cobraba un cambio que ya no se quiere.
    await anularAjustesPendientes(idNegocio);
    await recalcularPendienteDeRenovacion(idNegocio);

    return {
        aplica: 'sin_cambios',
        cambio: true,
        mensaje: 'Se canceló el cambio pendiente: sigues con lo que tienes hoy.',
    };
}

/** Los cobros de ajuste sin pagar se anulan al cambiar de idea: cobraban otra cosa. */
async function anularAjustesPendientes(idNegocio, { motivo = 'Cambio de plan cancelado' } = {}) {
    const abiertos = await Models.CobFactura.findAll({
        where: { id_negocio: idNegocio, estado: 'pendiente', tipo: 'ajuste' },
    });
    for (const f of abiertos) {
        await Dao.actualizarFactura(f.id_factura, { estado: 'anulada', nota: motivo });
    }
    return abiertos.length;
}

/** La renovación pendiente, si la hay, pasa a cobrar lo que el cliente acaba de pedir. */
async function recalcularPendienteDeRenovacion(idNegocio) {
    const pendiente = await Models.CobFactura.findOne({
        where: { id_negocio: idNegocio, estado: 'pendiente', tipo: 'renovacion' },
        order: [['periodo_inicio', 'ASC']],
    });
    if (pendiente) await recalcularFacturaPendiente(pendiente.id_factura);
    return pendiente;
}

/**
 * Sube de plan o añade complementos: se cobra **solo la diferencia de los días que faltan**.
 *
 * El cobro es de tipo `ajuste`, y eso es lo que impide que pagarlo regale un mes: al aplicarse,
 * el plan y los complementos entran, pero la fecha de vencimiento no se mueve.
 */
async function cobrarDiferenciaAhora({
    idNegocio,
    suscripcion,
    idPlanObjetivo,
    planObjetivo,
    objetivo,
    catalogo,
    precioActual,
    precioObjetivo,
}) {
    const hoy = hoyBogota();
    const plan = await Dao.planParaRenovar(idNegocio);
    const { proporcion, diferencia } = calcularDiferenciaCambio({
        precioActual,
        precioObjetivo,
        fin: plan?.fin ?? null,
        hoy,
        ciclo: suscripcion.ciclo,
    });

    // Una diferencia que se queda en nada —quedan horas de ciclo— no se cobra: emitir un cobro de
    // 200 pesos cuesta más en comisión que lo que recauda. Entra con la renovación.
    if (diferencia <= 0) {
        return agendarParaLaRenovacion({ idNegocio, precioObjetivo });
    }

    const lineas = [];
    if (planObjetivo && Number(planObjetivo.id_plan) !== Number(suscripcion.id_plan)) {
        lineas.push({
            tipo: 'plan',
            id_plan: idPlanObjetivo,
            descripcion: `Cambio a ${planObjetivo.nombre} (parte proporcional)`,
            cantidad: 1,
            precio_unitario: diferencia,
            subtotal: diferencia,
        });
    } else {
        lineas.push({
            tipo: 'complemento',
            id_complemento: [...objetivo.keys()][0] ?? null,
            descripcion: 'Complementos añadidos (parte proporcional)',
            cantidad: 1,
            precio_unitario: diferencia,
            subtotal: diferencia,
        });
    }

    // Se anula el ajuste anterior sin pagar: el cliente cambió de idea antes de pagarlo, y dos
    // cobros abiertos por el mismo cambio es la forma de que pague dos veces.
    await anularAjustesPendientes(idNegocio, { motivo: 'Reemplazado por un ajuste nuevo' });

    // La referencia lleva un contador porque en un mismo mes puede haber varios ajustes.
    let referencia = null;
    for (let intento = 1; intento <= 20 && !referencia; intento += 1) {
        const candidata = construirReferenciaAjuste(idNegocio, hoy, intento);
        if (!(await Dao.getFacturaPorReferencia(candidata))) referencia = candidata;
    }
    if (!referencia) {
        throw error('No se pudo generar el cobro del cambio. Inténtalo más tarde.', 'AJUSTE_SIN_REFERENCIA', 409);
    }

    const transaction = await sequelize.transaction();
    try {
        const factura = await Dao.crearFactura(
            {
                id_suscripcion: suscripcion.id_suscripcion,
                id_negocio: idNegocio,
                id_plan: idPlanObjetivo,
                tipo: 'ajuste',
                referencia,
                // El ajuste cubre lo que queda del ciclo en curso: ni compra ni extiende nada.
                periodo_inicio: hoy,
                periodo_fin: plan?.fin && plan.fin >= hoy ? plan.fin : hoy,
                moneda: suscripcion.moneda,
                subtotal: diferencia,
                impuestos: 0,
                total: diferencia,
                estado: 'pendiente',
                pasarela: suscripcion.pasarela,
                nota: 'Diferencia por el cambio de plan, proporcional a los días que faltan.',
            },
            { transaction }
        );
        await Dao.reemplazarDetalleFactura(factura.id_factura, lineas, { transaction });
        await transaction.commit();

        return {
            aplica: 'ajuste',
            cambio: true,
            referencia: factura.referencia,
            id_factura: factura.id_factura,
            total: diferencia,
            moneda: suscripcion.moneda,
            precio_mensual: precioObjetivo,
            proporcion_restante: Number(proporcion.toFixed(4)),
            mensaje:
                'Paga la diferencia y el cambio queda activo de inmediato, sin mover tu fecha de vencimiento.',
        };
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        throw err;
    }
}

/** Baja de plan o quita complementos: nada que cobrar hoy; entra en la próxima renovación. */
async function agendarParaLaRenovacion({ idNegocio, precioObjetivo }) {
    // Si ya había un ajuste abierto por una subida anterior, deja de valer.
    await anularAjustesPendientes(idNegocio, { motivo: 'Reemplazado por un cambio agendado' });
    const pendiente = await recalcularPendienteDeRenovacion(idNegocio);

    return {
        aplica: 'renovacion',
        cambio: true,
        referencia: pendiente?.referencia ?? null,
        total: pendiente ? Number(pendiente.total) : null,
        precio_mensual: precioObjetivo,
        mensaje: pendiente
            ? 'El cambio entra cuando pagues tu próximo cobro, que ya quedó con el valor nuevo.'
            : 'El cambio entra en tu próxima renovación. Hasta entonces conservas lo que pagaste.',
    };
}

/**
 * Sin plan vigente: el cambio (suba o baje) se suma a la mensualidad que tiene que pagar.
 *
 * No hay «días que le quedan» que prorratear: el próximo pago compra un ciclo entero, y ese
 * ciclo ya es el del plan y los complementos nuevos. Si todavía no existe el cobro pendiente
 * —plan vencido hace poco y nadie lo ha generado— se genera aquí, ya con lo pedido.
 */
async function sumarAlCobroPendiente({ idNegocio, precioObjetivo }) {
    await anularAjustesPendientes(idNegocio, { motivo: 'Sumado a la mensualidad pendiente' });

    let pendiente = await recalcularPendienteDeRenovacion(idNegocio);
    if (!pendiente) {
        const generado = await asegurarCobroPendiente(idNegocio);
        if (generado) pendiente = await recalcularFacturaPendiente(generado.id_factura);
    }

    return {
        aplica: 'renovacion',
        cambio: true,
        referencia: pendiente?.referencia ?? null,
        total: pendiente ? Number(pendiente.total) : null,
        precio_mensual: precioObjetivo,
        mensaje: pendiente
            ? 'Lo sumamos a tu mensualidad pendiente: al pagarla, tu plan se activa con el cambio.'
            : 'El cambio quedó guardado y entra con tu próximo pago.',
    };
}

/**
 * Compatibilidad: «elegir plan» es un cambio de plan sin tocar complementos.
 *
 * Se conserva el nombre porque es el que usan las rutas y la documentación del módulo.
 */
function elegirPlan(idNegocio, idPlan) {
    return cambiarMiPlan(idNegocio, { idPlan });
}

module.exports = {
    previsualizarTotalMensual,
    getResumenNegocio,
    generarCobrosPorVencer,
    asegurarCobroPendiente,
    calcularRenovacion,
    elegirPlan,
    cambiarMiPlan,
    simularCambioPlan,
    calcularDiferenciaCambio,
    proporcionRestante,
    listarCartera,
    resumenIngresos,
    configurarSuscripcion,
    getComplementosNegocio,
    fijarComplementosNegocio,
    generarFacturaPeriodo,
    calcularCobro,
    recalcularFacturaPendiente,
    registrarPagoManual,
    cobrarFactura,
    anularFactura,
    cobrosDeUsuario,
    negociosQueAdministra,
    usuarioAdministraNegocio,
    iniciarPago,
    consultarPublico,
    pagarPublico,
    // Para el servicio de webhooks: confirmar un pago que anunció la pasarela recorre
    // exactamente el mismo camino que confirmarlo a mano.
    _interno: { cargarFacturaCobrable, aplicarPagoAprobado, registrarIntentoFallido },
    // Exportadas para las pruebas: son aritmética de calendario con casos borde feos.
    _fechas: { sumarCiclo, diaAnterior, sumarDia, sumarDias, construirReferencia, hoyBogota },
};
