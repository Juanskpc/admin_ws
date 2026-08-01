# ADR-007 — Arquitectura basada en Capacidades

## Estado

Aceptado

## Contexto

El asistente conversacional necesita *actuar* sobre el negocio: reservar, pedir, consultar, cancelar.
La pregunta es qué se le permite tocar. Un modelo de lenguaje es no determinista y susceptible a
inyección de prompts; darle acceso amplio al sistema es un riesgo de seguridad de primer orden. Un
atacante que logre manipular la conversación no debe poder leer datos de otro inquilino, ni ejecutar
operaciones arbitrarias, ni tumbar la base de datos.

Al mismo tiempo, el asistente debe ser genuinamente útil, y las verticales ya tienen su lógica de
negocio construida. Había que definir la **superficie exacta** por la que la IA toca el sistema, y
esa definición es una decisión fija e innegociable del proyecto.

## Alternativas consideradas

**La IA accede a la base de datos (SQL, Sequelize).** Máxima flexibilidad, máximo desastre. Un
modelo que escribe SQL puede leer cualquier tabla de cualquier inquilino y ejecutar cualquier
mutación. La inyección de prompts se convierte en inyección de SQL. Descartada de plano.

**La IA llama a los endpoints REST existentes.** Más acotada, pero los endpoints son operaciones
técnicas (CRUD, con sus parámetros crudos, incluido `id_negocio` en el body) pensadas para un front
de confianza, no para un agente. Exponerlos a la IA filtra detalles de implementación y deja el
`id_negocio` en manos del modelo. Descartada.

**Capacidades como CRUD** (`crear_registro`, `actualizar_campo`). Descartada: reproduce los
problemas del acceso a BD con otro nombre. La IA razonaría sobre tablas y campos, no sobre negocio.

**Capacidades como acciones de negocio.** La IA solo puede ejecutar un catálogo cerrado de
*acciones de negocio* de alto nivel (`reservar_turno`, `crear_pedido`, `consultar_menu`), nunca
operaciones técnicas. Elegida.

## Decisión

**La IA solo ejecuta Capacidades registradas.** Reglas fijas del proyecto:

- La IA **nunca** accede a la base de datos, **nunca** ejecuta SQL, **nunca** conoce Sequelize,
  **nunca** conoce Express.
- La IA solo puede ejecutar **capacidades registradas** — nunca endpoints, nunca repositorios,
  nunca servicios internos.
- Las capacidades representan **acciones de negocio** (reservar un turno, crear un pedido, consultar
  el menú), **no CRUD** ni operaciones técnicas.
- Una capacidad puede usar internamente varios pasos (buscar disponibilidad, tomar un *hold*, crear,
  emitir evento); esos pasos son **detalle de implementación privado** de la capacidad, código
  transaccional normal, no una superficie que la IA vea (ver [ADR-008](ADR-008-capability-registry.md)).

## Consecuencias positivas

- La superficie de riesgo de la IA es exactamente el catálogo de capacidades: auditar la seguridad
  del asistente = leer una lista corta de acciones.
- La inyección de prompts, en el peor caso, solo puede invocar capacidades ya autorizadas con
  parámetros validados — no acceder a datos arbitrarios.
- La IA razona en el lenguaje del negocio, no en el del esquema. Prompts más pequeños y estables.

## Consecuencias negativas

- Todo lo que la IA deba poder hacer hay que modelarlo explícitamente como capacidad. No hay
  "atajos": si no existe la capacidad, la IA no puede hacerlo (que es justo el punto, pero es
  trabajo por adelantado).
- Introduce una capa (capacidades + adaptadores) entre la IA y las verticales que un acceso directo
  no tendría. El coste del desacople y la seguridad.

## Impacto futuro

Es el cimiento de todo el modelo de seguridad del asistente. Nunca debe relajarse: el día que "por
comodidad" una capacidad ejecute SQL arbitrario o exponga un endpoint genérico, todo el modelo se
cae. La disciplina se apoya en el Capability Registry ([ADR-008](ADR-008-capability-registry.md)),
el Adapter ([ADR-009](ADR-009-capability-adapter.md)) y el Policy Gate
([ADR-010](ADR-010-ejecucion-segura.md)).

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md`, `architecture/freeze.md` (decisiones fijas del usuario)
- [ADR-008](ADR-008-capability-registry.md), [ADR-009](ADR-009-capability-adapter.md), [ADR-010](ADR-010-ejecucion-segura.md)
