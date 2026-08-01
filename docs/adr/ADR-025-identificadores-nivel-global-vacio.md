# ADR-025 — Dónde viven los identificadores mientras el nivel global está vacío

## Estado

Aceptado

## Contexto

[ADR-006](ADR-006-persona.md) congeló el modelo de identidad en dos niveles y decidió, a la vez,
que el nivel global `platform.persona` se **modela desde el día uno y no se puebla** hasta que
exista el Portal del Cliente. `freeze.md` §B.5 y el glosario repiten esa regla.

Al implementar F0 aparece una ambigüedad que sobre el papel no se veía. `freeze.md` §B (invariante 2)
dice que el teléfono E.164 *"es global y vive en `persona_identificador`"*, y esa tabla cuelga de
`persona` con FK obligatoria. Si `persona` no se puebla, `persona_identificador` tampoco puede
poblarse — y entonces **F0 no tiene dónde guardar los teléfonos ni con qué reconocer a un cliente
que vuelve**, que es justo lo que la Ficha 360 necesita.

`master-plan.md` §688 apunta a la respuesta contraria: *"semántica de identidad: E.164, **unicidad
por (negocio, teléfono)**, jamás cruzar inquilinos"*. Eso solo es posible si el teléfono operativo
vive en `persona_negocio`.

El origen del desajuste está en `revision-01.md` §285 y §489: antes de la congelación las tablas se
llamaban **`platform.identidad`** (global, *solo identificadores*, no se puebla) y **`platform.persona`**
(por negocio, *operativa desde el día uno*). El acta de congelación renombró ambas —`identidad` →
`persona`, `persona` → `persona_negocio`— y en el renombrado se perdió a cuál de las dos pertenecían
los identificadores. No es un error de diseño: es una ambigüedad de redacción que solo se manifiesta
al escribir la primera migración.

Este ADR no reemplaza a ADR-006. Resuelve **qué significa "no se puebla"** en términos de esquema.

## Alternativas consideradas

**Poblar `persona` y `persona_identificador` desde F0**, creando una persona global por cada teléfono
distinto (1:1 con `persona_negocio`, ya que la medición del 2026-07-31 encontró cero solapamiento
entre negocios). Descartada: contradice frontalmente ADR-006, `freeze.md` §B.5, el glosario y
`revision-01.md` §9, que declararon esa decisión **irreversible**. Además crearía identidad
transversal —con todo su peso conceptual y su riesgo de aislamiento— sin ningún Portal que la
justifique, violando P13 (*reservar ≠ implementar*) y el test de simplicidad: nadie la usaría.

**Colgar `persona_identificador` de `persona_negocio`** en lugar de `persona`. Descartada: preserva
el hallazgo que bloqueó la congelación (los identificadores son una tabla hija, no una columna), pero
rompe el invariante 2 del freeze —el identificador de canal deja de ser global— y con él la premisa
que hace posible el Portal del Cliente. Convertiría identificadores por-inquilino en el modelo
permanente, que es exactamente lo que ADR-006 descartó bajo "persona única por negocio".

## Decisión

Mientras el nivel global esté vacío, **el teléfono operativo vive en `platform.persona_negocio`**:

- `persona_negocio.telefono_e164`, nullable, con **`UNIQUE (id_negocio, telefono_e164)`** parcial
  (solo filas con teléfono). Es la clave de resolución de F0 y cumple `master-plan.md` §688.
- `platform.persona` y `platform.persona_identificador` **se crean vacías**, como frontera reservada.
  Cero filas, cero lógica, cero coste de ejecución.
- `persona_negocio.id_persona` permanece **nullable** y sin poblar.

El invariante 2 del freeze se lee así: el identificador de canal **será** global cuando el nivel
global se active; hasta entonces su copia operativa es por inquilino, que es la única semántica que
un sistema sin Portal puede sostener. La regla de aislamiento no cambia: la unicidad es por
`(negocio, teléfono)` y **jamás cruza inquilinos**.

## Consecuencias positivas

- F0 es implementable sin tocar ninguna decisión congelada ni poblar el nivel global.
- La resolución de "cliente que vuelve" queda acotada al negocio, que es la única semántica correcta
  hoy y coincide con lo que la medición encontró (cero solapamiento observable).
- La frontera del Portal sigue reservada y gratis: dos tablas vacías y una columna nullable.

## Consecuencias negativas

- El teléfono queda **duplicado conceptualmente** el día que el nivel global se active: habrá que
  promover los teléfonos de `persona_negocio` a `persona_identificador` y enlazar personas. Es
  precisamente el trabajo de resolución de identidad que ADR-006 ya declara como *"problema no
  trivial que habrá que resolver bien cuando llegue el Portal"*; este ADR no lo agrava, lo localiza.
- Durante un tiempo indefinido habrá dos tablas vacías en `platform` que a quien no lea ADR-006 y
  este ADR le parecerán código muerto. Mitigado con `COMMENT ON TABLE` en la propia migración.

## Impacto futuro

Cuando llegue el Portal del Cliente, la migración de activación tendrá que: crear una `persona` por
humano, mover los teléfonos a `persona_identificador`, resolver qué `persona_negocio` de distintos
negocios son el mismo humano, y rellenar `persona_negocio.id_persona`. Este ADR no decide esa
resolución —sigue abierta, como quería ADR-006— pero garantiza que el esquema no habrá que cambiarlo
para hacerla: solo poblarlo.

## Fecha

2026-07-31

## Referencias

- `architecture/freeze.md` (§B invariante 2, §B.5), `architecture/master-plan.md` (§688),
  `architecture/revision-01.md` (§285, §489)
- `mediciones/2026-07-31-calidad-telefonos-restaurante.md` (cero solapamiento observado)
- [ADR-006](ADR-006-persona.md), [ADR-024](ADR-024-persistencia.md), [ADR-002](ADR-002-multitenancy.md)
