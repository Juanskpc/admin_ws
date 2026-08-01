# ADR-018 — Estrategia de modelos: escalera de 2 niveles diseñada para 4

## Estado

Aceptado

## Contexto

No todo turno de conversación necesita el mismo motor. "Hola", "gracias", "sí confirmo" o un comando
conocido no requieren un LLM caro; una negociación compleja de reagenda sí. Usar el modelo premium
para todo es tirar dinero; usar solo reglas deterministas deja fuera lo que hace útil al asistente.

Se pensó en una escalera de cuatro niveles (determinista → modelo local barato → modelo intermedio →
modelo premium). La pregunta al congelar fue si construir los cuatro, y la respuesta —tras la revisión
de estrés— fue que no. Hay que separar **diseñar para cuatro** de **implementar cuatro**.

## Alternativas consideradas

**Construir los cuatro niveles desde el inicio.** Descartada por sobreingeniería: tres de los cuatro
niveles no tienen evidencia todavía de que se justifiquen. Con capacidades bien cortadas
([ADR-008](ADR-008-capability-registry.md)) el prompt del nivel premium es pequeño (~10 capacidades,
no 40 endpoints) y con buena caché de prefijo ([ADR-019](ADR-019-prompt-builder.md)) el turno premium
puede resultar mucho más barato de lo que la intuición sugiere — quizá tanto que el Nivel 3 nunca se
justifique y el Nivel 2 local jamás.

**Ollama / un modelo local como Nivel 2 en producción.** Descartada por ahora: es un sistema nuevo
(inferencia en el servidor, un modelo que versionar y monitorear) a cambio de un ahorro hipotético.
Se aplaza, posiblemente para siempre — salvo que sea la **ley** (no el costo) la que lo empuje (ver
[ADR-024](ADR-024-persistencia.md), soberanía del dato).

**Un Planner como módulo separado** que descompone objetivos en pasos. Descartada: con capacidades
bien cortadas, un plan son 1–3 capacidades, y el bucle de tool-calling del modelo **ya es** el
planner. Se promovería a módulo propio solo con evidencia de fallos multi-paso.

**Cinco adaptadores de proveedor** para poder cambiar de LLM. Descartada: uno. La abstracción existe
para **poder** cambiar, no para **estar cambiando**.

## Decisión

Se implementan **dos niveles**: **Nivel 1 determinista** (reglas, comandos, sin tokens) y **Nivel 4
premium** (el LLM más capaz, hoy `claude-opus-4-8`). El sistema queda **diseñado para soportar
cuatro**, lo que significa **exactamente tres cosas, ni una más**:

1. La decisión de enrutado es una **política** (una tabla de reglas: "mutación → nivel premium",
   "comando conocido → Nivel 1"), no un `if/else` cableado. Añadir un nivel es añadir filas.
2. El **`ModelPort`** es el único camino hacia un modelo. Un nivel nuevo es un adaptador nuevo, no una
   cirugía.
3. Cada turno **registra qué nivel lo resolvió, con qué costo y con qué resultado**. Eso genera la
   evidencia que algún día justifique (o desmienta) un nivel intermedio.

Si la abstracción cuesta más que esas tres cosas, es prematura. La inversión real no es en niveles: es
en que el **Nivel 1 sea genuinamente bueno** — es el único que nunca falla, nunca cuesta, nunca
alucina y nunca se cae.

## Consecuencias positivas

- Máxima simplicidad hoy con la puerta abierta a más niveles sin rediseño.
- El registro por-nivel convierte la decisión de crecer en un **dato**, no una corazonada.
- Cambiar de proveedor de LLM es cambiar un adaptador.

## Consecuencias negativas

- La tabla de enrutado y el registro de nivel son trabajo por adelantado cuyo pago (más niveles) puede
  no llegar nunca. Es una apuesta consciente y barata.
- Con un solo proveedor real, la abstracción `ModelPort` puede parecer sobrediseño hasta el día que se
  necesite. Aceptado: es un puerto delgado, no una fábrica.

## Impacto futuro

Gobierna cómo el sistema elige y consume modelos. El `ModelPort` es también por donde entra el LLM al
motor que el bot determinista ya condujo ([ADR-015](ADR-015-mvp-determinista.md)). Añadir Ollama, un
nivel intermedio o cambiar de proveedor son evoluciones aditivas detrás del puerto, decididas por la
evidencia que el registro por-nivel vaya acumulando.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 4, escalera de 2 niveles), `architecture/freeze.md` (§D)
- [ADR-008](ADR-008-capability-registry.md), [ADR-015](ADR-015-mvp-determinista.md), [ADR-019](ADR-019-prompt-builder.md)
