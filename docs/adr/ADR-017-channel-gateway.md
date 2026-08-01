# ADR-017 — Channel Gateway y Mensaje Canónico

## Estado

Aceptado

## Contexto

El asistente hablará por varios canales: WebChat hoy, WhatsApp mañana, quizá voz o Instagram después.
Cada canal tiene su propio formato de mensaje, su propia forma de representar botones/opciones, sus
propios metadatos, sus propias reglas (WhatsApp tiene ventana de 24 h; el WebChat no; la voz no tiene
botones). Si el Conversation Engine y las capacidades hablaran el formato de cada canal, cada canal
nuevo obligaría a tocar el núcleo, y el núcleo se llenaría de condicionales por canal.

## Alternativas consideradas

**Acoplar el motor al formato de cada canal**, con ramas `if (canal === 'whatsapp')`. Descartada:
cada canal nuevo es cirugía en el núcleo; el núcleo acumula conocimiento de canales que no le
corresponde. Contradice el principio de que el núcleo es agnóstico
([ADR-009](ADR-009-capability-adapter.md)).

**Un formato canónico interno + adaptadores de canal.** Elegida. Es la aplicación de puertos y
adaptadores al lado de los canales: el núcleo conoce **un** formato; cada canal traduce hacia y desde
él.

## Decisión

Existe un **Mensaje Canónico**: la representación interna, única e independiente de canal, con la que
trabajan el Conversation Engine y las capacidades. Cada canal tiene un **adaptador** (detrás del
`ChannelPort`) que traduce el formato del canal ↔ Mensaje Canónico, tanto en la entrada como en la
salida.

Las respuestas se expresan en términos abstractos (texto, y `opciones[]` para elecciones), y **cada
adaptador las renderiza según su canal**: en WhatsApp las `opciones[]` pueden ser botones; en WebChat,
chips; en voz, una enumeración hablada. El núcleo no sabe cómo se pinta una opción — solo que hay
opciones.

Las particularidades de cada canal (la ventana de 24 h de WhatsApp, la entrega asíncrona, los
metadatos) viven en su adaptador, no en el núcleo.

## Consecuencias positivas

- Añadir un canal es escribir un adaptador; el núcleo y las capacidades no se tocan.
- El núcleo permanece agnóstico de canal, coherente con el agnosticismo de vertical
  ([ADR-009](ADR-009-capability-adapter.md)): el mismo turno sirve por cualquier canal.
- Permite el WebChat hostil hoy y WhatsApp después sin rediseño
  ([ADR-016](ADR-016-webchat-hostil.md)).

## Consecuencias negativas

- Cada adaptador es una capa de traducción que hay que escribir y mantener por canal.
- Riesgo de **mínimo común denominador**: si el Mensaje Canónico solo expresa lo que *todos* los
  canales soportan, se pierden features ricas de un canal concreto. Se mitiga permitiendo que un
  adaptador aproveche capacidades extra de su canal al renderizar, siempre que degrade con gracia
  donde no existan.

## Impacto futuro

Es la frontera que mantiene el número de canales desacoplado del núcleo. Cambiar de Mensaje Canónico
sería tocar todos los adaptadores a la vez, así que su forma debe elegirse con cuidado y evolucionar
de forma aditiva. Es el gemelo, del lado de los canales, del Capability Adapter del lado de las
verticales ([ADR-009](ADR-009-capability-adapter.md)): dos puertos que mantienen el núcleo limpio por
sus dos extremos (entrada de canal, salida a vertical).

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (Channel Gateway, Canonical Message), `SPEC_AI_CORE_ESCALAPP.md`
- [ADR-009](ADR-009-capability-adapter.md), [ADR-014](ADR-014-conversation-engine.md), [ADR-016](ADR-016-webchat-hostil.md)
