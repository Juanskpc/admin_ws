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
 * Recibe un evento ya verificado y lo lleva hasta su consecuencia: pago aplicado, intento
 * fallido anotado, o nada si el estado sigue pendiente.
 *
 * Devuelve un resumen para el log; **nunca lanza por un evento que no nos incumbe**. Un webhook
 * de una transacción que no reconocemos no es un error del sistema: es ruido, y tumbar el
 * endpoint por ruido provoca reintentos infinitos.
 */
async function procesarEvento(pasarela, verificado) {
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

    if (factura.estado === 'pagada') {
        return { accion: 'ignorado', motivo: 'la factura ya estaba pagada' };
    }

    // Un pago aprobado por MENOS de lo facturado no extiende nada. Con Wompi la firma de
    // integridad ya lo impide en el checkout, pero esa firma depende de un secreto bien
    // configurado: si algún día se cruza con el de eventos, esta es la guarda que queda.
    //
    // Cada pasarela expresa el monto a su manera y hay que normalizar: Wompi manda
    // `amount_in_cents` (centavos) y dLocal manda `amount` en unidades. Antes solo se miraba el
    // campo de Wompi, así que en un pago por dLocal esta guarda no comprobaba **nada** y se
    // limitaba a la moneda (2026-09-16).
    const p = estadoReal.payload ?? {};
    const centavos =
        p.amount_in_cents != null
            ? Number(p.amount_in_cents)
            : p.amount != null
              ? Math.round(Number(p.amount) * 100)
              : null;
    const moneda = p.currency;
    const esperado = Math.round(Number(factura.total) * 100);
    if (
        estadoReal.estado === 'aprobada' &&
        ((centavos != null && centavos !== esperado) || (moneda && moneda !== factura.moneda))
    ) {
        console.error(
            `[Cobranza/${pasarela}] monto no coincide en ${factura.referencia}: ` +
                `${centavos} ${moneda} vs ${esperado} ${factura.moneda}`
        );
        return { accion: 'ignorado', motivo: 'monto o moneda no coinciden con la factura' };
    }

    setAuditNegocio(factura.id_negocio);

    if (estadoReal.estado === 'aprobada') {
        const transaction = await sequelize.transaction();
        try {
            const { factura: bloqueada, suscripcion } =
                await CobranzaService._interno.cargarFacturaCobrable(factura.id_factura, transaction);

            await CobranzaService._interno.aplicarPagoAprobado(
                bloqueada,
                suscripcion,
                {
                    origen: pasarela,
                    id_externo: estadoReal.idExterno,
                    codigo_respuesta: estadoReal.codigoRespuesta,
                    medio_pago_texto: `Pago confirmado por ${pasarela}`,
                },
                transaction
            );
            await transaction.commit();

            // Si esta es la primera factura pagada del negocio, el pago no renueva nada: es un
            // alta desde «Adquirir plan», y el dueño todavía no sabe con qué entrar. Va fuera de
            // la transacción y sin await encadenado: un correo que falle no puede deshacer un
            // pago que ya está aplicado.
            AdquirirService.notificarAltaPagada(bloqueada.id_negocio, bloqueada.referencia).catch((e) =>
                console.error('[Cobranza] No se pudo avisar del alta pagada:', e.message)
            );

            return { accion: 'pago_aplicado', referencia: bloqueada.referencia };
        } catch (err) {
            await transaction.rollback();
            // Que otro proceso la haya pagado primero no es un fallo: es la carrera resuelta.
            if (err.code === 'FACTURA_YA_PAGADA') {
                return { accion: 'ignorado', motivo: 'pagada por otra vía' };
            }
            throw err;
        }
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
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_rechazado',
            resultado: 'error',
            idNegocio: factura.id_negocio,
            detalle: {
                referencia: factura.referencia,
                pasarela,
                codigo: estadoReal.codigoRespuesta ?? null,
            },
        });
        return { accion: 'cobro_rechazado', referencia: factura.referencia };
    }

    return { accion: 'sin_cambio', motivo: `estado ${estadoReal.codigoRespuesta}` };
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
async function confirmarPorRetorno(pasarela, idTransaccion, { ip } = {}) {
    const adaptador = getAdaptador(pasarela);
    if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
        const e = new Error('Ese medio de pago no está disponible.');
        e.code = 'PASARELA_SIN_CREDENCIALES';
        e.statusCode = 503;
        throw e;
    }

    const resultado = await procesarEvento(pasarela, {
        idExterno: String(idTransaccion),
        referencia: null,
    });

    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'pago_confirmado_retorno',
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

module.exports = { recibir, procesarEvento, procesarEnSegundoPlano, confirmarPorRetorno };
