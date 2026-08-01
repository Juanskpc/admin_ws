# Catálogo de eventos de dominio — EscalApp

**Estado:** documento vivo. Se actualiza (aditivamente) cada vez que se define un evento nuevo.
**Gobernado por:** [ADR-013](../adr/ADR-013-catalogo-eventos.md) (contrato) y
[ADR-012](../adr/ADR-012-outbox.md) (transporte).

> Este es el **contrato**, no la implementación. Un evento aquí es una promesa: su nombre y su forma
> no cambian una vez que hay consumidores. Un cambio incompatible es una **versión nueva** al lado de
> la vieja, nunca una edición de la existente.

## Reglas (resumen de ADR-013)

1. **Nombre:** `<agregado>.<hecho-en-pasado>.v<n>`, en **español**. Ej.: `cita.creada.v1`.
2. **Delgado:** lleva **identificadores y el hecho**, no una copia del estado. Quien necesite detalle
   lo relee. Excepción: un valor que solo es cierto en ese instante (el `de→a` de una transición).
3. **Aditivo:** `v1` nunca cambia de forma; un cambio incompatible es `v2`.
4. **No enumerar por adelantado:** un evento se define cuando hay un productor que lo emite *y* alguien
   que lo necesita.

## Sobre (envelope) común

Todo evento viaja con el mismo sobre; los campos de abajo son el `payload`.

```
{
  id_evento:    uuid,            // idempotencia del consumidor (ADR-012: entrega ≥1 vez)
  tipo:         "cita.creada.v1",
  id_negocio:   int,            // siempre presente; scoping multi-tenant
  ocurrido_en:  timestamptz,    // UTC (ADR-024)
  payload:      { ... }         // los campos documentados por tipo, abajo
}
```

## Estados

- `Activo` — emitido y consumido en producción.
- `Planificado` — acordado, aún sin productor. Se implementa cuando su primer consumidor lo pida.

---

## `platform`

| Evento | Estado | Payload (además del sobre) | Notas |
|---|---|---|---|
| `persona.creada.v1` | Planificado | `{ id_persona_negocio, id_persona? }` | Al nacer una relación persona↔negocio. |
| `persona.vinculada.v1` | Planificado | `{ id_persona_negocio, id_persona }` | Cuando una relación se ata a una persona global (resolución de identidad). |

## `reserva`

| Evento | Estado | Payload | Notas |
|---|---|---|---|
| `cita.creada.v1` | Planificado | `{ id_cita, id_persona_negocio? }` | Detonante típico de la confirmación por canal. |
| `cita.confirmada.v1` | Planificado | `{ id_cita }` | |
| `cita.reagendada.v1` | Planificado | `{ id_cita, de: {inicio}, a: {inicio} }` | El `de→a` va en el evento (solo cierto en ese instante). |
| `cita.cancelada.v1` | Planificado | `{ id_cita, origen: "cliente"\|"negocio" }` | |
| `cita.completada.v1` | Planificado | `{ id_cita }` | |
| `cita.no_asistio.v1` | Planificado | `{ id_cita }` | Alimenta el historial de no-shows de la Ficha 360. |

> Nota de dominio: hoy `reserva` no emite ninguno de estos ([ADR-012](../adr/ADR-012-outbox.md),
> contexto). Adoptarlos es parte del Contrato de Adopción de la vertical (ver
> [capability-language.md](capability-language.md) y `revision-01.md`, punto 6).

## `restaurante`

| Evento | Estado | Payload | Notas |
|---|---|---|---|
| `pedido.creado.v1` | Planificado | `{ id_orden, id_persona_negocio? }` | |
| `pedido.estado_cambiado.v1` | Planificado | `{ id_orden, de, a }` | Cocina/POS. `de→a` en el evento. |
| `pedido.pagado.v1` | Planificado | `{ id_orden, metodo_pago }` | |

## Verticales pendientes de adopción

`gym`, `parqueadero`, `tienda` definirán sus eventos al ejecutar su Contrato de Adopción. No se
enumeran aquí hasta que tengan productor y consumidor (regla 4).

---

## Cómo añadir un evento

1. Confirma que hay un **productor** que lo emitirá y **al menos un consumidor** que lo necesita.
2. Elige el nombre con la convención. Si dudas entre dos nombres, gana el más específico del hecho.
3. Define el payload **mínimo**: identificadores + el hecho. Si te descubres copiando estado, para.
4. Añádelo a la tabla de su agregado con estado `Planificado` y muévelo a `Activo` al desplegarlo.
5. Nunca edites un evento `Activo`. Si su forma debe cambiar, crea `.v(n+1)`.
