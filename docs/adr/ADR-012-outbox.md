# ADR-012 — Outbox transaccional en `platform`

## Estado

Aceptado

## Contexto

Cuando algo ocurre en una vertical (se crea una cita, se paga un pedido), otros componentes quieren
enterarse: el asistente para confirmar por WhatsApp, notificaciones, analítica, auditoría. El
mecanismo actual en reservas es un `notificacionService.enviar()` que solo hace `console.log`, es
*fire-and-forget* post-commit, y **cuatro transiciones de estado no emiten nada**. Es decir: hoy los
eventos se pierden.

Hacen falta dos garantías. Primera, **atomicidad**: si la cita se creó, su evento debe existir sí o
sí — no puede pasar que la transacción confirme y el evento se pierda porque el proceso murió justo
después. Segunda, **independencia**: una vertical debe poder emitir un evento sin depender de que el
subsistema de IA esté vivo, porque las verticales no dependen de Intelligence
([ADR-005](ADR-005-independencia-verticales.md)).

## Alternativas consideradas

**Un broker de mensajes ya (Kafka, RabbitMQ, SQS).** Descartada por ahora: introduce infraestructura
nueva que operar, monitorear y pagar, para un volumen que no la justifica. Además no resuelve por sí
sola la atomicidad (el problema del "dual write": escribir en la BD *y* en el broker no es atómico).
Es la respuesta correcta a un problema de escala que todavía no tenemos.

**Publicar el evento *fire-and-forget* tras el commit** (lo que hay hoy). Descartada: si el proceso
cae entre el commit y la publicación, el evento se pierde en silencio. Sin garantía, no sirve para
confirmaciones ni para nada que importe.

**Un outbox, pero en el esquema `intelligence`.** Descartada, y es una distinción crucial, no
cosmética: si el outbox viviera en `intelligence`, las verticales tendrían que **escribir en el
esquema de la IA** para emitir sus eventos — y ahí, exactamente ahí, la IA se volvería una dependencia
obligatoria del dominio, violando [ADR-005](ADR-005-independencia-verticales.md).

**Un outbox transaccional en `platform`.** Elegida.

## Decisión

Se usa el **patrón outbox transaccional**: el evento se escribe en una tabla `platform.outbox`
**dentro de la misma transacción** que la mutación de dominio. Un relay lee la tabla y entrega los
eventos a los consumidores de forma asíncrona. El outbox vive en **`platform`**, no en
`intelligence`, para que emitir un evento no acople a la vertical con la IA.

El outbox es una **primitiva de plataforma**, no de IA: sirve a notificaciones, CRM, analítica y
auditoría por igual, existan o no. La IA es solo uno más de sus consumidores.

Si algún día el volumen lo pide, un broker puede añadirse **detrás** del outbox (el relay publica al
broker) sin cambiar cómo las verticales emiten. La costura queda abierta.

## Consecuencias positivas

- Atomicidad real: el evento existe si y solo si la transacción de dominio confirmó. Sin dual-write,
  sin eventos perdidos.
- Las verticales emiten a `platform` y se olvidan; no conocen a los consumidores ni a la IA.
- Cero infraestructura nueva: es una tabla y un proceso que la drena. Operable por una persona.

## Consecuencias negativas

- El relay entrega **al menos una vez**: un consumidor puede recibir el mismo evento dos veces (si el
  relay cae tras entregar y antes de marcar). Por tanto **los consumidores deben ser idempotentes**.
  Es una carga real que hay que respetar en cada consumidor.
- Hay latencia de *polling* (el relay no es instantáneo). Aceptable para confirmaciones y notificación.
- El outbox crece; necesita archivado/limpieza de eventos ya entregados.

## Impacto futuro

Es el canal por el que todo evento de dominio fluye hacia todo consumidor presente y futuro. Ubicarlo
en `platform` es lo que sostiene la independencia de las verticales; moverlo a `intelligence` la
rompería. Añadir un broker más adelante es una evolución aditiva detrás del relay, no un rediseño.

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (F1 Outbox), `architecture/revision-01.md` (regla 2 del punto 10)
- [ADR-004](ADR-004-platform-intelligence.md), [ADR-005](ADR-005-independencia-verticales.md), [ADR-013](ADR-013-catalogo-eventos.md)
