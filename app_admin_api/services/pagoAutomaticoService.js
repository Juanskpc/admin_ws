/**
 * Pago automático — el débito mensual OPCIONAL con tarjeta guardada (2026-10-14).
 *
 * Decisión del dueño: es opcional. Quien registra su tarjeta en «Mis pagos» no vuelve a pensar en
 * pagar; quien no, sigue con el enlace de pago (PSE, Nequi, tarjeta) como hasta ahora. Las dos vías
 * terminan en el mismo sitio: `aplicarPagoAprobado`.
 *
 * ## Cómo entra una tarjeta, sin pasar por aquí
 *
 *   1. El navegador pide `terminos()`: los dos documentos que Wompi exige aceptar (reglamento y
 *      tratamiento de datos) con sus tokens, y la llave pública para el widget.
 *   2. El cliente escribe la tarjeta en el widget de Wompi en modo «tokenize». El número va del
 *      navegador a Wompi; a nosotros llega solo un token de un solo uso.
 *   3. `activar()` cambia ese token por una «fuente de pago» permanente (llave privada, aquí en el
 *      servidor) y guarda solo marca, últimos 4 y vencimiento para que el cliente la reconozca.
 *
 * El alcance PCI se queda en SAQ-A: ningún número de tarjeta toca nuestros servidores.
 *
 * ## Qué hace que el cron la cobre
 *
 * `cob_suscripcion.id_metodo_pago` (con el método activo) y `proximo_cobro`. El cron
 * (`cobranzaScheduler`) solo mira suscripciones que tengan las dos cosas. Desactivar es quitar
 * las dos: el cliente vuelve a pagar con el enlace sin perder nada.
 *
 * ## Solo Colombia por ahora
 *
 * El débito automático es de Wompi. dLocal Go (Chile) no guarda tarjetas para cobrar sin el
 * cliente delante (`soportaRecurrente: false`): allí se sigue pagando con el enlace.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const Dao = require('../../app_core/dao/cobranzaDao');
const { getAdaptador } = require('../../app_core/cobranza');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');
const CobranzaService = require('./cobranzaService');
const mailService = require('./mailService');

const sequelize = Models.sequelize;
const { hoyBogota, sumarDia } = CobranzaService._fechas;

const PASARELA_AUTOMATICA = 'wompi';

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/** El plan vigente del negocio: el de mayor cobertura (sin fecha de fin gana: no vence). */
async function planVigente(idNegocio, { transaction } = {}) {
    const [plan] = await sequelize.query(
        `SELECT np.id_plan, to_char(np.fecha_fin::date, 'YYYY-MM-DD') AS fin, n.pais, n.nombre,
                n.email_contacto
           FROM general.gener_negocio n
           LEFT JOIN LATERAL (
                 SELECT id_plan, fecha_fin
                   FROM general.gener_negocio_plan
                  WHERE id_negocio = n.id_negocio AND estado = 'A'
                  ORDER BY fecha_fin DESC NULLS FIRST
                  LIMIT 1
           ) np ON true
          WHERE n.id_negocio = :idNegocio AND n.estado = 'A';`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    return plan ?? null;
}

/** El medio de pago con el que se le cobra solo, o null. */
async function metodoActivoDe(idNegocio, { transaction } = {}) {
    const suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio, { transaction });
    if (!suscripcion?.id_metodo_pago) return null;
    const metodo = await Models.CobMetodoPago.findOne({
        where: { id_metodo_pago: suscripcion.id_metodo_pago, estado: 'A' },
        transaction,
    });
    return metodo ? { suscripcion, metodo } : null;
}

/** «Visa ···4242», para pantallas y correos. */
function describirMetodo(metodo) {
    if (!metodo) return null;
    const marca = metodo.marca
        ? metodo.marca.charAt(0) + metodo.marca.slice(1).toLowerCase()
        : metodo.tipo === 'NEQUI'
          ? 'Nequi'
          : 'Tarjeta';
    return metodo.ultimos4 ? `${marca} ···${metodo.ultimos4}` : marca;
}

/**
 * Por qué este negocio NO puede activar el pago automático, o null si puede. Es lo que la pantalla
 * enseña en vez del botón: un botón que falla al pulsarlo es peor que una frase que explica.
 */
function motivoNoDisponible({ plan, suscripcion }) {
    if (!plan) return { code: 'SIN_PLAN', texto: 'El negocio no tiene un plan activo.' };
    if (!plan.fin) {
        return {
            code: 'PLAN_SIN_VENCIMIENTO',
            texto: 'Tu plan no tiene fecha de vencimiento: no hay mensualidad que cobrar.',
        };
    }
    if ((plan.pais || 'CO') !== 'CO') {
        return {
            code: 'PAIS_SIN_PAGO_AUTOMATICO',
            texto: 'El pago automático por ahora solo está disponible en Colombia.',
        };
    }
    if (suscripcion?.es_retenedor) {
        return {
            code: 'RETENEDOR',
            texto:
                'Tu negocio practica retención en la fuente: no se le puede debitar el 100 % de la ' +
                'factura. Escríbenos y lo coordinamos.',
        };
    }
    const adaptador = getAdaptador(PASARELA_AUTOMATICA);
    if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
        return { code: 'PASARELA_NO_CONFIGURADA', texto: 'El pago con tarjeta no está disponible ahora mismo.' };
    }
    return null;
}

/** Lo que enseña «Mis pagos». */
async function estado(idNegocio) {
    const plan = await planVigente(idNegocio);
    const suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
    const activo = await metodoActivoDe(idNegocio);
    const noDisponible = activo ? null : motivoNoDisponible({ plan, suscripcion });

    return {
        disponible: !noDisponible,
        motivo_no_disponible: noDisponible,
        activo: Boolean(activo),
        metodo: activo
            ? {
                  descripcion: describirMetodo(activo.metodo),
                  tipo: activo.metodo.tipo,
                  marca: activo.metodo.marca,
                  ultimos4: activo.metodo.ultimos4,
                  mes_exp: activo.metodo.mes_exp,
                  anio_exp: activo.metodo.anio_exp,
                  autorizado_en: activo.metodo.autorizado_en,
              }
            : null,
        proximo_cobro: activo?.suscripcion?.proximo_cobro ?? null,
        estado_suscripcion: suscripcion?.estado ?? null,
        reintentos: Number(suscripcion?.reintentos ?? 0),
        plan_vence: plan?.fin ?? null,
    };
}

/**
 * Lo que el navegador necesita para abrir el widget: la llave PÚBLICA (es pública por diseño, va en
 * el HTML de cualquier comercio) y los dos documentos que el cliente tiene que aceptar.
 */
async function terminos() {
    const adaptador = getAdaptador(PASARELA_AUTOMATICA);
    if (adaptador.estaConfigurada && !adaptador.estaConfigurada()) {
        throw error('El pago con tarjeta no está disponible ahora mismo.', 'PASARELA_NO_CONFIGURADA', 503);
    }
    const t = await adaptador.getTerminos();
    if (!t.acceptanceToken || !t.personalAuthToken) {
        throw error('Wompi no devolvió los términos de aceptación.', 'TERMINOS_NO_DISPONIBLES', 502);
    }
    return {
        llave_publica: process.env.WOMPI_PUBLIC_KEY,
        acceptance_token: t.acceptanceToken,
        permalink: t.permalink,
        personal_auth_token: t.personalAuthToken,
        personal_permalink: t.personalPermalink,
    };
}

/**
 * La fecha en que el cron hará el primer cobro: el día siguiente al vencimiento (lo mismo que deja
 * `aplicarPagoAprobado` tras cada pago), u hoy si el plan ya venció o hay un cobro pendiente vencido.
 */
function primerCobro({ fin, hoy }) {
    const siguiente = sumarDia(fin);
    return siguiente < hoy ? hoy : siguiente;
}

/** Las direcciones a las que avisar: quien autorizó y el correo del negocio. */
async function destinatarios(idNegocio, idUsuario) {
    const correos = new Set();
    const plan = await planVigente(idNegocio);
    if (plan?.email_contacto) correos.add(plan.email_contacto);
    if (idUsuario) {
        const usuario = await Models.GenerUsuario.findByPk(idUsuario, { attributes: ['email'] });
        if (usuario?.email) correos.add(usuario.email);
    }
    return { correos: [...correos], nombreNegocio: plan?.nombre ?? `negocio ${idNegocio}` };
}

/**
 * Activa el pago automático: cambia el token del widget por una fuente de pago permanente, la
 * guarda con la constancia de quién la autorizó, y deja la suscripción lista para el cron.
 *
 * Si el negocio ya debía (cobro pendiente con el plan vencido), se le cobra en el acto: es lo que
 * espera quien registra la tarjeta estando atrasado, y si no, el cron lo haría mañana a las 08:15.
 */
async function activar(
    idNegocio,
    { tokenTarjeta, tipo = 'CARD', acceptanceToken, personalAuthToken, idUsuario, ip }
) {
    if (!tokenTarjeta) throw error('Falta la tarjeta.', 'TOKEN_REQUERIDO', 422);
    if (!acceptanceToken || !personalAuthToken) {
        throw error(
            'Debes aceptar el reglamento y la autorización de datos de Wompi.',
            'TERMINOS_NO_ACEPTADOS',
            422
        );
    }

    const plan = await planVigente(idNegocio);
    let suscripcion = await Dao.getSuscripcionPorNegocio(idNegocio);
    const noDisponible = motivoNoDisponible({ plan, suscripcion });
    if (noDisponible) throw error(noDisponible.texto, noDisponible.code, 409);

    // Un negocio que nunca tuvo suscripción de cobro la estrena aquí, con su plan vigente.
    if (!suscripcion) {
        suscripcion = await CobranzaService.configurarSuscripcion(idNegocio, {
            id_plan: plan.id_plan,
            pasarela: PASARELA_AUTOMATICA,
        });
    }
    if (['cancelada'].includes(suscripcion.estado)) {
        throw error('La suscripción de este negocio está cancelada.', 'SUSCRIPCION_CANCELADA', 409);
    }

    const { correos, nombreNegocio } = await destinatarios(idNegocio, idUsuario);
    const adaptador = getAdaptador(PASARELA_AUTOMATICA);

    // Primero Wompi, fuera de la transacción: es una llamada de red y, si falla, no hay nada que
    // deshacer en nuestra base.
    const fuente = await adaptador.tokenizarMetodo({
        tokenTarjeta,
        acceptanceToken,
        personalAuthToken,
        email: correos[0],
        // El widget devuelve el tipo: tarjeta o Nequi (el cliente autoriza en su celular).
        tipo: tipo === 'NEQUI' ? 'NEQUI' : 'CARD',
    });

    const hoy = hoyBogota();
    const proximo = primerCobro({ fin: plan.fin, hoy });

    const t = await sequelize.transaction();
    let metodo;
    try {
        // Una tarjeta nueva reemplaza a la anterior: nunca hay dos activas para el mismo negocio.
        await Models.CobMetodoPago.update(
            { estado: 'I' },
            { where: { id_negocio: idNegocio, estado: 'A' }, transaction: t }
        );
        metodo = await Models.CobMetodoPago.create(
            {
                id_negocio: idNegocio,
                pasarela: PASARELA_AUTOMATICA,
                token_externo: fuente.tokenExterno,
                tipo: fuente.tipo,
                marca: fuente.marca,
                ultimos4: fuente.ultimos4,
                mes_exp: fuente.mesExp,
                anio_exp: fuente.anioExp,
                autorizado_por: idUsuario ?? null,
                autorizado_en: new Date(),
                ip_autorizacion: ip ? String(ip).slice(0, 64) : null,
            },
            { transaction: t }
        );
        await Dao.actualizarSuscripcion(
            suscripcion.id_suscripcion,
            {
                pasarela: PASARELA_AUTOMATICA,
                id_metodo_pago: metodo.id_metodo_pago,
                proximo_cobro: proximo,
                // Quien registra una tarjeta nueva estando en gracia empieza de cero: los
                // reintentos eran de la tarjeta anterior.
                ...(suscripcion.estado === 'en_gracia' ? { reintentos: 0 } : {}),
            },
            { transaction: t }
        );

        setAuditNegocio(idNegocio);
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_automatico_activado',
            idNegocio,
            idUsuario: idUsuario ?? null,
            ip: ip ?? undefined,
            detalle: {
                metodo: describirMetodo(metodo),
                proximo_cobro: proximo,
            },
            transaction: t,
        });
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }

    // ¿Debía ya? Se cobra ahora la factura pendiente cuyo período ya empezó.
    let cobroInmediato = null;
    const [vencida] = await sequelize.query(
        `SELECT id_factura
           FROM cobranza.cob_factura
          WHERE id_negocio = :idNegocio AND estado = 'pendiente'
            AND periodo_inicio::date <= :hoy
          ORDER BY periodo_inicio ASC
          LIMIT 1;`,
        { replacements: { idNegocio, hoy }, type: sequelize.QueryTypes.SELECT }
    );
    if (vencida) {
        try {
            const r = await CobranzaService.cobrarFactura(vencida.id_factura);
            cobroInmediato = { estado: r.estado, mensaje: r.mensaje ?? null };
        } catch (err) {
            // La tarjeta quedó guardada; si el cobro falla aquí, el cron lo reintenta.
            console.error(`[PagoAutomatico] cobro inmediato del negocio ${idNegocio} falló:`, err.message);
            cobroInmediato = { estado: 'error', mensaje: null };
        }
    }

    // Sin `await`: el correo sale por detrás. Esperarlo hacía que activar tardara ~10 s (dos envíos
    // por SMTP) con el cliente mirando un spinner. `avisar` no lanza: cada fallo queda en el log.
    void avisar(correos, {
        asunto: 'Activaste el pago automático — EscalApp',
        titulo: 'Pago automático activado',
        parrafos: [
            `Desde ahora la mensualidad de <strong>${nombreNegocio}</strong> se cobra sola a tu ` +
                `<strong>${describirMetodo(metodo)}</strong>. No tienes que hacer nada cada mes.`,
            `Próximo cobro: <strong>${formatoFecha(cobroInmediato ? hoy : proximo)}</strong>. Te ` +
                'avisaremos si un cobro no pasa.',
            'Puedes desactivarlo o cambiar la tarjeta cuando quieras en «Mis pagos».',
        ],
        tono: 'ok',
    });

    return { ...(await estado(idNegocio)), cobro_inmediato: cobroInmediato };
}

/**
 * Desactiva el pago automático. La tarjeta queda inactiva (no se borra: los cobros que ya se
 * hicieron la referencian) y el negocio vuelve a pagar con el enlace.
 */
async function desactivar(idNegocio, { idUsuario } = {}) {
    const activo = await metodoActivoDe(idNegocio);
    if (!activo) return estado(idNegocio);

    const t = await sequelize.transaction();
    try {
        await Models.CobMetodoPago.update(
            { estado: 'I' },
            { where: { id_metodo_pago: activo.metodo.id_metodo_pago }, transaction: t }
        );
        await Dao.actualizarSuscripcion(
            activo.suscripcion.id_suscripcion,
            { id_metodo_pago: null, proximo_cobro: null },
            { transaction: t }
        );
        setAuditNegocio(idNegocio);
        await Audit.registrarEvento({
            modulo: 'cobranza',
            accion: 'pago_automatico_desactivado',
            idNegocio,
            idUsuario: idUsuario ?? null,
            detalle: { metodo: describirMetodo(activo.metodo) },
            transaction: t,
        });
        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }

    const { correos, nombreNegocio } = await destinatarios(idNegocio, idUsuario);
    // Sin `await`: el correo sale por detrás. Esperarlo hacía que activar tardara ~10 s (dos envíos
    // por SMTP) con el cliente mirando un spinner. `avisar` no lanza: cada fallo queda en el log.
    void avisar(correos, {
        asunto: 'Desactivaste el pago automático — EscalApp',
        titulo: 'Pago automático desactivado',
        parrafos: [
            `La mensualidad de <strong>${nombreNegocio}</strong> ya no se cobrará sola a tu ` +
                `${describirMetodo(activo.metodo)}.`,
            'Cuando se acerque el vencimiento te enviaremos el enlace para pagar con PSE, Nequi o tarjeta.',
        ],
        tono: 'info',
    });

    return estado(idNegocio);
}

/**
 * El aviso de un cobro automático que no pasó. Lo llama `registrarIntentoFallido` (vía el cron).
 * Nunca lanza: un correo que no sale no puede tumbar el ciclo de cobro.
 */
async function avisarCobroFallido({ idNegocio, monto, moneda, motivo, suspendida, reintentoEn }) {
    try {
        const activo = await metodoActivoDe(idNegocio);
        const { correos, nombreNegocio } = await destinatarios(
            idNegocio,
            activo?.metodo?.autorizado_por ?? null
        );
        const valor = formatoMonto(monto, moneda);
        await avisar(correos, {
            asunto: suspendida
                ? 'No pudimos cobrar tu mensualidad: tu plan quedó suspendido — EscalApp'
                : 'No pudimos cobrar tu mensualidad — EscalApp',
            titulo: 'No pudimos cobrar tu mensualidad',
            parrafos: [
                `Intentamos cobrar <strong>${valor}</strong> de <strong>${nombreNegocio}</strong> a tu ` +
                    `${describirMetodo(activo?.metodo) ?? 'tarjeta'} y el banco lo rechazó` +
                    (motivo ? ` (${motivo}).` : '.'),
                suspendida
                    ? 'Tras varios intentos, el plan quedó suspendido. Págalo ahora con PSE, Nequi o tarjeta y se reactiva al instante.'
                    : `Lo intentaremos de nuevo el <strong>${formatoFecha(reintentoEn)}</strong>. ` +
                      'Mientras tanto tu negocio sigue funcionando con normalidad. Si quieres, puedes pagar ya o cambiar la tarjeta.',
            ],
            boton: { texto: 'Pagar o cambiar tarjeta', url: `${urlBase()}/pagar` },
            tono: 'error',
        });
    } catch (err) {
        console.error(`[PagoAutomatico] aviso de cobro fallido (negocio ${idNegocio}):`, err.message);
    }
}

function urlBase() {
    return process.env.FRONTEND_URL || 'https://escalapp.cloud';
}

function formatoFecha(iso) {
    if (!iso) return '';
    const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d, 12)).toLocaleDateString('es-CO', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

function formatoMonto(monto, moneda = 'COP') {
    return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: moneda,
        maximumFractionDigits: 0,
    }).format(Number(monto || 0));
}

/** Manda el mismo aviso a cada destinatario. Un correo que falla no detiene a los demás. */
async function avisar(correos, aviso) {
    for (const to of correos) {
        try {
            await mailService.sendAvisoCobroEmail(to, aviso);
        } catch (err) {
            console.error(`[PagoAutomatico] no se pudo avisar a ${to}:`, err.message);
        }
    }
}

module.exports = {
    estado,
    terminos,
    activar,
    desactivar,
    avisarCobroFallido,
    metodoActivoDe,
    describirMetodo,
    _interno: { primerCobro, motivoNoDisponible },
};
