# Roadmap — EscalApp Intelligence

**Estado:** documento vivo. Es el plan de construcción, ya incorporadas las correcciones de
`revision-01.md`. La arquitectura está congelada (`freeze.md`); el orden de construcción puede
ajustarse, la espina dorsal no.

> **Tesis** ([ADR-015](../adr/ADR-015-mvp-determinista.md)): construimos el sistema completo **sin IA**.
> Cuando funcione, le conectamos la IA como un cliente más.

## Principios de construcción

1. El riesgo se retira antes de gastar (lo determinista antes que el LLM).
2. La IA se conecta al final de cada capa, no al principio.
3. Se explota la asimetría de madurez de esquemas ([ADR-003](../adr/ADR-003-madurez-esquemas.md)).
4. Un dev = un frente a la vez.

## Hitos

- **F5 → MVP interno** (bot determinista extremo a extremo, sin IA).
- **F8 → MVP comercial** (WhatsApp con IA).
- **F9 → plataforma multi-vertical** (restaurante adoptada con `git diff = 0` en el núcleo).

## Olas y fases

### Ola A — cimientos (sin nada demo-able de IA; victoria temprana = Ficha 360)

| Fase | Qué | ADRs clave | Corrección de revisión |
|---|---|---|---|
| **F0** | `platform.persona` / `persona_negocio` / `persona_identificador`; nivel global vacío. **Backfill solo de `restaurante`** (gym/parqueadero/tienda no tienen datos). **Entregable visible: Ficha 360.** | 006, 024 | Backfill reducido; Ficha 360 como victoria temprana |
| **F1** | Outbox transaccional en `platform` + relay. | 012 | — |
| **F2** | AuthZ: inyección de `id_negocio`, base del Policy Gate. | 010, 002 | — |
| **F3** | Saneamiento de invariantes de `reserva` (protección en dominio, no formulario). **Framing: mejora propia de la vertical, no prerequisito de la IA.** | 003, 009 | Reencuadre según punto 10 |

### Ola B — el motor sin IA

| Fase | Qué | ADRs clave | Corrección |
|---|---|---|---|
| **F4** | Capability Registry **único** + Policy Gate (3 capas) + Capability Adapter. Manifiestos de reserva **y restaurante en papel** antes de construir. | 007, 008, 009, 011, 021 | Tool Registry eliminado; manifiesto restaurante en papel |
| **F5** | Conversation Engine **determinista** (FIFO+lock+debounce) + **WebChat hostil** con inyección de fallos + **Ledger de costos** + **Intelligence Console** con datos reales. **→ MVP INTERNO.** | 014, 015, 016, 017, 022 | Telegram fuera; Console+Observabilidad convergen aquí, datos reales |

### Ola C — la IA entra

| Fase | Qué | ADRs clave | Corrección |
|---|---|---|---|
| **F6** | Primer LLM **solo-lectura** por el `ModelPort` + Prompt Builder con disciplina de caché + arnés de evaluación (dry-run por defecto). | 018, 019, 020 | Escalera de 2 niveles; Knowledge reservado (ranura vacía) |
| **F7** | Mutaciones vía IA (propose→hold→confirm) + **guardarraíl de promesas** + Consola de Handoff (con comportamiento sin-humano). | 010, 023 | ADR-023 pasa de Propuesto a Aceptado aquí |
| **F8** | WhatsApp como canal (mismo `ChannelPort`; captura de body crudo para firma de Meta). **→ MVP COMERCIAL.** | 016, 017 | — |

### Ola D — plataforma

| Fase | Qué | ADRs clave | Corrección |
|---|---|---|---|
| **F9** | Adopción de **restaurante** (Contrato de Adopción; **`git diff = 0` en el núcleo**). **→ PLATAFORMA MULTI-VERTICAL.** | 009, capability-language | Valida el agnosticismo real |
| **F10** | Escala: retención/particionado en caliente, y —solo con evidencia— niveles intermedios / broker detrás del outbox. | 018, 022, 024 | Ollama/broker solo si la evidencia lo pide |

## Decisiones que deben tomarse ANTES de la primera línea (de `freeze.md` §D)

1. `platform.persona` global existe vacío desde el día uno. **(recomendado sí)**
2. El cliente final nunca vive en `gener_usuario`. **(confirmado)**
3. Tool Registry eliminado. **(sí)**
4. Riesgo de promesas no respaldadas: anotado hoy, mecanismo antes de F7.
5. `persona_identificador` como tabla hija (bloqueó la congelación hasta corregirlo).
6. Tarea de media hora previa a F0: **medir la calidad de los teléfonos en `restaurante`** (única
   fuente real del backfill; si es basura, la Ficha 360 nace coja).

## Antes del MVP comercial (fuera de nuestro control, empezar con antelación)

- **Verificación de negocio con Meta** para WhatsApp: semanas de plazo, bloquea F8.
- **Base legal de transferencia internacional de PII** (Ley 1581): resolver antes del primer cliente
  empresarial ([ADR-024](../adr/ADR-024-persistencia.md)).
