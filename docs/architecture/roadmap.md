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
| **F2** | AuthZ: inyección de `id_negocio`, base del Policy Gate. **Hecho en local 2026-08-01** (sin desplegar): `Principal` + middleware `exigirPertenenciaNegocio` montado en las 6 verticales. **La vulnerabilidad era real y se reprodujo**: el admin del negocio 3 leía las mesas del negocio 1 con su propio token y el backend respondía `success: true`. Verifica **pertenencia**, no permisos por rol — `(rol, capacidad)` necesita el catálogo de F4; los roles ya se resuelven en el Principal y quedan listos ahí. **Despliegue obligatorio en `AUTHZ_MODO=observacion` primero.** | 010, 002 | Modo observación antes de bloquear; tipo `contacto` del Principal reservado sin implementar (P13) |
| **F3** | Saneamiento de invariantes de `reserva` (protección en dominio, no formulario). **Hecho en local 2026-08-03** (sin desplegar): reglas de agenda unificadas, `crearCita` valida horario y bloqueos, máquina de estados, hold con TTL y 31 tests hostiles. **El desajuste de buffer era real y se reprodujo**: con `buffer=30`, disponibilidad ofrecía las 10:45 tras una cita de 10:00–10:30 y `crearCita` la rechazaba con 409. | 003, 009, 010 | Reencuadre según punto 10; dejó de ser opcional al ser prerequisito de F4-B |

### Ola B — el motor sin IA

| Fase | Qué | ADRs clave | Corrección |
|---|---|---|---|
| **F4-A** | Capability Registry **único** + Policy Gate + costura `estaHabilitado` + dry-run + auditoría + CLI + adaptador piloto de `reserva` **solo de consulta**. **Hecho en local 2026-08-03** (sin desplegar). | 007, 008, 009, 010, 021 | Tool Registry eliminado; manifiestos en papel ya superados (`capability-language.md` §4); fase partida en A/B al implementar (ver abajo) |
| **F4-B** | Las **mutaciones** del adaptador de reserva (`proponer_turno`, `reservar_turno`, `reagendar_cita`, `cancelar_cita`), `platform.capacidad_idempotencia` y la capa **económica** declarada. **Hecha en local 2026-08-03**, después de F3. | 010, 011 | Nueva; separada de F4-A por la dependencia con F3. **No** se creó `platform.business_policy`: ver abajo |
| **F5-A** | Esquema `intelligence` + **Ledger** particionado y con retención. **Hecho en local 2026-08-03.** Es la parte **irreversible** de F5 (ADR-022: lo que no se registre hoy no se podrá responder nunca), por eso va primero. | 022, 024 | Nueva subdivisión: F5 es la fase más grande del plan |
| **F5-B** | Conversation Engine: conversación/turno/paso, cola FIFO por conversación, lock pesimista, debounce, continuidad tras reinicio. **Hecho en local 2026-08-05** (sin desplegar): `intelligence/engine/` (motor, cola, repositorio), arnés `scripts/conversacion.js` y 16 tests. **No hizo falta migración**: el esquema entero lo creó F5-A. Los tres mecanismos de ADR-014 se verificaron **al revés**, rompiéndolos: sin debounce la ráfaga da 5 turnos, sin lock da 2, sin savepoint el turno fallido desaparece del Ledger. | 014 | La cola es en memoria, no BullMQ: ver abajo |
| **F5-C** | Channel Gateway + Mensaje Canónico + **WebChat hostil** con inyección de fallos. **Hecho en local 2026-08-06** (sin desplegar): `intelligence/channels/`, `core/mensajeCanonico.js`, superficie HTTP en `intelligence/http.js` y widget de pruebas. Migración `migrate:intelligence-canal` (dos columnas sobre tablas vacías). 14 tests: cada fallo inyectable contra el bug que ADR-016 dice que caza. | 016, 017 | Primera exposición HTTP de Intelligence: ver abajo |
| **F5-D** | Motor determinista (Nivel 1: FSM, regex, menús) + Identity Resolver. | 015 | — |
| **F5-E** | **Intelligence Console** con datos reales. **→ MVP INTERNO.** | 022 | Prohibido construirla con datos simulados |

> **Por qué F4 se partió en A y B (descubierto al implementar, 2026-08-03).** El roadmap
> permitía saltarse F3 porque `reserva` tiene 0 filas en producción, pero el adaptador piloto
> de F4 **es** de `reserva`, y sus mutaciones chocan con dos cosas que F3 entrega:
>
> 1. `crearCita` no valida horario laboral ni bloqueos, y disponibilidad usa medio buffer
>    mientras creación usa el buffer completo. Implementar `reservar_turno` hoy obligaría a
>    compensar esas invariantes **en el adaptador**. Eso es legítimo para el Grupo 1
>    (`restaurante`, congelado) pero **incorrecto para el Grupo 2**: [ADR-003](../adr/ADR-003-madurez-esquemas.md)
>    manda empujar la invariante al dominio, y el propio `master-plan` §F3 avisa de que
>    hacerlo en el adaptador duplica la invariante y deja la API web igual de rota.
> 2. El *hold* con TTL que exige `propose → hold → confirm` ([ADR-010](../adr/ADR-010-ejecucion-segura.md))
>    es un **entregable de F3**, no de F4.
>
> Además, `consultar_mis_citas` del manifiesto en papel necesita
> `reserva_cita.id_persona_negocio`, que no existe: F0 solo adoptó `platform.persona` en
> `restaurante`. Es el punto 1 del Contrato de Adopción (`capability-language.md` §5).
>
> Las **consultas** no dependen de nada de eso —no escriben, no tienen invariantes que
> proteger, no necesitan identidad—, así que F4-A las entrega y con ellas todo el núcleo.
> **Orden ejecutado: F4-A → F3 → F4-B.**

> **Dos desviaciones de F4-B respecto al papel (decididas al implementar, 2026-08-03).**
>
> 1. **No existe `platform.business_policy`.** ADR-011 fija dónde se *aplica* un límite
>    —«un valor que la capacidad lee y hace cumplir dentro de su transacción»— y no dice
>    dónde se guarda; `bounded-contexts.md` tampoco lo lista entre lo que posee `platform`.
>    El primer límite real, `ventana_cancelacion_horas`, **ya vive** en `reserva_config` y la
>    vertical ya lo aplica. Copiarlo a `platform` daría dos fuentes de verdad para el mismo
>    número. La capa 3 del Gate declara y audita qué límites gobiernan cada invocación; el
>    enforcement se queda donde ADR-011 lo puso. El día que aparezca un límite sin casa en
>    ninguna vertical (`descuento_maximo` es el candidato), ése traerá su almacén.
>
> 2. **Las capacidades usan handles públicos `uuid`, no `id_cita`.** El manifiesto en papel
>    decía `cancelar_cita { id_cita }`. Un entero secuencial dejaría que quien hable con el
>    asistente cancele la cita de otro cliente **del mismo negocio** contando hacia arriba:
>    el Policy Gate impone el `id_negocio`, pero dentro del negocio no distingue clientes
>    porque `reserva` todavía no adoptó `platform.persona`. `reserva_cita.codigo_publico`
>    existe exactamente para esto.
>
> Y una consecuencia que conviene no «arreglar»: como falta `consultar_mis_citas`, el
> asistente **solo puede tocar citas cuyo código ya conoce** —las que él mismo creó—. No
> puede enumerar las de un cliente. Hasta que `reserva` adopte `persona`, ése es el límite
> correcto, no una carencia.

> **Nota de F5-A: `tool_call` no existe (2026-08-03).** ADR-022 llama `tool_call` a uno de
> los componentes del Ledger, pero [ADR-008](../adr/ADR-008-capability-registry.md) reserva
> la palabra «tool» **exclusivamente** para el adaptador del `ModelPort` y avisa de que si
> aparece en el núcleo es síntoma de que una abstracción se filtró. Un nombre de tabla es
> para siempre, así que gana ADR-008 —regla de vocabulario explícita y con enforcement
> declarado— frente a un nombre que ADR-022 usa de pasada. La tabla es
> **`intelligence.invocacion_capacidad`**, y hay un test que impide que «tool» vuelva a
> colarse en el esquema.

> **Nota de F5-B: la cola es en memoria y BullMQ sigue sin usarse (2026-08-05).** ADR-014 y el
> `master-plan` nombran BullMQ, que además ya está instalado. No se usó: hoy no hay Redis en
> local, el proceso es uno solo, y una cola distribuida cuyo único cliente es un proceso único
> no pasa el test de simplicidad. Lo que hace que la decisión sea reversible sin riesgo es que
> **la corrección no depende de la cola**: lo que impide que dos procesos pisen la misma
> conversación es el **lock pesimista en la base de datos**, no el reparto del trabajo. La cola
> solo evita trabajo que el lock rechazaría. Cambiarla por BullMQ el día que haya varios
> procesos es un cambio de rendimiento detrás de la misma interfaz, no de seguridad. El
> precedente de degradar a una cola en proceso ya estaba en el `reporteWorker` de parqueadero.
>
> **Y el outbox sigue sin consumidores, también a propósito.** F5 es la fase donde el
> `master-plan` esperaba el primer consumidor de eventos, pero dentro de F5-B no hay ninguno:
> el motor reacciona a **mensajes de un canal**, no a hechos del dominio. El primer consumidor
> real es la confirmación proactiva por canal —«tu cita quedó agendada»—, que necesita el
> Channel Gateway. Así que la decisión de qué eventos de [`domain-events.md`](domain-events.md)
> se activan es de **F5-C**, no de aquí: activarlos ahora sería definir un contrato sin nadie
> al otro lado, que es justo lo que prohíbe la regla 4 de [ADR-013](../adr/ADR-013-catalogo-eventos.md).

> **Nota de F5-C: Intelligence ya se expone por HTTP, detrás de dos guardas (2026-08-06).**
> `app.js` monta `/intelligence` solo si (1) el directorio existe y (2)
> `INTELLIGENCE_HTTP_ENABLED=true`. La primera guarda mantiene **literal** el test del apagón
> de [ADR-005](../adr/ADR-005-independencia-verticales.md) —se comprobó moviendo `intelligence/`
> fuera y arrancando el backend, que sigue en pie—; la segunda existe porque **estas rutas no
> están autenticadas**: un widget lo usa un cliente final anónimo y el `Principal` de tipo
> `contacto` sigue reservado sin implementar. Hoy solo las protege la feature comercial del
> negocio. La clave pública por negocio y los orígenes permitidos son de F8.
>
> **Y el outbox sigue sin consumidores, por tercera fase consecutiva.** F5-B lo aplazó a F5-C
> porque «la confirmación proactiva es un consumidor de `cita.creada.v1` y necesita el canal».
> El canal ya está, y sigue sin activarse: el motor no sabe todavía **decidir** nada —el
> manejador es el andamio de eco— así que un evento entrante no tendría a quién despertar.
> Una confirmación proactiva es una conversación que **el negocio inicia**, y eso necesita el
> motor determinista. Queda para **F5-D**, y ahí ya no hay excusa: es la última pieza que
> faltaba. Definir el evento antes sería un contrato sin nadie al otro lado (ADR-013, regla 4).

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
