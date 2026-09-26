'use strict';
/**
 * El abono para reservar desde el portal (función `deposito` del perfil).
 *
 * Se exige solo si se cumplen las tres cosas: la función está encendida, hay un porcentaje
 * configurado **y** el negocio escribió cómo pagarle (`instrucciones_pago`). La tercera no es un
 * detalle: un spa recién creado nace con 30 % de abono, y pedirle a su primer cliente un
 * comprobante sin decirle a qué cuenta consignar es perder la reserva. Hasta que el dueño ponga
 * sus datos de pago, el portal reserva sin abono y Configuración se lo avisa.
 *
 * Devuelve `null` cuando no aplica: el cobro adelantado de siempre (todo o nada) sigue decidiendo
 * como antes. Una barbería nunca llega aquí con la función encendida.
 */
function abonoExigible({ cfg, funciones, monto }) {
    const activas = funciones instanceof Set ? funciones : new Set(funciones || []);
    if (!activas.has('deposito')) return null;
    const pct = Number(cfg?.deposito_pct || 0);
    if (pct <= 0) return null;
    if (!String(cfg?.instrucciones_pago || '').trim()) return null;
    return Math.round((Number(monto) || 0) * Math.min(pct, 100) / 100);
}

/** Lo que el portal debe mostrar sobre el pago adelantado. */
function politicaDePago({ cfg, funciones }) {
    const activas = funciones instanceof Set ? funciones : new Set(funciones || []);
    const conInstrucciones = !!String(cfg?.instrucciones_pago || '').trim();
    const pct = Number(cfg?.deposito_pct || 0);
    if (activas.has('deposito') && pct > 0 && conInstrucciones) {
        return { modo: 'abono', porcentaje: pct, reembolsable: cfg.deposito_reembolsable !== false };
    }
    if (cfg?.cobro_adelantado) return { modo: 'total', porcentaje: 100, reembolsable: true };
    return { modo: 'ninguno', porcentaje: 0, reembolsable: true };
}

module.exports = { abonoExigible, politicaDePago };
