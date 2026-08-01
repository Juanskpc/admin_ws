# ADR-016 — WebChat hostil como primer canal

## Estado

Aceptado

## Contexto

El asistente necesita un primer canal por el que probarse. WhatsApp es el destino comercial, pero
conectarlo temprano trae verificación de negocio con Meta, webhooks externos, ventanas de 24 horas,
límites de tasa y costos — todo ruido que no ayuda a validar el motor. Hace falta un canal de
desarrollo antes que el canal comercial.

El riesgo sutil: un canal "cómodo" oculta bugs. Si el primer canal es amable (sin latencia, sin
duplicados, sin reordenamiento), los criterios de aceptación del Conversation Engine
([ADR-014](ADR-014-conversation-engine.md)) —orden FIFO, debounce, lock— **pasan siempre, y no porque
el motor esté bien, sino porque el canal nunca lo puso a prueba**. Esos bugs aparecerían todos juntos
el día que conectemos WhatsApp, que es el peor día para descubrirlos.

## Alternativas consideradas

**Telegram como primer canal.** Parece "gratis", pero sigue siendo un webhook externo con su formato,
sus reintentos y una cuenta que administrar — ruido que no aporta a la validación. Y sobre todo: es un
canal *amable*, no expone los fallos que WhatsApp expondrá. Descartada.

**Un WebChat propio, pero síncrono** (petición HTTP → el servidor procesa → devuelve la respuesta del
bot en el mismo response). Descartada, y es la trampa principal: un WebChat síncrono no tiene entregas
asíncronas, ni duplicados, ni reordenamiento, ni reintentos. Convierte los criterios de aceptación del
motor en **infalsificables**. No probaríamos el motor: probaríamos una función.

**Empezar directamente por WhatsApp.** Descartada: mete toda la fricción externa (Meta, webhooks,
ventanas, costos) antes de haber validado nada, y no permite inyectar fallos a voluntad.

**Un WebChat propio construido como simulador hostil.** Elegida.

## Decisión

El primer canal es un **WebChat propio, construido como simulador hostil asíncrono**. Atraviesa
**exactamente el mismo camino asíncrono** que atravesará WhatsApp (ingesta que responde de inmediato
sin la respuesta del bot → cola FIFO → worker → cola de salida → entrega asíncrona vía SSE/polling).
Nada de request/response síncrono.

Y como es **nuestro**, hace algo que ningún canal externo permite: **inyectar fallos a voluntad**.
Ese es su valor real como herramienta de desarrollo, y es el que Telegram no tiene — es el único canal
que podemos hacer *peor* que la realidad a propósito:

| Fallo inyectable | Qué bug del motor caza |
|---|---|
| Duplicar un mensaje entrante | Deduplicación por `id_externo` |
| Reordenar dos mensajes | Cola FIFO por conversación |
| Ráfaga de 5 mensajes en 1 s | Debounce y lock |
| Retrasar la entrega saliente | Continuidad; que el motor no asuma entrega inmediata |
| Fallar la entrega saliente | Reintentos y *dead letter* |
| Matar el worker a mitad de turno | Persistencia del turno; idempotencia |

Un motor que sobrevive al simulador hostil sobrevivirá a WhatsApp. Uno que solo sobrevive a un
WebChat amable no ha sido probado. El **Simulador de Fallos** es un entregable explícito, no un extra.

El WebChat **no es código desechable**: es también un canal de producto real (widget en el sitio del
negocio), probablemente donde el asistente da su mejor UX porque no tiene la ventana de 24 horas.

## Consecuencias positivas

- El motor se valida contra un canal más hostil que la realidad, antes de tocar nada externo.
- Cero dependencias externas durante el desarrollo: sin Meta, sin webhooks, sin costos, sin límites.
- El WebChat sobrevive como canal de producto; el esfuerzo no se tira.

## Consecuencias negativas

- Construir un canal deliberadamente hostil (asíncrono + inyección de fallos) es **más** trabajo que
  un WebChat síncrono trivial. Es una inversión en capacidad de prueba, no en features visibles.
- Exige disciplina para **no** cortar por lo sano y hacerlo síncrono cuando apremie; el día que se
  vuelva síncrono, deja de probar el motor.

## Impacto futuro

Fija que la abstracción de canal ([ADR-017](ADR-017-channel-gateway.md)) debe soportar entrega
asíncrona desde el primer canal — lo que hace que añadir WhatsApp después sea "otro adaptador", no un
rediseño. Nota de implementación heredada a WhatsApp: la ingesta debe **capturar el body crudo** para
verificar la firma `X-Hub-Signature-256` de Meta (hoy el `express.json()` global lo destruiría), así
que la costura de ingesta debe preservarlo.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 1, WebChat hostil), `architecture/freeze.md`
- [ADR-014](ADR-014-conversation-engine.md), [ADR-015](ADR-015-mvp-determinista.md), [ADR-017](ADR-017-channel-gateway.md)
