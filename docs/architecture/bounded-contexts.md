# Mapa de bounded contexts — EscalApp

**Estado:** documento vivo. Describe qué contextos existen, qué posee cada uno y hacia dónde apuntan
las dependencias. La regla de oro está en [ADR-005](../adr/ADR-005-independencia-verticales.md): la
flecha entre Intelligence y una vertical apunta **siempre** Intelligence → Vertical.

## Los contextos

| Contexto | Esquema(s) | Posee | Madurez |
|---|---|---|---|
| **General** | `general` | Inquilinos, usuarios (personal), roles, niveles, planes | Grupo 1 (estable) |
| **Restaurante** | `restaurante` | POS, cocina, inventario, caja, pedidos | Grupo 1 (estable) |
| **Reserva** | `reserva` | Servicios, profesionales, citas, horarios | Grupo 2 |
| **Gym** | `gym` | Miembros, membresías, asistencia, ventas | Grupo 2 |
| **Parqueadero** | `parqueadero` | Vehículos, tarifas, facturas, abonados | Grupo 2 |
| **Tienda** | `tienda` | Productos, clientes, ventas, inventario | Grupo 2 |
| **Platform** | `platform` | Persona/identidad, outbox, catálogo de capacidades, features | Nuevo, alta integridad |
| **Intelligence** | `intelligence` | Conversaciones, mensajes, turnos, tool calls, costos, memoria | Nuevo, alto volumen |
| **Knowledge** | *(reservado)* | Contenido del negocio (menús, FAQs, PDFs) | Reservado, sin implementar |

## Reglas de dependencia (congeladas)

```
        ┌──────────────────────────────────────────────┐
        │                 INTELLIGENCE                  │
        │  core (agnóstico)                             │
        │  adapters/reserva  adapters/restaurante  ...  │
        └───────┬─────────────────┬────────────────┬────┘
                │ consume         │ consume        │ consume    (Intelligence → Vertical)
                ▼                 ▼                ▼
           [ Reserva ]      [ Restaurante ]   [ Gym ... ]
                │                 │                │
                │  FK nullable    │                │  las verticales referencian ↓
                ▼                 ▼                ▼
        ┌──────────────────────────────────────────────┐
        │                  PLATFORM                     │
        │  persona · persona_negocio · outbox ·         │
        │  catálogo de capacidades · features           │
        └──────────────────────────────────────────────┘
```

- **Intelligence → Vertical**, nunca al revés. Una vertical **nunca** importa ni llama a Intelligence;
  si quiere algo, **emite un evento** al outbox de `platform` ([ADR-005](../adr/ADR-005-independencia-verticales.md),
  [ADR-012](../adr/ADR-012-outbox.md)).
- **Intelligence NUNCA tiene FK hacia las verticales** — solo referencias lógicas `(vertical, entidad,
  id)`. Es lo que hace `intelligence` extraíble ([ADR-004](../adr/ADR-004-platform-intelligence.md)).
- **Intelligence PUEDE tener FK** hacia `general.gener_negocio` y `platform.persona`.
- **Las verticales PUEDEN tener FK** hacia `platform.persona_negocio` — **siempre nullable**
  ([ADR-006](../adr/ADR-006-persona.md)). Una vertical funciona sin persona y sin IA.
- **El acoplamiento con un dominio vive en `intelligence/adapters/<vertical>`**, no en el núcleo ni en
  la vertical ([ADR-009](../adr/ADR-009-capability-adapter.md)). El núcleo es agnóstico (`git diff = 0`
  al añadir verticales).

## Contratos publicados (shared kernel, en `platform`)

No son bounded contexts; son **lengua publicada** que varios contextos comparten:

- **Catálogo de eventos** — [domain-events.md](domain-events.md) ([ADR-013](../adr/ADR-013-catalogo-eventos.md)).
- **Catálogo de capacidades** — [capability-language.md](capability-language.md) ([ADR-008](../adr/ADR-008-capability-registry.md)).
- **Glosario** — [glossary.md](glossary.md).

## Verificaciones automáticas (CI)

- **Grep de dependencia:** cero imports / llamadas HTTP de una vertical hacia `intelligence`.
- **Grep de FK:** cero FKs de `intelligence` hacia esquemas de vertical.
- **Test del apagón:** apagar Intelligence, correr la suite de verticales, debe pasar.
