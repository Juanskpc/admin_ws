# Registros de Decisiones Arquitectónicas (ADR) — EscalApp

Esta colección es la **fuente oficial de verdad** de la arquitectura de EscalApp.
No documenta cómo se implementa el sistema, sino **por qué está diseñado como está**.

La implementación cambiará. Los frameworks cambiarán. Los modelos de IA cambiarán.
El razonamiento arquitectónico debe permanecer.

## Cómo leer esto

Cada ADR responde siempre la misma pregunta: **"¿por qué se tomó esta decisión?"** — no solo
"¿qué se decidió?". Las **alternativas descartadas** son tan importantes como la elegida: son la
parte del razonamiento que normalmente se pierde.

Si eres nuevo en el proyecto, lee en orden ADR-001 → ADR-006. Con eso entiendes la forma general.

> **Precedencia.** Por encima de estos ADRs está la constitución del proyecto:
> [`architecture-principles.md`](../architecture/architecture-principles.md). Si un ADR contradice un
> principio, gana el principio y la contradicción se reconcilia antes de escribir código. Orden
> completo: Principios → ADRs → Congelación → Roadmap → Implementación.

## Convenciones

- **Un ADR = una decisión.** (ADR-006, 010 y 024 agrupan sub-decisiones que son *una sola elección
  con varias caras*; cada uno lo justifica internamente.)
- **Los ADR son inmutables.** No se editan. Si una decisión cambia, se escribe un ADR nuevo que la
  reemplaza; el viejo pasa a estado `Reemplazado por ADR-NNN` y se conserva. El razonamiento
  histórico nunca se borra.
- **La numeración es estable y no se reutiliza.** Si un ADR queda obsoleto, su número muere con él.
- **Honestidad obligatoria.** Donde elegimos por ser un equipo de una persona y no por superioridad
  técnica, el ADR lo dice con esas palabras, en "Consecuencias negativas".

## Estados

`Propuesto` · `Aceptado` · `Reemplazado por ADR-NNN` · `Obsoleto`

## Índice

### Fundamentos de plataforma
- [ADR-001 — Visión: la conversación al centro](ADR-001-vision.md) · Aceptado
- [ADR-002 — Multi-tenancy: esquema-por-vertical + `id_negocio`](ADR-002-multitenancy.md) · Aceptado
- [ADR-003 — Asimetría de madurez de esquemas](ADR-003-madurez-esquemas.md) · Aceptado
- [ADR-004 — Separación `platform` / `intelligence`](ADR-004-platform-intelligence.md) · Aceptado
- [ADR-005 — Independencia de las verticales (el test del apagón)](ADR-005-independencia-verticales.md) · Aceptado

### Identidad
- [ADR-006 — Modelo Persona / PersonaNegocio / Identificador](ADR-006-persona.md) · Aceptado
- [ADR-025 — Dónde viven los identificadores mientras el nivel global está vacío](ADR-025-identificadores-nivel-global-vacio.md) · Aceptado

### Dominio y capacidades
- [ADR-007 — Arquitectura basada en Capacidades](ADR-007-capacidades.md) · Aceptado
- [ADR-008 — Capability Registry único](ADR-008-capability-registry.md) · Aceptado
- [ADR-009 — Capability Adapter = Anticorruption Layer](ADR-009-capability-adapter.md) · Aceptado
- [ADR-010 — Ejecución segura: Policy Gate, `id_negocio`, propose→hold→confirm](ADR-010-ejecucion-segura.md) · Aceptado
- [ADR-011 — Business Policy como dato enforced](ADR-011-business-policy.md) · Aceptado

### Eventos
- [ADR-012 — Outbox transaccional en `platform`](ADR-012-outbox.md) · Aceptado
- [ADR-013 — Catálogo de eventos de dominio](ADR-013-catalogo-eventos.md) · Aceptado

### Conversación y canales
- [ADR-014 — Conversation Engine](ADR-014-conversation-engine.md) · Aceptado
- [ADR-015 — MVP determinista antes del LLM](ADR-015-mvp-determinista.md) · Aceptado
- [ADR-016 — WebChat hostil como primer canal](ADR-016-webchat-hostil.md) · Aceptado
- [ADR-017 — Channel Gateway y Mensaje Canónico](ADR-017-channel-gateway.md) · Aceptado

### Capa de modelos
- [ADR-018 — Estrategia de modelos: escalera de 2 niveles diseñada para 4](ADR-018-estrategia-modelos.md) · Aceptado
- [ADR-019 — Prompt Builder y disciplina de caché](ADR-019-prompt-builder.md) · Aceptado
- [ADR-020 — Knowledge como bounded context reservado](ADR-020-knowledge.md) · Aceptado *(impl. diferida)*

### Transversales
- [ADR-021 — Features / entitlements](ADR-021-features.md) · Aceptado
- [ADR-022 — Observabilidad y Ledger de costos](ADR-022-observabilidad.md) · Aceptado
- [ADR-023 — Guardarraíles de producto: promesas y handoff](ADR-023-guardarrailes.md) · Aceptado *(2026-08-19, al empezar F7)*
- [ADR-024 — Convenciones de persistencia y gobierno de datos](ADR-024-persistencia.md) · Aceptado
- [ADR-026 — Facturación electrónica: integrar un proveedor tecnológico, no construir el emisor](ADR-026-facturacion-electronica.md) · **Propuesto** *(2026-09-01)*

## Documentos relacionados (en `/docs/architecture`)

**Narrativa extensa (el porqué, en prosa):**
- `SPEC_AI_CORE_ESCALAPP.md` — documento seminal (2026-07-12), anterior a los ADRs. Se conserva por
  su valor histórico y con su nombre original (ADR-017 lo referencia); donde contradiga a un ADR,
  **gana el ADR**.
- `master-plan.md` — el plan maestro completo (11 fases / 4 olas)
- `revision-01.md` — la primera revisión crítica de estrés
- `freeze.md` — el acta de congelación de la arquitectura

**Documentos vivos (el qué actual; se actualizan aditivamente):**
- [`roadmap.md`](../architecture/roadmap.md) — plan de construcción, olas F0–F10 e hitos
- [`bounded-contexts.md`](../architecture/bounded-contexts.md) — mapa de contextos y dirección de dependencias
- [`glossary.md`](../architecture/glossary.md) — la lengua ubicua
- [`capability-language.md`](../architecture/capability-language.md) — metamodelo + manifiestos reserva/restaurante en papel
- [`domain-events.md`](../architecture/domain-events.md) — catálogo vivo de eventos
