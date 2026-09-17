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
async function configurarSuscripcion(idNegocio, datos) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, { attributes: ['id_negocio'] });
    if (!negocio) throw error('Negocio no encontrado.', 'NEGOCIO_NO_ENCONTRADO', 404);

    const pais = await paisDeNegocio(idNegocio);
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

    const existente = await Dao.getSuscripcionPorNegocio(idNegocio);

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
        const actualizada = await Dao.actualizarSuscripcion(existente.id_suscripcion, campos);
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'suscripcion_actualizada',
            idNegocio,
            detalle: { id_suscripcion: existente.id_suscripcion, ...campos },
        });
        return actualizada;
    }

    const creada = await Dao.crearSuscripcion({ id_negocio: idNegocio, estado: 'activa', ...campos });
    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'suscripcion_creada',
        idNegocio,
        detalle: { id_suscripcion: creada.id_suscripcion, ...campos },
    });
    return creada;
}

// ── Facturación ─────────────────────────────────────────────────────────────────────────

/**
 * La última factura que cuenta: la de período más reciente que no esté anulada. Anular es
 * justamente decir «ese período no cuenta», así que no cierra el paso a rehacerlo.
 */
async function ultimaFactura(idNegocio) {
    const [fila] = await sequelize.query(
        `SELECT id_factura, periodo_fin, estado
           FROM cobranza.cob_factura
          WHERE id_negocio = :idNegocio AND estado <> 'anulada'
          ORDER BY periodo_fin DESC
          LIMIT 1;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
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
async function generarFacturaPeriodo(idNegocio, { desde = null } = {}) {
    const suscripcion = await Dao.exigirSuscripcion(idNegocio);

    if (suscripcion.estado === 'cancelada') {
        throw error(
            'La suscripción está cancelada: no se pueden generar cobros nuevos.',
            'SUSCRIPCION_CANCELADA',
            409
        );
    }

    const ultima = await ultimaFactura(idNegocio);
    const hoy = hoyBogota();

    // El plan de MAYOR cobertura del negocio: el mismo que renueva un pago.
    const [plan] = await sequelize.query(
        `SELECT to_char(fecha_fin::date, 'YYYY-MM-DD') AS fin
           FROM general.gener_negocio_plan
          WHERE id_negocio = :idNegocio AND estado = 'A'
          ORDER BY fecha_fin DESC NULLS FIRST
          LIMIT 1;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
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
        const vigente = await Dao.getFactura(ultima.id_factura);
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
    const yaExiste = await Dao.getFacturaPorReferencia(referencia);
    if (yaExiste && yaExiste.estado !== 'anulada') return { factura: yaExiste, ya_existia: true };

    // El plan que se cobra es el que el cliente ELIGIÓ, si eligió uno y aún no lo ha pagado.
    // `id_plan` de la suscripción sigue siendo el que tiene contratado hoy: cambiarlo antes de
    // cobrar sería regalarle el plan nuevo.
    const idPlanACobrar = suscripcion.id_plan_solicitado || suscripcion.id_plan;
    const precio = await Dao.getPrecio({
        idPlan: idPlanACobrar,
        moneda: suscripcion.moneda,
        ciclo: suscripcion.ciclo,
    });

    setAuditNegocio(idNegocio);

    const campos = {
        id_suscripcion: suscripcion.id_suscripcion,
        id_negocio: idNegocio,
        id_plan: idPlanACobrar,
        referencia,
        periodo_inicio: periodoInicio,
        periodo_fin: periodoFin,
        moneda: suscripcion.moneda,
        subtotal: precio,
        impuestos: 0, // Sin IVA: no somos responsables. Ver cabecera y obligaciones §2.
        total: precio,
        estado: 'pendiente',
        pasarela: suscripcion.pasarela,
    };
    const factura = yaExiste
        ? await Dao.actualizarFactura(yaExiste.id_factura, {
              ...campos,
              fecha_pago: null,
              comision_pasarela: 0,
              retencion_declarada: 0,
              neto_recibido: null,
              nota: null,
          })
        : await Dao.crearFactura(campos);

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'factura_generada',
        idNegocio,
        detalle: { referencia, periodo_inicio: periodoInicio, periodo_fin: periodoFin, total: precio },
    });

    return { factura, ya_existia: false };
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
    const renovacion =
        plan && !plan.fin
            ? null // plan sin fecha de fin: no vence, y un pago no debe ponerle fecha de corte
            : calcularRenovacion({ fin: plan?.fin ?? null, hoy: hoyBogota(), ciclo: suscripcion.ciclo });

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
    return origen === 'app' ? `${base}/admin/mis-pagos` : `${base}/pagar`;
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
 */
async function cobrosDeUsuario(idUsuario) {
    // Antes de mirar nada, se pone al día lo que el negocio deba: si su plan venció —o vence
    // dentro de la ventana— y no hay cobro, se genera aquí mismo. Esperar al cron de las 08:00
    // dejaba al cliente con «aún no hay un cobro» justo cuando entraba a pagar.
    //
    // Va sobre los negocios que ADMINISTRA, leídos aparte y no de la consulta de abajo: esa cruza
    // `cob_suscripcion` y deja fuera precisamente a los que todavía no la tienen, que son los que
    // nunca verían un cobro. `asegurarCobroPendiente` se la estrena.
    const administrados = await sequelize.query(
        `SELECT DISTINCT ur.id_negocio
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r     ON r.id_rol = ur.id_rol AND r.estado = 'A'
           JOIN general.gener_negocio n ON n.id_negocio = ur.id_negocio AND n.estado = 'A'
          WHERE ur.id_usuario = :idUsuario
            AND ur.estado = 'A'
            AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR';`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT }
    );
    for (const { id_negocio } of administrados) {
        await asegurarCobroPendiente(id_negocio);
    }

    const negocios = await sequelize.query(
        `SELECT DISTINCT n.id_negocio, n.nombre AS negocio, s.estado, s.moneda, s.ciclo,
                s.id_plan, p.nombre AS plan,
                s.id_plan_solicitado, ps.nombre AS plan_solicitado
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r        ON r.id_rol = ur.id_rol AND r.estado = 'A'
           JOIN general.gener_negocio n    ON n.id_negocio = ur.id_negocio AND n.estado = 'A'
           JOIN cobranza.cob_suscripcion s ON s.id_negocio = n.id_negocio
           JOIN general.gener_plan p       ON p.id_plan = s.id_plan
           LEFT JOIN general.gener_plan ps ON ps.id_plan = s.id_plan_solicitado
          WHERE ur.id_usuario = :idUsuario
            AND ur.estado = 'A'
            AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR'
          ORDER BY n.nombre;`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT }
    );

    // La vigencia del PLAN, no el estado de la suscripción de cobro. Mostrar «Al día» a partir de
    // `cob_suscripcion.estado` era un error: esa columna sigue en 'activa' aunque el plan haya
    // vencido. La vigencia la calcula `planHelper`, la misma fuente que el dashboard y Negocios.
    const { getPlanesActivosPorNegocio } = require('../../app_core/helpers/planHelper');
    const vigencias = await getPlanesActivosPorNegocio(negocios.map((n) => n.id_negocio));

    const resultado = [];
    for (const n of negocios) {
        const v = vigencias.get(Number(n.id_negocio));
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
            attributes: ['id_factura', 'referencia', 'periodo_inicio', 'periodo_fin', 'total', 'moneda'],
            order: [['periodo_inicio', 'ASC']],
        });
        resultado.push({
            ...n,
            facturas: facturas.map((f) => ({ ...f.toJSON(), total: Number(f.total) })),
            pasarelas: await pasarelasParaPagar(await paisDeNegocio(n.id_negocio)),
            // Los planes entre los que puede elegir, con su precio en su moneda. La prueba de
            // 7 días no está: no se elige ni se paga, se asigna al registrar el negocio.
            planes: await Dao.listarPlanesParaCliente({ moneda: n.moneda, ciclo: n.ciclo }),
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

/**
 * El administrador del negocio elige su plan.
 *
 * Dos casos, y el resultado dice cuál fue:
 *   - **`ahora`**: hay un cobro pendiente (plan vencido, o la renovación ya generada). Ese cobro
 *     pasa a valer el plan nuevo, así que pagarlo estrena plan.
 *   - **`proximo_cobro`**: está al día y no debe nada. El plan nuevo se cobrará en la próxima
 *     mensualidad; hasta entonces conserva el que pagó.
 *
 * **Elegir no cambia el plan del negocio**: se guarda como `id_plan_solicitado` y solo se hace
 * efectivo al pagar (`aplicarPagoAprobado`). Cambiarlo aquí sería dárselo gratis.
 *
 * Los planes gratuitos no se pueden elegir: `listarPlanesParaCliente` filtra `precio > 0`, así que
 * la prueba de 7 días —que se asigna al registrar el negocio— no aparece ni se acepta.
 */
async function elegirPlan(idNegocio, idPlan) {
    const suscripcion = await Dao.exigirSuscripcion(idNegocio);

    if (suscripcion.estado === 'cancelada') {
        throw error(
            'La suscripción está cancelada: escríbenos para reactivarla.',
            'SUSCRIPCION_CANCELADA',
            409
        );
    }

    const disponibles = await Dao.listarPlanesParaCliente({
        moneda: suscripcion.moneda,
        ciclo: suscripcion.ciclo,
    });
    const elegido = disponibles.find((p) => Number(p.id_plan) === Number(idPlan));
    if (!elegido) {
        throw error(
            'Ese plan no está disponible para tu negocio.',
            'PLAN_NO_DISPONIBLE',
            409
        );
    }

    const actual = suscripcion.id_plan_solicitado || suscripcion.id_plan;
    if (Number(actual) === Number(idPlan)) {
        throw error('Ya tienes ese plan seleccionado.', 'PLAN_SIN_CAMBIO', 409);
    }

    setAuditNegocio(idNegocio);

    // El cobro pendiente más viejo es el que el cliente va a pagar: se le cambia el plan y el
    // monto. Si no hay ninguno, el cambio entra en el cobro que se genere la próxima vez.
    const pendiente = await Models.CobFactura.findOne({
        where: { id_negocio: idNegocio, estado: 'pendiente' },
        order: [['periodo_inicio', 'ASC']],
    });

    if (pendiente) {
        await Dao.actualizarFactura(pendiente.id_factura, {
            id_plan: elegido.id_plan,
            subtotal: elegido.precio,
            total: elegido.precio,
        });
    }

    await Dao.actualizarSuscripcion(suscripcion.id_suscripcion, {
        id_plan_solicitado: elegido.id_plan,
    });

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'plan_solicitado',
        idNegocio,
        detalle: {
            id_plan_anterior: suscripcion.id_plan,
            id_plan_solicitado: elegido.id_plan,
            plan: elegido.nombre,
            precio: elegido.precio,
            factura: pendiente?.referencia ?? null,
        },
    });

    return {
        aplica: pendiente ? 'ahora' : 'proximo_cobro',
        id_plan_solicitado: elegido.id_plan,
        plan_solicitado: elegido.nombre,
        total: elegido.precio,
        moneda: elegido.moneda,
        referencia: pendiente?.referencia ?? null,
    };
}

module.exports = {
    getResumenNegocio,
    generarCobrosPorVencer,
    asegurarCobroPendiente,
    calcularRenovacion,
    elegirPlan,
    listarCartera,
    resumenIngresos,
    configurarSuscripcion,
    generarFacturaPeriodo,
    registrarPagoManual,
    cobrarFactura,
    anularFactura,
    cobrosDeUsuario,
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
