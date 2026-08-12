# Lenguaje de capacidades — EscalApp

**Estado:** documento vivo.
**Gobernado por:** [ADR-007](../adr/ADR-007-capacidades.md) (qué es una capacidad),
[ADR-008](../adr/ADR-008-capability-registry.md) (registro único),
[ADR-009](../adr/ADR-009-capability-adapter.md) (adaptador),
[ADR-010](../adr/ADR-010-ejecucion-segura.md) (ejecución segura).

> **Propósito doble.** (1) Definir el **metamodelo**: qué campos declara una capacidad. (2) Servir de
> **ejercicio en papel**: escribir los manifiestos de *reserva* y *restaurante* **antes** de construir
> el Registry, para comprobar que el metamodelo expresa los dos sin cambiar. Reserva (cita puntual e
> idempotente) y restaurante (carrito acumulativo y mutable) son deliberadamente distintos: esa
> diferencia es justo la que estresa el metamodelo. Si algo no cabe, es mucho mejor descubrirlo aquí
> que en producción.

---

## 1. Metamodelo (qué declara una capacidad)

Una capacidad es una **acción de negocio**, no CRUD ([ADR-007](../adr/ADR-007-capacidades.md)).
Su declaración contiene:

| Campo | Qué es | Notas |
|---|---|---|
| `nombre` | Identificador en español, verbo de negocio | `reservar_turno`, no `crear_cita` |
| `descripcion` | Frase para el modelo: cuándo usarla | Va al prompt; se renderiza como "tool" del proveedor (ADR-008) |
| `parametros` | Esquema de entrada que el modelo llena | **Nunca** incluye `id_negocio` (lo inyecta la plataforma, ADR-010) |
| `tipo` | `consulta` \| `mutacion` | Las `mutacion` siguen propose→hold→confirm (ADR-010) |
| `idempotente` | ¿Repetirla produce el mismo efecto? | Ver §4: aquí divergen reserva y restaurante |
| `politica` | Límites de Business Policy que aplica | Ej. `descuento_maximo` (ADR-011) |
| `vertical` | A qué adaptador pertenece | El adaptador vive en `intelligence/adapters/<vertical>` (ADR-009) |
| `feature` | Entitlement requerido | Se consulta con `estaHabilitado` (ADR-021) |

Los **pasos internos** (buscar disponibilidad, tomar hold, escribir, emitir evento) **no** se declaran:
son detalle de implementación privado de la capacidad ([ADR-008](../adr/ADR-008-capability-registry.md)).

---

## 2. Manifiesto: `reserva` (borrador en papel)

| Capacidad | tipo | idempotente | Parámetros (sin `id_negocio`) | Emite | Estado |
|---|---|---|---|---|---|
| `consultar_servicios` | consulta | — | `{}` | — | ✅ F4-A |
| `consultar_disponibilidad` | consulta | — | `{ id_servicio, fecha, id_profesional? }` | — | ✅ F4-A |
| `proponer_turno` | mutacion | **no** (cada llamada aparta un hueco nuevo) | `{ id_servicio, inicio, id_profesional? }` | — | ✅ F4-B |
| `reservar_turno` | mutacion | **sí** (el hold se consume al confirmarlo) | `{ codigo_hold, cliente_nombre, cliente_telefono?, notas? }` | *(pendiente de consumidor)* | ✅ F4-B |
| `reagendar_cita` | mutacion | sí | `{ codigo_cita, codigo_hold }` | *(pendiente de consumidor)* | ✅ F4-B |
| `cancelar_cita` | mutacion | sí | `{ codigo_cita, motivo? }` · política `ventana_cancelacion_horas` | *(pendiente de consumidor)* | ✅ F4-B |
| `consultar_mis_citas` | consulta | — | `{ id_persona_negocio }` | — | ⬜ bloqueada: `reserva_cita` no tiene `id_persona_negocio` |

**Seis capacidades, techo diez.** Queda margen, y conviene defenderlo.

**El ciclo `propose → hold → confirm` está cortado en dos capacidades**, `proponer_turno` y
`reservar_turno`. Pasa el test que el plan impone —«si una capacidad obliga a llamar a otra
después para dejar el sistema consistente, están mal cortadas»— porque **no obliga a nada**:
si `reservar_turno` no llega nunca, el hold expira solo y la agenda queda como estaba.

**Los eventos siguen sin emitirse**, aunque las mutaciones ya existan. Un evento se define
cuando hay productor **y** consumidor ([ADR-013](../adr/ADR-013-catalogo-eventos.md) regla 4)
y el primer consumidor llega en F5. Emitir ahora congelaría un contrato que nadie lee.

**Los parámetros usan `codigo_*` (uuid) y no `id_cita`.** Ver la nota de la Ola B en
[`roadmap.md`](roadmap.md): un entero secuencial dejaría cancelar la cita de otro cliente del
mismo negocio contando hacia arriba.

**Por qué `consultar_mis_citas` está bloqueada.** Necesita el punto 1 del Contrato de
Adopción (§5): `reserva` todavía no adoptó `platform.persona`. F0 solo lo hizo en
`restaurante`.

`consultar_disponibilidad` ganó `id_profesional?` respecto al papel: el servicio de dominio
de la vertical exige un profesional concreto (nació para un formulario donde ya estaba
elegido), y la pregunta de negocio —«¿hay hueco el martes?»— no lo tiene. El adaptador funde
las agendas de todos los profesionales que prestan el servicio y devuelve, con cada hora,
quién la atiende. Es exactamente el trabajo anticorrupción de
[ADR-009](../adr/ADR-009-capability-adapter.md).

**Forma dominante:** una cita es un **punto** en el tiempo. `reservar_turno` es naturalmente
idempotente (el mismo cliente, mismo slot → una cita). El objetivo se cumple en 1–2 capacidades.

## 3. Manifiesto: `restaurante` (borrador en papel)

| Capacidad | tipo | idempotente | Parámetros (sin `id_negocio`) | Emite |
|---|---|---|---|---|
| `consultar_menu` | consulta | — | `{ categoria? }` | — |
| `iniciar_pedido` | mutacion | sí (uno abierto por conversación) | `{ tipo: "domicilio"\|"mesa"\|"recoger" }` | `pedido.creado.v1` |
| `agregar_item` | mutacion | **no** (acumula) | `{ id_orden, id_producto, cantidad, notas? }` | — |
| `quitar_item` | mutacion | no | `{ id_orden, id_linea }` | — |
| `confirmar_pedido` | mutacion | sí | `{ id_orden, direccion?, metodo_pago }` | `pedido.pagado.v1` |
| `consultar_estado_pedido` | consulta | — | `{ id_orden }` | — |

**Forma dominante:** un pedido es un **carrito acumulativo**. `agregar_item` se ejecuta muchas veces en
la misma conversación, mutando estado que crece. El objetivo se cumple en N capacidades encadenadas.

---

## 4. Conclusión del estrés (¿el metamodelo aguanta los dos?)

**Sí, con una condición que el ejercicio hizo explícita.** La diferencia dura entre las dos verticales
es `idempotente`:

- En reserva, la acción central es **idempotente y de un disparo** (`reservar_turno`).
- En restaurante, la acción central (`agregar_item`) es **no idempotente y acumulativa**: repetirla
  **añade** otra unidad. Un metamodelo que asumiera "toda capacidad de mutación es idempotente" —una
  suposición fácil de colar mirando solo reservas— **no expresaría un pedido**.

Por eso el metamodelo declara `idempotente` como campo de primera clase (§1), y por eso el ciclo
propose→hold→confirm ([ADR-010](../adr/ADR-010-ejecucion-segura.md)) distingue el *hold* (reservar el
slot / mantener el carrito abierto) de la *confirmación* (crear la cita / cerrar y cobrar el pedido).
El estado intermedio acumulativo del carrito **es** el hold de restaurante.

**Resultado:** el metamodelo de §1 expresa ambas verticales sin cambios. El ejercicio se considera
superado. Cualquier vertical futura (gym, parqueadero, tienda, veterinaria) debe pasar este mismo
papel antes de tocar el Registry.

---

## 5. Contrato de Adopción de una vertical (peaje para ser adoptada por Intelligence)

De `revision-01.md`, punto 6. Una vertical es adoptable cuando cumple las seis:

1. Adopta `platform.persona` (`id_persona_negocio` nullable, poblado en registros nuevos).
2. Protege sus invariantes en el **dominio**, no en el formulario.
3. Emite sus eventos de dominio al **outbox** de `platform`, en todas sus transiciones.
4. Publica su **manifiesto de capacidades** (máx. ~10, acciones de negocio, no CRUD).
5. Tiene su **Capability Adapter** en `intelligence/adapters/<vertical>`.
6. Aporta sus **conversaciones doradas** al arnés de evaluación.

### Estado del contrato en `reserva` (la vertical piloto)

| # | Punto | Estado |
|---|---|---|
| 1 | Adopta `platform.persona` | ⬜ `reserva_cita` no tiene `id_persona_negocio`. Bloquea `consultar_mis_citas`. |
| 2 | Invariantes en el dominio | ✅ **F3** (2026-08-03) |
| 3 | Emite eventos al outbox | ⬜ A propósito: un evento se define cuando hay productor **y** consumidor ([ADR-013](../adr/ADR-013-catalogo-eventos.md) regla 4). El primer consumidor llega en F5. |
| 4 | Manifiesto publicado | ✅ §2 de este documento |
| 5 | Capability Adapter | ✅ **F4-A + F4-B** (2026-08-03) |
| 6 | Conversaciones doradas | ⬜ F6 |

Cumple 3 de 6. Los dos que faltan —adoptar `persona` y emitir eventos— están ambos
bloqueados por decisiones **deliberadas**, no por falta de trabajo: el nivel global de
identidad no se puebla hasta el Portal del Cliente
([ADR-025](../adr/ADR-025-identificadores-nivel-global-vacio.md)) y un evento no se define
sin consumidor ([ADR-013](../adr/ADR-013-catalogo-eventos.md) regla 4).
