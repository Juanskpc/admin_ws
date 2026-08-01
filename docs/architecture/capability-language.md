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

| Capacidad | tipo | idempotente | Parámetros (sin `id_negocio`) | Emite |
|---|---|---|---|---|
| `consultar_servicios` | consulta | — | `{}` | — |
| `consultar_disponibilidad` | consulta | — | `{ id_servicio, fecha }` | — |
| `reservar_turno` | mutacion | **sí** (una cita por slot) | `{ id_servicio, inicio, id_profesional? }` | `cita.creada.v1` |
| `reagendar_cita` | mutacion | sí | `{ id_cita, nuevo_inicio }` | `cita.reagendada.v1` |
| `cancelar_cita` | mutacion | sí | `{ id_cita, motivo? }` | `cita.cancelada.v1` |
| `consultar_mis_citas` | consulta | — | `{ id_persona_negocio }` | — |

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
