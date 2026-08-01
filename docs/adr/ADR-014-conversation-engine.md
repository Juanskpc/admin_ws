# ADR-014 — Conversation Engine

## Estado

Aceptado

## Contexto

El asistente recibe mensajes por canales asíncronos (WhatsApp, WebChat). Los humanos no escriben un
mensaje completo y esperan: mandan tres mensajes seguidos ("hola", "quiero una cita", "para mañana"),
a veces en desorden, a veces mientras el bot todavía procesa el anterior. Y una misma persona puede
tener varias conversaciones.

Sin una estructura clara, esto produce caos: el modelo responde a "hola" mientras llega "para
mañana", se pisan dos respuestas, o dos mensajes de la misma conversación se procesan en paralelo y
corrompen el estado. Hace falta un motor que ordene la conversación y garantice que **una
conversación se procesa de forma coherente**, aunque el canal entregue los mensajes de cualquier
manera.

## Alternativas consideradas

**Procesar cada mensaje en cuanto llega, en paralelo.** Descartada: dos mensajes de la misma
conversación procesándose a la vez producen respuestas contradictorias y corrupción de estado
conversacional. Es el camino más simple y el más roto.

**Procesar sin bloqueo, confiando en que rara vez colisionan.** Descartada: "rara vez" es
exactamente el bug que aparece en producción y no en las pruebas. El aislamiento no puede ser
probabilístico.

**Responder mensaje a mensaje**, sin agrupar. Descartada: el bot respondería "hola" antes de leer
"quiero una cita para mañana", produciendo intercambios torpes y más llamadas al modelo de las
necesarias (cada mensaje suelto es un turno pagado).

**Cola FIFO por conversación + lock + debounce.** Elegida.

## Decisión

El Conversation Engine estructura la interacción en cuatro niveles:
**Contacto → Conversación → Turno → Pasos**. Y garantiza el procesamiento coherente con tres
mecanismos:

- **Partición FIFO por `conversacion_id`:** los mensajes de una misma conversación se procesan en
  orden, uno detrás de otro. Conversaciones distintas avanzan en paralelo sin problema.
- **Lock pesimista por conversación:** mientras un turno de una conversación se procesa, ningún otro
  worker toma esa conversación. Elimina las colisiones por diseño, no por suerte.
- **Debounce (2–4 s):** antes de procesar, el motor espera brevemente por si llegan más mensajes de
  la misma persona, y los agrupa en **un solo turno**. Así "hola" + "quiero una cita" + "para mañana"
  se atienden juntos.

Se distingue **Conversación** (el hilo con la persona, de larga duración) de **Tarea** (un objetivo
concreto dentro de ella, p.ej. reservar). Una conversación puede contener varias tareas.

## Consecuencias positivas

- Una conversación siempre avanza de forma coherente, sin respuestas pisadas ni estado corrupto,
  independientemente de cómo el canal entregue los mensajes.
- El debounce reduce el número de turnos (y por tanto el costo de modelo) y produce respuestas más
  naturales.
- Conversaciones distintas escalan en paralelo; el lock solo serializa dentro de una conversación.

## Consecuencias negativas

- El debounce añade 2–4 s de latencia deliberada a cada respuesta. Es un trade-off consciente:
  naturalidad y costo a cambio de inmediatez.
- El lock pesimista introduce estado de bloqueo que hay que liberar bien (un worker que muere debe
  soltar el lock, o la conversación se congela). Complejidad operativa real.
- Serializar una conversación limita su throughput a un turno a la vez — aceptable, porque al otro
  lado hay un humano que escribe a ritmo humano.

## Impacto futuro

Es el corazón del subsistema conversacional; todo canal ([ADR-017](ADR-017-channel-gateway.md)) y
todo modelo ([ADR-018](ADR-018-estrategia-modelos.md)) se apoyan en él. Se construye y se valida
**sin IA** en el MVP determinista ([ADR-015](ADR-015-mvp-determinista.md)) y se estresa con el
WebChat hostil ([ADR-016](ADR-016-webchat-hostil.md)), que inyecta duplicados, reordenamientos y
ráfagas precisamente para probar estos tres mecanismos.

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (Conversation Engine), `architecture/freeze.md`
- [ADR-015](ADR-015-mvp-determinista.md), [ADR-016](ADR-016-webchat-hostil.md), [ADR-017](ADR-017-channel-gateway.md)
