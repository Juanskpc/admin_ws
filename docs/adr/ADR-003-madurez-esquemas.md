# ADR-003 — Asimetría de madurez de esquemas

## Estado

Aceptado

## Contexto

No todas las partes de EscalApp tienen la misma madurez. `general` (inquilinos, usuarios, roles) y
`restaurante` (POS) están **en producción con clientes reales**: un cambio disruptivo ahí puede
tumbar operaciones vivas. En cambio `reserva`, `gym`, `parqueadero` y `tienda` aún no tienen
clientes en producción, o están en fase temprana: se pueden refactorizar con libertad.

Tratar a todo el sistema con el mismo criterio sería un error en cualquiera de las dos direcciones:
si aplicamos a todo la prudencia de producción, nos atamos las manos donde no hace falta; si
aplicamos a todo la libertad de refactor, arriesgamos lo que ya funciona.

## Alternativas consideradas

**Refactor uniforme de todo el sistema** para dejarlo "limpio" antes de construir la IA.
Descartada: obligaría a tocar `general` y `restaurante` en producción sin necesidad, con riesgo
alto y valor bajo. Normalizar `pedid_orden`, por ejemplo, no aporta nada al cliente y sí arriesga
el POS.

**Congelar todo el sistema** y solo añadir. Descartada por lo contrario: las verticales inmaduras
*deben* poder evolucionar su modelo, y hacerlo ahora —antes de tener clientes— es cuando es barato.

**Reconocer dos grupos con estrategias distintas.** Elegida.

## Decisión

Se reconocen dos grupos con reglas explícitas:

- **Grupo 1 — `general`, `restaurante` (producción, estable):** solo cambios **aditivos y
  compatibles hacia atrás** — columna nullable, tabla nueva, índice nuevo. **Nunca** cambios
  disruptivos. Lo que el modelo actual no permita hacer limpio se **compensa fuera**, en el
  Capability Adapter (ver [ADR-009](ADR-009-capability-adapter.md)), no dentro de la vertical.
- **Grupo 2 — `reserva`, `gym`, `parqueadero`, `tienda` (evolución libre):** pueden evolucionar su
  arquitectura. La ventana de libertad **se cierra con el primer cliente en producción** de cada
  una: a partir de ahí, pasan al régimen del Grupo 1.

## Consecuencias positivas

- Protege lo que ya factura sin frenar lo que todavía se puede moldear.
- Da un criterio claro y objetivo ("¿tiene clientes en producción?") para saber qué régimen aplica.
- Evita refactors caros y arriesgados que no aportan valor.

## Consecuencias negativas

- El Grupo 1 acumulará imperfecciones que no se corrigen en el esquema (p.ej. `pedid_orden`
  denormalizado). Es deuda técnica *aceptada conscientemente*, contenida por el Adapter.
- Convivimos con dos criterios en paralelo, lo que exige recordar en qué grupo está cada vertical.

## Impacto futuro

Cualquier migración futura sobre `general`/`restaurante` debe pasar el filtro "¿es aditivo?". Si
algún día un cambio disruptivo fuera inevitable, requeriría un ADR propio que lo justifique y un
plan de migración con downtime — precisamente el tipo de decisión que este ADR obliga a hacer
explícita y no por accidente.

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (estrategia Grupo 1 / Grupo 2)
- [ADR-009](ADR-009-capability-adapter.md) (dónde se compensa la deuda del Grupo 1)
