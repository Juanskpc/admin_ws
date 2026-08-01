# ADR-002 — Multi-tenancy: esquema-por-vertical + `id_negocio`

## Estado

Aceptado

## Contexto

EscalApp aloja a muchos negocios (inquilinos) en una sola base de datos PostgreSQL. Cada negocio
puede operar varias verticales. Un fallo de aislamiento entre inquilinos —que un negocio vea datos
de otro— es el peor incidente posible en un SaaS multi-inquilino. La decisión sobre cómo se
particionan los datos se tomó al inicio del proyecto y aquí se **registra** el porqué, porque
condiciona todo lo demás.

## Alternativas consideradas

**Una base de datos por inquilino.** Máximo aislamiento. Descartada: con un solo desarrollador,
gestionar N bases de datos (migraciones, backups, conexiones, provisioning por alta de cliente) es
inviable operativamente. La complejidad crece con cada cliente.

**Una sola tabla por entidad con una columna discriminadora `tenant_id`, sin más.** Simple, pero
el aislamiento depende **enteramente** de que cada query recuerde filtrar. Un `WHERE` olvidado es
una fuga de datos. Descartada como *única* defensa.

**Row-Level Security (RLS) de Postgres.** Aislamiento a nivel de motor. Descartada por ahora: añade
complejidad de políticas y de manejo de sesión/rol de conexión que no se justifica para el tamaño
actual, y el pool de `pg` en crudo (usado para reportes) la complica. Queda como refuerzo futuro
posible, no como base.

**Esquemas de Postgres por dominio + `id_negocio` en cada tabla.** Cuatro esquemas (`general`,
`restaurante`, `parqueadero`, `gym`, y los nuevos), cada tabla lleva `id_negocio`, y el filtrado por
inquilino es una disciplina uniforme. Elegida.

## Decisión

Los datos se organizan en **esquemas de Postgres por dominio**, y **cada tabla de negocio lleva
`id_negocio`**. El aislamiento entre inquilinos se hace filtrando por `id_negocio`. Regla reforzada
en el subsistema inteligente: **el `id_negocio` nunca lo aporta el modelo de IA; lo inyecta la
plataforma** (ver [ADR-010](ADR-010-ejecucion-segura.md)).

## Consecuencias positivas

- Un solo motor, un solo backup, un solo pool: operable por una persona.
- Los esquemas dan una separación lógica clara por dominio y facilitan permisos a futuro.
- Convención uniforme (`schema.tabla`, `id_negocio` presente) fácil de auditar.

## Consecuencias negativas

- El aislamiento depende de disciplina de código, no del motor. Un filtro olvidado es una fuga.
  Se mitiga con convenciones estrictas y, en el subsistema IA, con la inyección forzada del
  `id_negocio` en el Policy Gate — pero en las verticales sigue siendo responsabilidad del código.
- Escalar horizontalmente la BD (sharding) es más difícil que con BD-por-inquilino. Aceptado: no es
  un problema al tamaño actual ni cercano.

## Impacto futuro

Todas las tablas y todas las queries dependen de esta decisión. Cambiar a BD-por-inquilino o a RLS
sería una migración mayor, pero no bloqueante: `id_negocio` ya está presente en todo, así que RLS
podría *añadirse* encima como refuerzo sin rediseñar el esquema. Es una puerta que queda abierta.

## Fecha

2026-07-14 (decisión original anterior al proyecto de IA; aquí registrada)

## Referencias

- `CLAUDE.md` (convenciones multi-tenant y de nombres `schema.tabla`)
- [ADR-004](ADR-004-platform-intelligence.md), [ADR-010](ADR-010-ejecucion-segura.md)
