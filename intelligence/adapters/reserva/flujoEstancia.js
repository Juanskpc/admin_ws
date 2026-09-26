'use strict';
/**
 * Flujo del asistente para alojamientos (perfil ALOJAMIENTO): reservan noches, no citas.
 *
 * ## Por qué es tan corto
 *
 * El flujo de citas le ofrecería «¿qué servicio quieres agendar?» y una lista de horas a quien
 * pregunta por una habitación. Reservar una estancia por chat pide fechas, huéspedes, tipo de
 * habitación, precio por noches y un anticipo con comprobante: todo eso ya lo resuelve el portal
 * en una pantalla. Así que el asistente hace lo útil y honesto —saluda con el nombre del negocio
 * y lleva a la persona al portal— en vez de una conversación larga que acabaría en lo mismo.
 * Una capacidad conversacional de estancias queda para cuando haya un alojamiento real usándolo
 * y se sepa qué pregunta la gente.
 *
 * El enlace sale de `RESERVA_PORTAL_URL` (la raíz pública de la app de reservas, con su
 * baseHref). Sin ella no se inventa una dirección: se pide al cliente que deje sus fechas y se
 * pasa la conversación a una persona.
 */
const contextoNegocioReal = require('../../core/contextoNegocio');

const TIPOS_NEGOCIO = ['ALOJAMIENTO'];

function urlPortal(idNegocio) {
    const base = String(process.env.RESERVA_PORTAL_URL || '').trim().replace(/\/+$/, '');
    return base && idNegocio ? `${base}/p/${idNegocio}` : null;
}

function crearManejadorEstancia({ contextoNegocio = contextoNegocioReal } = {}) {
    return async function manejarEstancia(ctx) {
        const conversacion = ctx.conversacion || {};
        const idNegocio = conversacion.id_negocio;
        let negocio = null;
        try {
            negocio = await contextoNegocio.obtener(idNegocio);
        } catch {
            negocio = null;
        }
        const nombre = negocio?.nombre ? ` a ${negocio.nombre}` : '';
        const enlace = urlPortal(idNegocio);
        const previas = conversacion.variables || {};
        const variables = { ...previas, turnos: Number(previas.turnos || 0) + 1 };

        if (enlace) {
            return {
                pasos: [{ tipo: 'regla', decision: 'estancia_portal', motivo: {} }],
                respuestas: [
                    `¡Hola! Gracias por escribir${nombre}. 🙌`,
                    `Aquí puedes ver disponibilidad y precios para tus fechas y reservar tu estadía: ${enlace}`,
                    'Si prefieres, cuéntanos por aquí tus fechas de llegada y salida y cuántas personas son, y te ayudamos.',
                ],
                variables,
                tarea: null,
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        }
        return {
            pasos: [{ tipo: 'regla', decision: 'estancia_sin_portal', motivo: {} }],
            respuestas: [
                `¡Hola! Gracias por escribir${nombre}. 🙌`,
                'Cuéntanos tus fechas de llegada y salida y cuántas personas son; te respondemos con la disponibilidad.',
            ],
            variables,
            tarea: null,
            resultado: 'resuelto',
            nivel: 'determinista',
        };
    };
}

function registrarFlujo({ flujos }) {
    flujos.registrar({ vertical: 'reserva_estancia', tipos: TIPOS_NEGOCIO, manejar: crearManejadorEstancia() });
}

module.exports = { TIPOS_NEGOCIO, crearManejadorEstancia, registrarFlujo, urlPortal };
