/**
 * Procesamiento de webhooks de pasarela. Ver `docs/cobro-mensualidades.md` §3.5.
 *
 * ## Las cuatro reglas, y por qué cada una
 *
 * 1. **Verificar la firma antes de mirar el contenido.** Sin esto, cualquiera con un `curl`
 *    activa planes gratis. Un evento con firma inválida se guarda igual —una ráfaga de ellos es
 *    la señal de que alguien está probando la puerta— pero no se procesa.
 *
 * 2. **Guardar el evento y responder 200 rápido.** La pasarela reintenta si no recibe 200 (Wompi
 *    3 veces en 24 h; dLocal cada 10 minutos durante 30 días). Hacer el trabajo pesado antes de
 *    contestar convierte una lentitud en una avalancha de duplicados.
 *
 * 3. **La idempotencia la impone la base**, con el UNIQUE (pasarela, id_evento_externo), no un
 *    `if` que alguien pueda olvidar al refactorizar.
 *
 * 4. **No creerle al cuerpo del webhook: preguntar por el estado.** El evento dice «mira la
 *    transacción X»; el estado real se consulta a la API. Con dLocal es obligatorio (su
 *    notificación solo trae `payment_id`) y con Wompi es sano: un cuerpo manipulado que además
 *    lograra falsificar la firma seguiría sin poder mentir sobre el estado.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const Dao = require('../../app_core/dao/cobranzaDao');
const CobranzaService = require('./cobranzaService');
const AdquirirService = require('./adquirirService');
const MailService = require('./mailService');
const { getAdaptador } = require('../../app_core/cobranza');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');

const sequelize = Models.sequelize;

/**
 * Registra el evento. Devuelve `null` si ya estaba (entrega repetida), que es la señal de que no
 * hay que hacer nada más.
 */
async function registrarEvento({ pasarela, idEvento, tipo, firmaValida, payload }) {
    try {
        return await Models.CobEventoWebhook.create({
            pasarela,
            // Sin id propio, la marca de tiempo evita perder eventos por colisión de clave.
            id_evento_externo: idEvento || `sin-id:${Date.now()}`,
            tipo,
            firma_valida: firmaValida,
            payload,
        });
    } catch (err) {
        if (err?.name === 'SequelizeUniqueConstraintError') return null;
        throw err;
    }
}

async function marcarProcesado(idEvento, error = null) {
    await Models.CobEventoWebhook.update(
        { procesado_en: new Date(), error },
        { where: { id_evento: idEvento } }
    );
}

/** Encuentra la factura a la que se refiere el evento, por referencia o por id externo. */
async function buscarFactura({ referencia, idExterno, pasarela }) {
    // Los links de Wompi llevan sufijo por intento (`EA-17-202609-lx3k9a`), porque Wompi exige
    // referencia única por transacción. La factura se busca por la referencia BASE.
    const base = referencia ? (String(referencia).match(/^EA-\d+-\d{6}/) || [])[0] : null;
    if (base) {
        const porReferencia = await Dao.getFacturaPorReferencia(base);
        if (porReferencia) return porReferencia;
    }
    if (!idExterno) return null;

    // Sin referencia (el caso de dLocal), se llega por la transacción que sí guardamos.
    const [fila] = await sequelize.query(
        `SELECT id_factura
           FROM cobranza.cob_transaccion
          WHERE pasarela = :pasarela AND id_externo = :idExterno
          ORDER BY creado_en DESC
          LIMIT 1;`,
        { replacements: { pasarela, idExterno }, type: sequelize.QueryTypes.SELECT }
    );
    return fila ? Dao.getFactura(fila.id_factura) : null;
}

/**
 * Las vías por las que un pago aprobado puede llegar a aplicarse. Todas terminan en
 * `resolverEstadoReal`: no hay una segunda lógica de pago que se pueda desincronizar.
 *
 *   webhook          · Wompi/dLocal nos avisan (lo normal, pero Wompi no ha enviado NUNCA uno a producción)
 *   retorno          · el cliente vuelve del checkout con `?id=`
 *   al_iniciar_sesion· el admin concilia los pagos pendientes del usuario al iniciar sesión / abrir la app
 *   al_volver        · ídem al volver a la pestaña
 *   manual           · un super admin pega el id en «Verificar pago Wompi»
 */
const VIAS = ['webhook', 'retorno', 'al_iniciar_sesion', 'al_volver', 'manual'];

/** La referencia BASE de una referencia de intento: `EA-13-202609-mug6p57y` → `EA-13-202609`. */
function baseDeReferencia(referencia) {
    return referencia ? (String(referencia).match(/^EA-\d+-\d{6}/) || [])[0] ?? null : null;
}

/**
 * Alerta al super admin, a lo más UNA por tipo y por día: el mismo problema repetido no puede
 * inundar el buzón. El límite vive en la auditoría (sobrevive a reinicios) y no en memoria.
 * Nunca lanza: una alerta que falla no puede deshacer un pago ya aplicado.
 */
async function alertarSuperAdmin({ tipo, asunto, texto }) {
    try {
        const accion = `alerta_${tipo}`;
        const [ya] = await sequelize.query(
            `SELECT 1 AS ya FROM auditoria.audit_evento
              WHERE modulo = 'cobranza' AND accion = :accion AND fecha >= CURRENT_DATE
              LIMIT 1;`,
            { replacements: { accion }, type: sequelize.QueryTypes.SELECT }
        );
        if (ya) return { enviada: false, motivo: 'ya se alertó hoy' };

        await Audit.registrarEvento({ modulo: 'cobranza', accion, detalle: { asunto } });
        await MailService.sendAlertaAdminEmail({ asunto, texto });
        return { enviada: true };
    } catch (err) {
        console.error('[Cobranza] No se pudo alertar al super admin:', err.message);
        return { enviada: false, motivo: err.message };
    }
}

async function nombreDeNegocio(idNegocio) {
    const [fila] = await sequelize.query(
        `SELECT nombre FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
    );
    return fila?.nombre ?? `negocio ${idNegocio}`;
}

/** Las referencias de intento (con sufijo) que nosotros mismos abrimos para esta factura. */
async function referenciasDeIntentos(idFactura, pasarela, transaction) {
    const filas = await sequelize.query(
        `SELECT COALESCE(payload->>'reference', payload->>'order_id') AS referencia
           FROM cobranza.cob_transaccion
          WHERE id_factura = :idFactura AND pasarela = :pasarela
            AND COALESCE(payload->>'reference', payload->>'order_id') IS NOT NULL;`,
        { replacements: { idFactura, pasarela }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    return (filas || []).map((f) => f.referencia);
}

/**
 * ¿La transacción de la pasarela corresponde a ESTA factura? Devuelve `null` si sí, o el motivo.
 *
 *   - REFERENCIA: la base tiene que ser la de la factura y, si guardamos los intentos que
 *     abrimos, la referencia tiene que ser una de ellos. Con Wompi es obligatoria.
 *   - MONTO en centavos y MONEDA: tienen que venir y ser exactamente los de la factura. Cada
 *     pasarela expresa el monto a su manera (Wompi `amount_in_cents`, dLocal `amount` en
 *     unidades); una aprobación sin monto es una aprobación que no se puede verificar.
 */
function motivoDeDesajuste({ pasarela, factura, estadoReal, intentos = [] }) {
    const p = estadoReal.payload ?? {};
    const referencia = p.reference ?? p.order_id ?? null;

    if (referencia) {
        if (baseDeReferencia(referencia) !== baseDeReferencia(factura.referencia)) return 'referencia';
        if (intentos.length && !intentos.includes(String(referencia))) return 'referencia';
    } else if (pasarela === 'wompi') {
        return 'referencia';
    }

    const centavos =
        p.amount_in_cents != null
            ? Number(p.amount_in_cents)
            : p.amount != null
              ? Math.round(Number(p.amount) * 100)
              : null;
    const esperado = Math.round(Number(factura.total) * 100);
    if (centavos == null || centavos !== esperado) return 'monto';
    if (!p.currency || p.currency !== factura.moneda) return 'moneda';
    return null;
}

/**
 * Cierra el intento de pago (`cob_transaccion` pendiente) que corresponde a esta transacción de
 * la pasarela: por su referencia de intento o por su id externo. Devuelve cuántas filas cerró.
 */
async function cerrarIntento({ idFactura, pasarela, estadoReal, estado, mensaje = null, transaction }) {
    const p = estadoReal.payload ?? {};
    const referencia = p.reference ?? p.order_id ?? null;
    if (!referencia && !estadoReal.idExterno) return 0;

    const [, meta] =
        (await sequelize.query(
            `UPDATE cobranza.cob_transaccion
                SET estado = :estado,
                    id_externo = COALESCE(:idExterno, id_externo),
                    codigo_respuesta = COALESCE(:codigo, codigo_respuesta),
                    mensaje = COALESCE(:mensaje, mensaje)
              WHERE id_factura = :idFactura AND pasarela = :pasarela AND estado = 'pendiente'
                AND (COALESCE(payload->>'reference', payload->>'order_id') = :referencia
                     OR id_externo = :idExterno);`,
            {
                replacements: {
                    estado,
                    idFactura,
                    pasarela,
                    referencia,
                    idExterno: estadoReal.idExterno ?? null,
                    codigo: estadoReal.codigoRespuesta ?? null,
                    mensaje,
                },
                transaction,
            }
        )) || [];
    return meta?.rowCount ?? 0;
}

async function notificarDesajuste({ pasarela, factura, estadoReal, motivo, via }) {
    const negocio = await nombreDeNegocio(factura.id_negocio);
    await alertarSuperAdmin({
        tipo: 'pago_no_coincide',
        asunto: `[EscalApp] Pago de ${negocio} NO aplicado: no coincide (${motivo})`,
        texto:
            `${pasarela} aprobó la transacción ${estadoReal.idExterno ?? '(sin id)'} pero no coincide ` +
            `con la factura ${factura.referencia} de ${negocio} (${motivo}). No se aplicó nada. ` +
            `Revísalo a mano en el panel de ${pasarela}. Vía: ${via}.`,
    });
}

/**
 * LA función que convierte lo que la pasarela dice de una transacción en una consecuencia.
 * Es la única: el webhook, la vuelta del checkout, «Verificar pago Wompi», el conciliador y la
 * revisión al volver pasan todos por aquí.
 *
 * Es IDEMPOTENTE y segura ante concurrencia: la factura se lee con `SELECT … FOR UPDATE` dentro
 * de la transacción, así que dos aplicaciones simultáneas se serializan y la segunda encuentra la
 * factura ya pagada y no hace nada — un pago, un ciclo. El actor de auditoría es el sistema.
 *
 * @param {object} p
 * @param {string} p.pasarela
 * @param {object} p.factura      la factura a la que se refiere (sin lock; el lock va dentro)
 * @param {object} p.estadoReal   lo que devolvió el adaptador: { estado, idExterno, codigoRespuesta, payload }
 * @param {string} p.via          una de VIAS: queda en la auditoría
 */
async function resolverEstadoReal({ pasarela, factura, estadoReal, via = 'webhook' }) {
    if (factura.estado === 'pagada') {
        return manejarFacturaYaPagada({ pasarela, factura, estadoReal, via });
    }
    if (factura.estado === 'anulada') {
        return { accion: 'ignorado', motivo: 'la factura está anulada' };
    }

    setAuditNegocio(factura.id_negocio);

    if (estadoReal.estado === 'aprobada') {
        return aplicarAprobada({ pasarela, factura, estadoReal, via });
    }

    if (estadoReal.estado === 'rechazada') {
        // Un rechazo que llega por aquí es el de un pago que el CLIENTE intentó en el checkout:
        // tarjeta sin fondos, PSE cancelado, Nequi que no aprobó. **No cuenta para la morosidad.**
        //
        // Antes sí contaba, y eso tenía dos fallos. El de fondo: un cliente que prueba un medio y
        // falla no es un débito automático fallido. El grave: con la confirmación por retorno,
        // recargar tres veces la página de un pago rechazado sumaba tres reintentos y SUSPENDÍA
        // al cliente. Los rechazos que sí son morosidad —los del cobro automático con tarjeta
        // guardada— ya se cuentan en `cobranzaService.cobrarFactura`, que es donde ocurren.
        await cerrarIntento({
            idFactura: factura.id_factura,
            pasarela,
            estadoReal,
            estado: 'rechazada',
            mensaje: estadoReal.mensaje ?? null,
        });
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_rechazado',
            resultado: 'error',
            idNegocio: factura.id_negocio,
            detalle: {
                referencia: factura.referencia,
                pasarela,
                codigo: estadoReal.codigoRespuesta ?? null,
                via,
            },
        });
        return { accion: 'cobro_rechazado', referencia: factura.referencia };
    }

    return { accion: 'sin_cambio', motivo: `estado ${estadoReal.codigoRespuesta}` };
}

/**
 * La factura ya estaba pagada. Lo normal: otra vía llegó primero. Lo NO normal —y por eso se
 * mira— es que la pasarela tenga una aprobación que NO es la que pagó la factura (por ejemplo,
 * alguien la marcó pagada a mano y el cliente además pagó): eso es plata cobrada dos veces y hay
 * que enterarse, no ignorarlo.
 */
async function manejarFacturaYaPagada({ pasarela, factura, estadoReal, via }) {
    const resultado = { accion: 'ignorado', motivo: 'la factura ya estaba pagada' };
    if (estadoReal.estado !== 'aprobada') return resultado;

    const [ya] = await sequelize.query(
        `SELECT id_transaccion FROM cobranza.cob_transaccion
          WHERE id_factura = :idFactura AND pasarela = :pasarela AND estado = 'aprobada'
            AND id_externo = :idExterno
          LIMIT 1;`,
        {
            replacements: {
                idFactura: factura.id_factura,
                pasarela,
                idExterno: estadoReal.idExterno ?? null,
            },
            type: sequelize.QueryTypes.SELECT,
        }
    );

    // Se cierra el intento pendiente en cualquier caso: que el conciliador no vuelva a mirarlo.
    await cerrarIntento({
        idFactura: factura.id_factura,
        pasarela,
        estadoReal,
        estado: 'aprobada',
        mensaje: ya
            ? `Ya conciliada: es el mismo pago (${estadoReal.idExterno}) que la transacción ` +
              `${ya.id_transaccion}, que ya pagó la factura. No se aplicó nada.`
            : 'Aprobada en la pasarela, pero la factura ya estaba pagada por otra vía.',
    });
    if (ya) return resultado;

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'pago_duplicado_detectado',
        resultado: 'error',
        idNegocio: factura.id_negocio,
        detalle: {
            referencia: factura.referencia,
            pasarela,
            id_externo: estadoReal.idExterno ?? null,
            via,
        },
    });
    const negocio = await nombreDeNegocio(factura.id_negocio);
    alertarSuperAdmin({
        tipo: 'pago_duplicado',
        asunto: `[EscalApp] Posible cobro doble de ${negocio}`,
        texto:
            `${pasarela} tiene una transacción APROBADA (${estadoReal.idExterno ?? 'sin id'}) para la ` +
            `factura ${factura.referencia} de ${negocio}, pero esa factura ya estaba pagada por otra ` +
            `vía (pago manual u otra transacción). Revisa si hay que devolverle al cliente.`,
    });
    return resultado;
}

async function aplicarAprobada({ pasarela, factura, estadoReal, via }) {
    const transaction = await sequelize.transaction();
    let desajuste = null;
    let aplicada = null;
    try {
        // El lock: desde aquí y hasta el commit nadie más aplica pagos a esta factura.
        const { factura: bloqueada, suscripcion } =
            await CobranzaService._interno.cargarFacturaCobrable(factura.id_factura, transaction);

        // El MISMO pago de la pasarela (mismo id externo) ya aplicado en cualquier transacción nuestra
        // no se aplica dos veces: sería regalar un ciclo con plata que ya se contó.
        const [yaAplicado] = estadoReal.idExterno
            ? await sequelize.query(
                  `SELECT id_transaccion FROM cobranza.cob_transaccion
                    WHERE pasarela = :pasarela AND id_externo = :idExterno AND estado = 'aprobada'
                    LIMIT 1;`,
                  {
                      replacements: { pasarela, idExterno: estadoReal.idExterno },
                      type: sequelize.QueryTypes.SELECT,
                      transaction,
                  }
              )
            : [];
        if (yaAplicado) {
            await transaction.rollback();
            await cerrarIntento({
                idFactura: factura.id_factura,
                pasarela,
                estadoReal,
                estado: 'aprobada',
                mensaje: `Ya conciliada: mismo pago (${estadoReal.idExterno}) que la transacción ${yaAplicado.id_transaccion}.`,
            });
            return { accion: 'ignorado', motivo: 'la factura ya estaba pagada (mismo pago ya conciliado)' };
        }

        const intentos = await referenciasDeIntentos(bloqueada.id_factura, pasarela, transaction);
        const motivo = motivoDeDesajuste({ pasarela, factura: bloqueada, estadoReal, intentos });
        if (motivo) {
            desajuste = motivo;
            await transaction.rollback();
        } else {
            const cerrados = await cerrarIntento({
                idFactura: bloqueada.id_factura,
                pasarela,
                estadoReal,
                estado: 'aprobada',
                mensaje: `Pago confirmado por ${pasarela}`,
                transaction,
            });

            await CobranzaService._interno.aplicarPagoAprobado(
                bloqueada,
                suscripcion,
                {
                    origen: pasarela,
                    id_externo: estadoReal.idExterno,
                    codigo_respuesta: estadoReal.codigoRespuesta,
                    medio_pago_texto: `Pago confirmado por ${pasarela}`,
                    // Si ya cerramos el intento pendiente, no se registra una segunda fila aprobada.
                    omitir_registro_transaccion: cerrados > 0,
                },
                transaction
            );
            await Audit.registrarEvento({
                modulo: 'cobranza',
                accion: 'pago_conciliado',
                idNegocio: bloqueada.id_negocio,
                detalle: {
                    via,
                    pasarela,
                    referencia: bloqueada.referencia,
                    id_externo: estadoReal.idExterno ?? null,
                },
                transaction,
            });
            await transaction.commit();
            aplicada = bloqueada;
        }
    } catch (err) {
        await transaction.rollback();
        // Que otro proceso la haya pagado primero no es un fallo: es la carrera resuelta.
        if (err.code === 'FACTURA_YA_PAGADA') {
            // (`factura` puede ser una instancia de Sequelize: se pasan los campos, no se esparce.)
            return manejarFacturaYaPagada({
                pasarela,
                factura: {
                    id_factura: factura.id_factura,
                    id_negocio: factura.id_negocio,
                    referencia: factura.referencia,
                    estado: 'pagada',
                },
                estadoReal,
                via,
            });
        }
        throw err;
    }

    if (desajuste) {
        console.error(
            `[Cobranza/${pasarela}] no coincide (${desajuste}) en ${factura.referencia} vía ${via}`
        );
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_no_coincide',
            resultado: 'error',
            idNegocio: factura.id_negocio,
            detalle: { via, pasarela, referencia: factura.referencia, motivo: desajuste, id_externo: estadoReal.idExterno ?? null },
        });
        notificarDesajuste({ pasarela, factura, estadoReal, motivo: desajuste, via });
        return { accion: 'ignorado', motivo: 'monto o moneda no coinciden con la factura' };
    }

    // Si esta es la primera factura pagada del negocio, el pago no renueva nada: es un alta desde
    // «Adquirir plan», y el dueño todavía no sabe con qué entrar. Va fuera de la transacción y sin
    // await encadenado: un correo que falle no puede deshacer un pago que ya está aplicado.
    AdquirirService.notificarAltaPagada(aplicada.id_negocio, aplicada.referencia).catch((e) =>
        console.error('[Cobranza] No se pudo avisar del alta pagada:', e.message)
    );

    // Un pago que NO llegó por webhook es el síntoma de que la URL de eventos no está bien puesta
    // en la pasarela. (`manual` lo hace una persona a propósito: no hace falta avisarle a ella.)
    if (via !== 'webhook' && via !== 'manual') {
        nombreDeNegocio(aplicada.id_negocio).then((negocio) =>
            alertarSuperAdmin({
                tipo: 'pago_sin_webhook',
                asunto: `[EscalApp] Pago de ${negocio} recuperado sin webhook — revisa la URL de eventos de Wompi`,
                texto:
                    `Se aplicó el pago ${aplicada.referencia} de ${negocio} por la vía «${via}», sin que ` +
                    `${pasarela} enviara el webhook. La URL de eventos debe ser ` +
                    `https://api.escalapp.cloud/admin/cobranza/webhook/${pasarela} (panel de ${pasarela}, ` +
                    `Desarrolladores → Eventos).`,
            })
        );
    }

    return {
        accion: 'pago_aplicado',
        referencia: aplicada.referencia,
        id_negocio: aplicada.id_negocio,
    };
}

/**
 * Recibe un evento ya verificado y lo lleva hasta su consecuencia: pago aplicado, intento
 * fallido anotado, o nada si el estado sigue pendiente.
 *
 * Devuelve un resumen para el log; **nunca lanza por un evento que no nos incumbe**. Un webhook
 * de una transacción que no reconocemos no es un error del sistema: es ruido, y tumbar el
 * endpoint por ruido provoca reintentos infinitos.
 */
async function procesarEvento(pasarela, verificado, { via = 'webhook' } = {}) {
    const adaptador = getAdaptador(pasarela);

    // El estado autoritativo lo tiene la API, no el cuerpo del mensaje.
    let estadoReal = null;
    if (verificado.idExterno) {
        estadoReal = await adaptador.consultarTransaccion(verificado.idExterno);
    }
    if (!estadoReal) return { accion: 'ignorado', motivo: 'evento sin transacción consultable' };

    const referencia =
        verificado.referencia ||
        estadoReal.payload?.order_id ||
        estadoReal.payload?.reference ||
        null;

    const factura = await buscarFactura({
        referencia,
        idExterno: verificado.idExterno,
        pasarela,
    });
    if (!factura) return { accion: 'ignorado', motivo: `factura desconocida (${referencia})` };

    return resolverEstadoReal({ pasarela, factura, estadoReal, via });
}

/**
 * Punto de entrada del router. Hace lo mínimo antes de responder: verificar, guardar y contestar.
 * El procesamiento va después, en segundo plano, para no hacer esperar a la pasarela.
 */
async function recibir(pasarela, req) {
    const adaptador = getAdaptador(pasarela);
    const verificado = await adaptador.verificarFirmaWebhook(req);

    const evento = await registrarEvento({
        pasarela,
        idEvento: verificado.idEvento,
        tipo: verificado.tipo,
        firmaValida: verificado.valida,
        payload: verificado.payload,
    });

    if (!evento) return { estado: 'duplicado' };

    if (!verificado.valida) {
        await marcarProcesado(evento.id_evento, 'firma inválida');
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'webhook_firma_invalida',
            resultado: 'denegado',
            ip: req.ip,
            detalle: { pasarela, tipo: verificado.tipo ?? null },
        });
        return { estado: 'firma_invalida' };
    }

    return { estado: 'aceptado', evento, verificado };
}

/** Segunda mitad: se llama después de haber respondido 200. Nunca debe tumbar el proceso. */
async function procesarEnSegundoPlano(pasarela, evento, verificado) {
    try {
        const resultado = await procesarEvento(pasarela, verificado);
        await marcarProcesado(evento.id_evento, null);
        console.info(`[Cobranza/webhook:${pasarela}]`, JSON.stringify(resultado));
    } catch (err) {
        await marcarProcesado(evento.id_evento, err.message).catch(() => {});
        console.error(`[Cobranza/webhook:${pasarela}] error:`, err.message);
    }
}

/**
 * Confirma un pago por el id de transacción que trae el cliente al volver del checkout.
 *
 * Existe porque el webhook no siempre llega: en local nunca (localhost no es público) y en
 * producción puede perderse. Recorre exactamente el mismo camino que un webhook —consultar la API,
 * buscar la factura, comprobar el monto, aplicar el pago—, así que no hay una segunda lógica de
 * pago que mantener. Y es idempotente por la misma razón: una factura pagada no se paga dos veces,
 * ni aunque el cliente recargue la página diez veces.
 */
async function confirmarPorRetorno(pasarela, idTransaccion, { ip, via = 'retorno' } = {}) {
    const adaptador = getAdaptador(pasarela);
    if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
        const e = new Error('Ese medio de pago no está disponible.');
        e.code = 'PASARELA_SIN_CREDENCIALES';
        e.statusCode = 503;
        throw e;
    }

    const resultado = await procesarEvento(
        pasarela,
        { idExterno: String(idTransaccion), referencia: null },
        { via }
    );

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: via === 'manual' ? 'pago_confirmado_manual' : 'pago_confirmado_retorno',
        ip,
        detalle: {
            pasarela,
            id_transaccion: String(idTransaccion),
            resultado: resultado.accion,
            motivo: resultado.motivo ?? null,
        },
    });

    // Hacia fuera, una palabra. El motivo interno («factura desconocida», «el monto no coincide»)
    // se queda en la auditoría: contárselo a quien prueba ids es enseñarle cómo funciona la puerta.
    if (resultado.accion === 'pago_aplicado') return { estado: 'aprobada' };
    if (resultado.accion === 'ignorado' && /ya estaba pagada|pagada por otra vía/.test(resultado.motivo || '')) {
        return { estado: 'aprobada' };
    }
    if (resultado.accion === 'cobro_rechazado') return { estado: 'rechazada' };
    if (resultado.accion === 'sin_cambio') return { estado: 'pendiente' };
    return { estado: 'desconocida' };
}

module.exports = {
    recibir,
    procesarEvento,
    procesarEnSegundoPlano,
    confirmarPorRetorno,
    resolverEstadoReal,
    alertarSuperAdmin,
    motivoDeDesajuste,
    VIAS,
};
