# ADR-021 — Features / entitlements

## Estado

Aceptado

## Contexto

EscalApp es un SaaS por planes (hoy Básico y Avanzado). La IA es una **capacidad opcional**, no el
producto: unos planes la incluyen, otros no, y dentro de la IA hay sub-capacidades (WhatsApp, WebChat,
voz, conocimiento) que pueden ir en distintos planes. Algo tiene que responder, en muchos puntos del
código, "¿este negocio tiene derecho a esto?".

El error clásico de SaaS es responderlo con `if (plan === 'avanzado')` disperso por todo el código:
cada cambio de empaquetado comercial se convierte en un cambio de código en decenas de sitios, y la
lógica de negocio queda atada al catálogo comercial.

## Alternativas consideradas

**Comprobar el plan directamente donde haga falta** (`if plan === 'avanzado'`). Descartada: acopla
cada componente al catálogo comercial; renombrar un plan o mover una feature de plan obliga a tocar
código por todas partes.

**Un dominio de Features pesado** con CRUD de features, overrides por-feature, trials por-feature, UI
de administración. Descartada por ahora: es maquinaria para un problema que aún no tenemos. Lo que se
necesita temprano es la **costura**, no el motor.

**Una costura de entitlements delgada.** Elegida.

## Decisión

Los componentes consultan **capacidades habilitadas, nunca planes**, a través de una única función:
**`estaHabilitado(id_negocio, feature)`**. Detrás, el mapeo plan → conjunto-de-features más simple
posible (incluso una tabla estática al inicio). Lo que importa es que **todos** pregunten por
`estaHabilitado`; no que exista un panel de administración de features.

Se fija una distinción de tres capas que la gente confunde, y que el Policy Gate consulta en orden:

- **Feature / entitlement** = interruptor **comercial** (¿el plan incluye el recepcionista IA?).
- **Capacidad habilitada** = permiso de **dominio** (¿puede ejecutar `reservar_turno`?,
  [ADR-007](ADR-007-capacidades.md)).
- **Business Policy** = límite **económico** (¿hasta qué descuento?, [ADR-011](ADR-011-business-policy.md)).

Feature ≠ Capacidad: una Feature es comercial/facturación; una Capacidad es de dominio. Habilitar la
Feature `AI_RECEPTIONIST` hace disponible un conjunto de capacidades, pero viven en capas distintas y
no se mezclan.

## Consecuencias positivas

- Cambiar el empaquetado comercial (qué plan incluye qué) no toca código de dominio: solo el mapeo.
- La lógica de facturación no se filtra al dominio; las tres capas quedan separadas y claras.
- La costura existe desde que la IA necesita gating, con implementación mínima detrás.

## Consecuencias negativas

- Introduce una indirección (`estaHabilitado`) donde un `if plan` sería más corto de escribir. Se paga
  con gusto: es lo que evita el acoplamiento al catálogo comercial.
- El mapeo simple inicial no cubre casos avanzados (overrides, trials por-feature); llegarán cuando
  ventas los pida, no antes.

## Impacto futuro

Es el punto único donde lo comercial toca a lo técnico. Si mañana aparece un tercer plan, un add-on o
un trial, se modela detrás de `estaHabilitado` sin tocar a los consumidores. La feature-gating del
frontend (ocultar UI) es UX y puede venir después; el backend es la fuente de verdad y es lo único que
el camino de IA necesita.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 4 de la revisión de estrés, Features), `architecture/freeze.md` (§D.6)
- [ADR-007](ADR-007-capacidades.md), [ADR-010](ADR-010-ejecucion-segura.md), [ADR-011](ADR-011-business-policy.md)
