# ADR-001 — Visión: la conversación al centro

## Estado

Aceptado

## Contexto

EscalApp es un SaaS multi-inquilino con varias verticales (reservas, restaurante, gym,
parqueadero, tienda) construidas como aplicaciones independientes que solo comparten el backend.
Cada una resuelve su dominio y funciona por sí sola.

Queríamos incorporar un asistente conversacional (WhatsApp, WebChat) capaz de atender clientes:
reservar, pedir, consultar. La pregunta de fondo no era "cómo conecto WhatsApp", sino **dónde vive
el asistente en la arquitectura**. Restricciones: un solo desarrollador; no reconstruir las
verticales existentes; el restaurante ya está en producción. Riesgo principal: que la IA se
convierta en un añadido que acople todo y sea imposible de mantener.

## Alternativas consideradas

**Un chatbot dentro de cada vertical.** Cada app tendría su propio bot acoplado a sus internals.
Descartada: multiplica el trabajo por el número de verticales, duplica la lógica conversacional,
y —lo más grave— **fragmenta al cliente**: la persona que reserva en el salón y pide en el
restaurante serían dos conversaciones que no se conocen. Imposible tener memoria transversal.

**Las verticales siguen siendo el centro; la IA es una función interna de cada una.** Mismo
acoplamiento que la anterior, solo que disfrazado. La conversación seguiría partida por vertical.

**La conversación como agregado central; las verticales como herramientas.** El sistema deja de
organizarse alrededor de la cita o el pedido y se organiza alrededor de la conversación. Las
verticales exponen *capacidades* (acciones de negocio) que la conversación invoca. Los canales
(WhatsApp, WebChat) son adaptadores de entrada/salida. Elegida.

## Decisión

**La conversación es el agregado central del sistema inteligente.** Las verticales aportan
capacidades; no saben que existe un asistente. Los canales son adaptadores de I/O intercambiables.
El "cerebro" conversacional es único y transversal a todas las verticales.

## Consecuencias positivas

- Un solo cerebro conversacional, no uno por vertical.
- Identidad y memoria del cliente compartidas entre verticales (habilita la Ficha 360, el futuro
  Portal del Cliente).
- Las verticales permanecen independientes; una vertical nueva se integra aportando capacidades.
- Los canales se agregan o quitan sin tocar el dominio.

## Consecuencias negativas

- Introduce una capa de indirección (capacidades + adaptadores) que un bot por-vertical no
  necesitaría. Más diseño por adelantado.
- El beneficio **solo se hace visible con la segunda vertical**: para la primera, parece
  sobre-arquitectura. Es una apuesta deliberada a la evolución del producto.

## Impacto futuro

Todo el subsistema `intelligence` depende de esta visión. Revertirla significa volver a bots por
vertical. El radio de impacto está contenido por diseño: como las verticales no dependen de la IA
(ver [ADR-005](ADR-005-independencia-verticales.md)), apagar el cerebro conversacional no rompe
ninguna vertical — solo desaparece el asistente.

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md`, `architecture/freeze.md`
- [ADR-005](ADR-005-independencia-verticales.md), [ADR-007](ADR-007-capacidades.md)
