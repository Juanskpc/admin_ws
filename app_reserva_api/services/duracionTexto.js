'use strict';

/**
 * Minutos como los dice una persona: «15 minutos», «1 hora», «24 horas», «1 h 30 min».
 *
 * Las reglas de reserva pasaron a minutos (2026-09-29) y sus mensajes —«Debe reservar con al
 * menos…», «Solo se puede cancelar con…»— se leen en el portal y en WhatsApp. «90 minutos» o
 * «1440 minutos» obligaría al cliente a hacer cuentas.
 */
function duracionLegible(minutos) {
    const m = Math.max(0, Math.round(Number(minutos) || 0));
    if (m < 60) return `${m} ${m === 1 ? 'minuto' : 'minutos'}`;
    const h = Math.floor(m / 60);
    const resto = m % 60;
    if (resto === 0) return `${h} ${h === 1 ? 'hora' : 'horas'}`;
    return `${h} h ${resto} min`;
}

module.exports = { duracionLegible };
