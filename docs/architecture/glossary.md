# Glosario — lengua ubicua de EscalApp

**Estado:** documento vivo. Un término aquí significa lo mismo en el código, en los ADRs y en las
conversaciones. Si un término empieza a usarse con dos sentidos, ese es un problema de diseño, no de
vocabulario.

## Plataforma e inquilinos

- **Negocio / inquilino** — un cliente de EscalApp (`id_negocio`). Unidad de aislamiento multi-tenant
  ([ADR-002](../adr/ADR-002-multitenancy.md)).
- **Vertical** — un dominio de producto que un negocio puede operar: reserva, restaurante, gym,
  parqueadero, tienda. Existen y funcionan **sin** IA ([ADR-005](../adr/ADR-005-independencia-verticales.md)).
- **Grupo 1 / Grupo 2** — verticales estables en producción (`general`, `restaurante`: solo cambios
  aditivos) vs. en evolución libre (el resto) ([ADR-003](../adr/ADR-003-madurez-esquemas.md)).

## Identidad ([ADR-006](../adr/ADR-006-persona.md))

- **Persona** — el ser humano, **global**, transversal a inquilinos. Solo ancla identidad; ningún
  inquilino la consulta. No se puebla hasta el Portal del Cliente.
- **PersonaNegocio** — la **relación** de una persona con **un** negocio. Es lo que las verticales
  referencian (FK nullable). Aquí viven nombre-conocido, notas, consentimiento, historial — y,
  mientras el nivel global esté vacío, también el **teléfono operativo**, único por
  `(negocio, teléfono)` ([ADR-025](../adr/ADR-025-identificadores-nivel-global-vacio.md)).
- **Identificador (`persona_identificador`)** — teléfono/email de una persona. Muchos por persona. La
  resolución de identidad busca aquí, no en una columna. **Tabla reservada y vacía** hasta que el
  Portal del Cliente active el nivel global ([ADR-025](../adr/ADR-025-identificadores-nivel-global-vacio.md)).
- **Ficha 360** — vista de lectura que agrega la actividad de una `persona_negocio` (o `persona`) a
  través de verticales. Victoria temprana de la Fase 0.

## Dominio conversacional

- **Capacidad** — acción de negocio que la IA puede ejecutar (`reservar_turno`). No CRUD, no endpoint,
  no SQL ([ADR-007](../adr/ADR-007-capacidades.md)). Único catálogo: el **Capability Registry**.
- **Tool (herramienta)** — término **prohibido** fuera del adaptador de proveedor. Los LLM llaman
  "tools" a su function-calling; nuestras capacidades se *renderizan como* tools solo ahí
  ([ADR-008](../adr/ADR-008-capability-registry.md)).
- **Capability Adapter** — el código que sabe de un dominio concreto (qué es una cita). Vive en
  `intelligence/adapters/<vertical>` y consume el contrato público de la vertical. Es la capa
  anticorrupción ([ADR-009](../adr/ADR-009-capability-adapter.md)).
- **Policy Gate** — la compuerta que autoriza cada ejecución. Inyecta el `id_negocio` (nunca el
  modelo) y aplica las tres capas: comercial → dominio → económica
  ([ADR-010](../adr/ADR-010-ejecucion-segura.md)).
- **propose → hold → confirm** — ciclo de toda mutación: proponer, reservar (hold), confirmar.
- **Business Policy** — límites económicos por inquilino (descuento máximo…), **datos** que la
  capacidad aplica, no instrucciones de prompt ([ADR-011](../adr/ADR-011-business-policy.md)).
- **Business Context** — configuración e instrucciones para el modelo. *Advisory* (el modelo puede
  ignorarlo), a diferencia de Business Policy (*enforced*). Va en el prefijo estable del prompt.
- **Knowledge** — contenido del negocio (menús, PDFs, FAQs). Bounded context **reservado**, no
  implementado ([ADR-020](../adr/ADR-020-knowledge.md)). Va **después** del corte de caché.

## Conversación y canales

- **Contacto → Conversación → Turno → Pasos** — los cuatro niveles del Conversation Engine.
- **Conversación vs Tarea** — la Conversación es el hilo (larga duración); la Tarea es un objetivo
  concreto dentro de ella (reservar). Una conversación tiene varias tareas.
- **Turno** — una unidad de procesamiento: los mensajes agrupados por debounce + la respuesta. Unidad
  de registro de costo/nivel ([ADR-022](../adr/ADR-022-observabilidad.md)).
- **Debounce** — espera breve (2–4 s) para agrupar mensajes seguidos en un turno
  ([ADR-014](../adr/ADR-014-conversation-engine.md)).
- **Canal** — WebChat, WhatsApp… Adaptador de I/O detrás del `ChannelPort`.
- **Mensaje Canónico** — la representación interna de un mensaje, independiente de canal
  ([ADR-017](../adr/ADR-017-channel-gateway.md)).
- **WebChat hostil** — el primer canal: propio, asíncrono, con inyección de fallos. Simulador, no canal
  amable ([ADR-016](../adr/ADR-016-webchat-hostil.md)).
- **Handoff** — pasar la conversación a un humano. Debe tener comportamiento definido cuando no hay
  humano disponible ([ADR-023](../adr/ADR-023-guardarrailes.md)).

## Modelos y ejecución

- **Nivel (de la escalera)** — Nivel 1 = determinista (sin tokens); Nivel 4 = premium (LLM). Se
  implementan 2, se diseña para 4 ([ADR-018](../adr/ADR-018-estrategia-modelos.md)).
- **ModelPort** — el único camino hacia un modelo. Un nivel/proveedor nuevo es un adaptador nuevo.
- **Prompt Builder** — ensambla el prompt de estable→volátil, con la fecha **siempre** al final, para
  preservar la caché de prefijo ([ADR-019](../adr/ADR-019-prompt-builder.md)).

## Eventos e integración

- **Outbox** — tabla en `platform` donde se escribe el evento **en la misma transacción** que la
  mutación. Un relay lo entrega (≥1 vez → consumidores idempotentes)
  ([ADR-012](../adr/ADR-012-outbox.md)).
- **Evento de dominio** — hecho ocurrido, `<agregado>.<hecho>.v<n>`, delgado y versionado
  ([ADR-013](../adr/ADR-013-catalogo-eventos.md)). Catálogo en [domain-events.md](domain-events.md).
- **Feature / entitlement** — interruptor comercial de un plan. Se consulta con `estaHabilitado`, nunca
  el plan directamente ([ADR-021](../adr/ADR-021-features.md)).

## Pruebas y garantías

- **Test del apagón** — apagar Intelligence y correr la suite de las verticales; debe pasar. Prueba
  ejecutable del principio de independencia ([ADR-005](../adr/ADR-005-independencia-verticales.md)).
- **Conversaciones doradas** — conjunto pequeño (20–30) de conversaciones de referencia del arnés de
  evaluación. Corren en dry-run por defecto; con modelo real, bajo demanda.
- **Ledger de costos** — registro contable (no telemetría) de costo/nivel/tokens por turno, en
  `intelligence` ([ADR-022](../adr/ADR-022-observabilidad.md)).
