/**
 * Manejador de eco — **andamio de F5-B**, no es el motor de conversación.
 *
 * F5-B construye la mecánica: orden, agrupación, aislamiento, continuidad y Ledger. Decidir
 * *qué* se contesta es F5-D (motor determinista: FSM, regex, menús — ADR-015). Pero un motor
 * sin ningún manejador no se puede ejercitar, y un mecanismo que no se puede ejercitar no se
 * puede dar por bueno. Así que esto existe para poder mirar el motor funcionando, y se borra
 * —o se queda como manejador de pruebas— cuando llegue la FSM de verdad.
 *
 * Hace tres cosas, y las tres son las que hay que poder ver desde fuera:
 *
 *   - Devuelve el texto **agrupado**: si el debounce hizo su trabajo, la respuesta contiene
 *     los tres mensajes de la ráfaga, no el primero.
 *   - Lleva una cuenta en `variables`, que es la memoria de sesión sobreviviendo entre turnos.
 *   - Abre y cierra una **tarea** con `pausa` / `seguimos`, que es lo que demuestra el
 *     «lo dejamos a medias el martes, ¿seguimos?» de ADR-014 — incluso si entre medias se
 *     reinicia el proceso, porque la tarea vive en la fila de la conversación, no en memoria.
 *
 * No conoce la base de datos: recibe un contexto y devuelve una decisión. Esa frontera es la
 * que permitirá enchufar la FSM en F5-D sin tocar el motor.
 */
'use strict';

const PALABRA_PAUSA = 'pausa';
const PALABRA_RETOMAR = 'seguimos';

function manejarEco({ conversacion, mensajes, texto }) {
    const vistos = Number(conversacion.variables?.mensajes_vistos || 0) + mensajes.length;
    const turnos = Number(conversacion.variables?.turnos || 0) + 1;
    const normalizado = texto.trim().toLowerCase();

    const pasos = [
        {
            tipo: 'regla',
            decision: 'eco',
            motivo: { mensajes_agrupados: mensajes.length, turno_de_la_conversacion: turnos },
        },
    ];

    // ── Retomar una tarea a medias ──────────────────────────────────────────────────────
    if (conversacion.tarea_actual && normalizado.includes(PALABRA_RETOMAR)) {
        const pendiente = conversacion.tarea_datos?.texto ?? '(sin detalle)';
        return {
            pasos: [...pasos, { tipo: 'regla', decision: 'tarea_retomada', motivo: { pendiente } }],
            respuestas: [`Retomamos lo que dejamos a medias: "${pendiente}".`],
            variables: { mensajes_vistos: vistos, turnos },
            tarea: null,
        };
    }

    // ── Dejar una tarea a medias ────────────────────────────────────────────────────────
    if (normalizado.includes(PALABRA_PAUSA)) {
        return {
            pasos: [...pasos, { tipo: 'regla', decision: 'tarea_pausada', motivo: {} }],
            respuestas: [
                {
                    texto: 'Vale, lo dejamos aquí. Dime cuando quieras continuar.',
                    // En abstracto, sin marcado de ningún canal (ADR-017): el WebChat lo
                    // pintará como chip, WhatsApp como botón y la voz lo enumerará. Es la
                    // única respuesta del andamio con opciones, y existe para que ese camino
                    // tenga un productor de verdad hasta que llegue la FSM de F5-D.
                    opciones: [{ id: PALABRA_RETOMAR, etiqueta: 'Seguimos' }],
                },
            ],
            variables: { mensajes_vistos: vistos, turnos },
            tarea: { nombre: 'eco_pendiente', datos: { texto } },
        };
    }

    return {
        pasos,
        respuestas: [`Recibí ${mensajes.length} mensaje(s) en este turno: ${texto}`],
        variables: { mensajes_vistos: vistos, turnos },
    };
}

module.exports = { manejarEco, PALABRA_PAUSA, PALABRA_RETOMAR };
