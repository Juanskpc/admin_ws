# ADR-004 — Separación `platform` / `intelligence`

## Estado

Aceptado

## Contexto

El nuevo dominio conversacional necesita persistir cosas muy distintas entre sí: por un lado, la
**identidad transversal del cliente**, los **eventos de dominio** (outbox) y el **catálogo de
capacidades** — datos duraderos, de alta integridad, referenciados por las verticales. Por otro
lado, las **conversaciones, mensajes, turnos, llamadas a capacidades, costos y memoria** — datos de
altísimo volumen, con retención acotada y particionado.

Meter todo esto donde ya existe (`general`) o juntarlo todo en un solo esquema nuevo tiene
consecuencias fuertes sobre el aislamiento, la extractibilidad y el rendimiento. Había que decidir
el mapa de esquemas antes de la primera migración.

## Alternativas consideradas

**Extender `general`.** Descartada: `general` está congelado (Grupo 1, [ADR-003](ADR-003-madurez-esquemas.md))
y es crítico. Convertirlo en el cajón de sastre de la identidad, los eventos y las conversaciones
mezcla ciclos de vida opuestos (una fila de `gener_negocio` vive años; una fila de mensaje se
archiva en meses) y arriesga lo que ya está en producción.

**Un solo esquema `intelligence` que incluya también la identidad.** Descartada por dos razones.
(1) Ata la identidad al subsistema de IA: el día que quieras extraer `intelligence` a su propio
servicio, te llevas la identidad del cliente con él, y la identidad **no pertenece a la IA**.
(2) Es conceptualmente falso: un cliente que reserva por la web sin hablar jamás con el bot también
es una Persona. La identidad es de la *plataforma*, no del cerebro conversacional.

**Un esquema de conversación por vertical.** Descartada: contradice la visión ([ADR-001](ADR-001-vision.md)).
La conversación es transversal; partirla por vertical reintroduce el cliente fragmentado.

**Dos esquemas nuevos: `platform` e `intelligence`.** Elegida.

## Decisión

Se crean **dos** esquemas nuevos con responsabilidades distintas:

- **`platform`** — identidad (persona), outbox de eventos, catálogo de capacidades, features.
  Datos duraderos, de alta integridad. Las verticales pueden referenciarlo (FK nullable a persona).
  **No pertenece a la IA**; la IA es solo uno de sus consumidores.
- **`intelligence`** — conversaciones, mensajes, turnos, llamadas a capacidad, costos, memoria.
  Alto volumen, particionado mensual, con retención. **Sin FK hacia las verticales** (solo
  referencias lógicas `(vertical, entidad, id)`); esa ausencia de FK es lo que lo hace extraíble.

## Consecuencias positivas

- La identidad sobrevive independientemente de la IA (habilita Portal del Cliente, CRM, analítica).
- `intelligence` es extraíble a su propio servicio/BD el día que la carga lo exija, sin desenredar
  identidad ni verticales.
- Cada esquema tiene un perfil de rendimiento y retención coherente con sus datos.

## Consecuencias negativas

- Dos esquemas nuevos que mantener y razonar, en vez de uno.
- Obliga a la disciplina de "sin FK de intelligence a verticales", que un solo esquema no exigiría
  y que hay que verificar en CI ([ADR-005](ADR-005-independencia-verticales.md)).

## Impacto futuro

Es una de las decisiones más caras de revertir: la frontera sin-FK entre `intelligence` y las
verticales es la garantía de extractibilidad, y una sola FK que la cruce la destruye para siempre.
Por eso se protege con una verificación automática. Ubicar el outbox en `platform` (no en
`intelligence`) es lo que permite que las verticales emitan eventos sin depender de la IA
(ver [ADR-005](ADR-005-independencia-verticales.md), [ADR-012](ADR-012-outbox.md)).

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (decisión de persistencia, "Alternativa D"), `architecture/freeze.md`
- [ADR-005](ADR-005-independencia-verticales.md), [ADR-006](ADR-006-persona.md), [ADR-012](ADR-012-outbox.md)
