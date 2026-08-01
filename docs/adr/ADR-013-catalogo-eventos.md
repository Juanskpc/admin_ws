# ADR-013 — Catálogo de eventos de dominio

## Estado

Aceptado

## Contexto

El outbox ([ADR-012](ADR-012-outbox.md)) transporta eventos, pero no dice **cómo se llaman ni qué
llevan**. Un evento es un **contrato**: en cuanto un consumidor depende de `cita.creada`, su nombre y
su forma quedan atados a ese consumidor. Y va a haber muchos consumidores potenciales —
notificaciones, analítica, auditoría, la IA, webhooks para terceros — todos consumiendo el mismo
lenguaje del dominio.

Vamos a nombrar eventos de todas formas; el outbox nos obliga. La única pregunta es si los nombramos
**deliberadamente y de forma consistente**, o **ad-hoc cada vez que una vertical necesita uno**. Lo
segundo garantiza deriva: `cita.creada` vs `citaCreada` vs `CitaCreada` vs `appointment_created`
conviviendo. Cambiar el nombre de un evento después, con consumidores vivos, rompe contratos.

Este ADR trata **solo el lenguaje del dominio** — el contrato — no la infraestructura (esa es
[ADR-012](ADR-012-outbox.md)).

## Alternativas consideradas

**Eventos ad-hoc, cada vertical inventa los suyos.** Descartada: deriva garantizada de nombres y
formas, imposible de consumir de forma uniforme.

**Eventos "gordos" que llevan una copia del estado** (todo el objeto cita dentro del evento).
Descartada: acopla el esquema del productor a **todos** los consumidores para siempre; cualquier
cambio en la forma de la cita se propaga a cada consumidor. Los eventos gordos envejecen mal.

**Nombres en inglés** (`AppointmentCreated`), pensando en integraciones externas. Descartada para el
catálogo interno: el código y el dominio están en español (`reserva_cita`, `gener_negocio`); mezclar
`AppointmentCreated` con `reserva_cita` crea un seam de traducción permanente que nadie pidió. Si un
día existe un producto de webhooks para terceros, tendrá su **propia** traducción a inglés en su
adaptador — nunca se contamina el catálogo interno.

## Decisión

Existe un **catálogo oficial de eventos de dominio**, como contrato versionado. Reglas:

- **Convención de nombres:** `<agregado>.<hecho-en-pasado>.v<n>` (p.ej. `cita.creada.v1`,
  `pedido.pagado.v1`), en **español**.
- **Eventos delgados:** un evento lleva **identificadores y el hecho**, no una copia del estado.
  `cita.creada.v1` lleva `{id_negocio, id_cita, id_persona_negocio?, ocurrido_en}`, no la cita
  entera. Un consumidor que necesite detalle lo pide releyendo (vía capacidad o read-model).
  Excepción: un valor que **solo es cierto en ese instante** y no se puede releer (el `de→a` de una
  transición de estado) sí va en el evento.
- **Versionado aditivo:** `v1` nunca cambia de forma; un cambio incompatible es `v2` conviviendo con
  `v1`. Misma disciplina que los esquemas del Grupo 1 ([ADR-003](ADR-003-madurez-esquemas.md)).
- **No enumerar por adelantado.** Se define un evento cuando hay un productor que lo emite *y* alguien
  que lo necesita. Se empieza con el puñado que la IA y las notificaciones piden, pero **con la
  convención puesta desde el primer evento**.

El catálogo vive como documento en `architecture/domain-events.md`; no es un bounded context, es una
**lengua publicada** (shared kernel) que pertenece a `platform`.

## Consecuencias positivas

- Cualquier consumidor futuro (analítica, auditoría, webhooks, IA) habla el mismo lenguaje sin
  coordinación previa.
- Los eventos delgados no acoplan a los consumidores al esquema del productor; envejecen bien.
- Junto con Capacidades ([ADR-007](ADR-007-capacidades.md)) y los read-models, forma tres vocabularios
  limpios: **escritura** (lo que se puede hacer), **notificación** (lo que pasó) y **consulta** (lo
  que se puede leer). Separación tipo CQRS sin construir CQRS.

## Consecuencias negativas

- Los eventos delgados obligan al consumidor a releer si necesita detalle: una llamada extra frente a
  un evento que ya trae todo. Es el precio de no acoplar.
- La disciplina de versionado y de "no enumerar" exige criterio en cada evento nuevo; es fácil caer
  en la tentación de eventos gordos "por comodidad".

## Impacto futuro

El catálogo es un contrato de larga vida: cuantos más consumidores, más caro cambiar un nombre o una
forma. Por eso la convención se congela ahora y los cambios son siempre aditivos (nueva versión al
lado de la vieja). Un producto de webhooks para terceros, si llega, se construye como traducción
sobre este catálogo, no modificándolo.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 2, catálogo de eventos), `architecture/domain-events.md`
- [ADR-003](ADR-003-madurez-esquemas.md), [ADR-007](ADR-007-capacidades.md), [ADR-012](ADR-012-outbox.md)
