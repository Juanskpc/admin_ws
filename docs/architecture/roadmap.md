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

> **F0 implementada en local el 2026-07-31** (aún NO desplegada en producción). Esquema
> `platform` ([ADR-025](../adr/ADR-025-identificadores-nivel-global-vacio.md)),
> `pedid_orden.id_persona_negocio`, backfill, camino de escritura best-effort y Ficha 360 en
> `/admin/personas`. La vista se ubicó en el admin y no en `restaurante_app` porque el 98% de
> las personas pertenece a un solo negocio: todavía no hay a quién demostrársela.

| Fase | Qué | ADRs clave | Corrección de revisión |
|---|---|---|---|
| **F0** | `platform.persona` / `persona_negocio` / `persona_identificador`; nivel global vacío. **Backfill solo de `restaurante`** (gym/parqueadero/tienda no tienen datos) **+ camino de escritura**: `pedid_orden.id_persona_negocio` (FK nullable) y resolución best-effort al crear la orden. **Entregable visible: Ficha 360.** | 006, 024 | Backfill reducido; Ficha 360 como victoria temprana; camino de escritura añadido 2026-07-31 |
| **F1** | Outbox transaccional en `platform` + relay. **Hecho en local 2026-08-01** (sin desplegar): `platform.outbox`, `outboxDao.emitir()` (exige transacción), relay con `FOR UPDATE SKIP LOCKED`, backoff exponencial y dead letter. **Ninguna vertical emite todavía** y el relay arranca inactivo: un evento se define cuando hay productor Y consumidor ([ADR-013](../adr/ADR-013-catalogo-eventos.md) regla 4), y el primer consumidor llega en F4/F5. | 012 | El `master-plan` metía en F1 "toda transición emite su evento"; se difiere a la adopción de cada vertical por la regla 4 |
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
6. ~~Tarea de media hora previa a F0: **medir la calidad de los teléfonos en `restaurante`**~~
   **HECHO (2026-07-31)** → [`mediciones/2026-07-31-calidad-telefonos-restaurante.md`](../mediciones/2026-07-31-calidad-telefonos-restaurante.md).
   El dato no es basura (94.8% móviles válidos, 95.3% activos en 90 días), pero la población es
   de **621 personas y el 98% pertenece a un solo negocio**. Consecuencias: el backfill es
   trivial (una migración simple, sin lotes ni job); hace falta una regla de elección para
   `nombre_mostrado` (20.3% de los móviles tiene 2+ nombres); y el alcance de F0 se amplió para
   incluir el camino de escritura (ver punto 7).

7. **F0 incluye el camino de escritura** (decidido 2026-07-31). Sin él, la Ficha 360 queda
   congelada en la foto del backfill y envejece con cada pedido nuevo. No amplía la
   arquitectura: `freeze.md` §B ya lista `pedid_orden.id_persona_negocio` y
   `bounded-contexts.md` ya autoriza la FK nullable vertical → `platform`. Restricciones que
   se derivan de los invariantes ya congelados:
   - La FK es **nullable** y la resolución es **best-effort**: si resolver o crear el
     `persona_negocio` falla, la orden se crea igual con `id_persona_negocio = NULL`. Una
     vertical funciona sin persona ([ADR-006](../adr/ADR-006-persona.md)); la caja de un
     restaurante no puede caerse por el módulo de identidad.
   - `restaurante` es Grupo 1: **solo cambios aditivos** ([ADR-003](../adr/ADR-003-madurez-esquemas.md),
     `freeze.md` §C.8). Añadir una columna nullable lo es; modificar las existentes, no.
   - La resolución es **síncrona dentro de la transacción de la orden**. La alternativa
     asíncrona exige el outbox, que es F1: resolver con lo que existe hoy
     ([architecture-principles.md](architecture-principles.md), arquitectura evolutiva).
   - Sigue sin haber dependencia hacia Intelligence: la flecha es vertical → `platform`, no
     vertical → `intelligence`. El test del apagón no se ve afectado.

## Antes del MVP comercial (fuera de nuestro control, empezar con antelación)

- **Verificación de negocio con Meta** para WhatsApp: semanas de plazo, bloquea F8.
- **Base legal de transferencia internacional de PII** (Ley 1581): resolver antes del primer cliente
  empresarial ([ADR-024](../adr/ADR-024-persistencia.md)).
