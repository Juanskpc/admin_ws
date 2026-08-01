# ADR-008 — Capability Registry único

## Estado

Aceptado

## Contexto

Decidido que la IA solo ejecuta capacidades ([ADR-007](ADR-007-capacidades.md)), hace falta un lugar
donde esas capacidades estén registradas: su nombre, su descripción para el modelo, sus parámetros,
sus políticas. Ese registro es lo que el orquestador presenta al modelo y lo que el Policy Gate
consulta para autorizar.

En una versión anterior del diseño (el Master Plan original) se proponían **dos** registros: un
Capability Registry *y* un Tool Registry, entendiendo las "herramientas" como los pasos internos que
una capacidad usa. Al revisar la arquitectura para congelarla, esa dualidad se sometió a una prueba
simple y no la pasó.

## Alternativas consideradas

**Dos registros: Capability Registry + Tool Registry.** La idea era registrar también las
"herramientas" (buscar disponibilidad, tomar un hold…) como objetos de primera clase, con esquema,
descubrimiento y política propios. Descartada tras preguntar: **¿quién consulta el Tool Registry?**
El modelo no (solo ve capacidades, [ADR-007](ADR-007-capacidades.md)); el orquestador no (orquesta
capacidades); el Policy Gate no (autoriza capacidades); otra capacidad tampoco (si dos capacidades
necesitan el mismo paso, eso es una **función compartida**, no una herramienta registrada). Nadie lo
consulta. Un registro que nadie consulta no es un registro: es ceremonia — registro, descubrimiento,
esquemas y políticas para "herramientas" que solo se llaman a sí mismas dentro de una capacidad.

**Registro de herramientas enchufables** (estilo plugin system). Descartada por lo mismo, agravado:
las herramientas no son plugins que se enchufen en runtime; son código transaccional privado de cada
capacidad. Modelarlas como sistema de plugins añade una abstracción sin consumidor.

## Decisión

Existe **un único Capability Registry**. Las "herramientas" son **detalle de implementación privado**
de cada capacidad: código normal dentro del guion transaccional de la capacidad, sin registro, sin
esquema, sin descubrimiento, sin política propia.

Además se fija la **colisión de vocabulario** con los proveedores de LLM, que llaman "tools" a su
mecanismo de *function calling*:

> Nuestras Capacidades se **renderizan como** las "tools" del proveedor **dentro del adaptador del
> `ModelPort`**. La palabra "tool" pertenece **exclusivamente** a la capa del adaptador de proveedor.
> En el resto del sistema, la palabra no existe.

Si "tool" aparece en el núcleo, es síntoma de que una abstracción se filtró.

Disciplina asociada: se fija un techo blando de **~10 capacidades por vertical**. No es un límite
técnico, es un forzador de disciplina: si una vertical necesita 40 capacidades, probablemente están
mal cortadas (son CRUD disfrazado, no acciones de negocio).

## Consecuencias positivas

- Un solo catálogo, un solo vocabulario. Nadie tiene que explicar la diferencia entre dos registros.
- La pregunta "¿qué puede hacer la IA?" tiene **una** respuesta inequívoca: la lista de capacidades.
- Menos código, menos abstracción, menos mantenimiento — decisivo para un equipo de una persona.

## Consecuencias negativas

- Sin un Tool Registry, no hay reutilización *formal* de pasos entre capacidades; la reutilización se
  hace con funciones compartidas normales. Es lo correcto, pero exige disciplina para no duplicar.
- El techo de ~10 capacidades es arbitrario y habrá que defenderlo activamente cuando la tentación de
  añadir "una capacidad más" aparezca.

## Impacto futuro

Simplifica permanentemente el diseño del subsistema de capacidades. Reintroducir un Tool Registry en
el futuro sería revertir esta decisión, y requeriría demostrar primero que existe un consumidor real
para él — cosa que hoy no existe. El metamodelo del Registry se valida en papel con los manifiestos
de reserva y restaurante **antes** de construirlo (ver `architecture/revision-01.md`, punto 6).

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 8, eliminación del Tool Registry), `architecture/freeze.md`
- [ADR-007](ADR-007-capacidades.md), [ADR-018](ADR-018-estrategia-modelos.md) (`ModelPort`)
