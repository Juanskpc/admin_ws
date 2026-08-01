# ADR-006 — Modelo Persona / PersonaNegocio / Identificador

## Estado

Aceptado

## Contexto

Es la decisión más importante del proyecto: define la entidad más referenciada de la plataforma.

Hoy no existe una noción unificada de "cliente". Cada vertical la modela distinto: `tienda_cliente`
es una entidad real; `gym_miembro` mezcla persona y membresía; `parq_abonado` mezcla persona y
vehículo; `reserva` la guarda como columnas denormalizadas sobre la cita; `pedid_orden` guarda un
teléfono y una dirección sueltos. Cinco nociones incompatibles del mismo humano.

Para que el asistente reconozca a un cliente entre canales y verticales —y para el futuro **Portal
del Cliente**, declarado explícitamente en el roadmap, donde una persona vería sus citas, pedidos y
membresías de **varios negocios**— hace falta una identidad transversal. Y tiene que construirse sin
romper el aislamiento entre inquilinos, que es sagrado.

Este ADR agrupa varias caras de **una sola elección**: cómo se modela la identidad.

## Alternativas consideradas

**Nombre "Identidad" para el nodo global.** Descartada: "identidad" se asocia inmediatamente con
autenticación/login. Este objeto no autentica, **resuelve** (responde "¿es el mismo humano?").
El nombre habría confundido su propósito y lo habría acercado peligrosamente a `gener_usuario`.

**Patrón Party (persona-u-organización).** Es el patrón enterprise clásico y correcto, pero su
único valor real —el polimorfismo persona/organización— resuelve un futuro *imaginado* (B2B,
marketplace), no *declarado*. Para una PyME SaaS es una abstracción pesada sin cliente. Descartada.
También `Principal`, `Subject`, `Actor` (todos con carga de auth o demasiado genéricos) y
`CustomerRoot` (hornea "cliente" en el nodo transversal, cuando el humano no siempre es cliente —
puede ser un lead o un no-show).

**Persona única por negocio, sin nivel global.** Descartada: si el mismo teléfono en dos negocios
son dos personas que no se conocen, el Portal del Cliente **no puede existir jamás**. Descubrirlo
después, con seis verticales apuntando a persona, sería la peor migración imaginable.

**Teléfono/email como columnas en el nodo global.** Descartada: un humano tiene varios teléfonos y
emails a lo largo del tiempo, y **cambia de número**. Una columna única es una migración latente el
día del primer cambio. Fue el hallazgo que bloqueó la congelación hasta corregirlo.

## Decisión

Modelo de **dos niveles** (patrón Party-Role) más una tabla de identificadores:

- **`platform.persona`** — el ser humano, global, transversal a inquilinos. Sin PII de perfil, sin
  nombre, sin historial. Solo ancla la identidad. **Ningún inquilino la consulta jamás.**
- **`platform.persona_identificador`** `(id_persona, tipo, valor, verificado_en, activo)` — muchos
  por persona. La resolución ("¿mismo humano?") busca **aquí**, no en una columna de persona.
- **`platform.persona_negocio`** — la relación de esa persona con **un** negocio. Es lo que las
  verticales referencian. Aquí viven nombre-conocido, notas, etiquetas, consentimiento y preferencias.

Reglas: las verticales referencian `persona_negocio` (nunca `persona`), con FK **siempre nullable**.
El cliente final **nunca** vive en `gener_usuario` (eso es personal del negocio, con roles). El nivel
global `persona` se **modela desde el día uno y no se puebla** hasta que exista el Portal del Cliente.
El identificador de canal (teléfono) es global; el **permiso** de mensajearlo por un negocio es por
inquilino y vive en `persona_negocio`. PK en UUID (ver [ADR-024](ADR-024-persistencia.md)).

## Consecuencias positivas

- Una identidad transversal real, base de la Ficha 360 y del Portal del Cliente.
- Aislamiento por construcción: una vertical referencia `persona_negocio`, que ya está atada a su
  `id_negocio`; no existe ruta de un inquilino hacia los datos de otro.
- Preparada para diez años: nuevos teléfonos, cambios de número y el Portal caben sin migrar.

## Consecuencias negativas

- Tres tablas donde una noción ingenua usaría una. Más modelo por adelantado.
- El nivel global vacío durante mucho tiempo puede parecer "código muerto" a quien no lea este ADR.
- La resolución de identidad (unir persona_negocio de distintos negocios bajo una misma persona) es
  un problema no trivial que habrá que resolver bien cuando llegue el Portal.

## Impacto futuro

Casi todo referencia esta decisión: cada vertical, la Ficha 360, el CRM, el Portal, el asistente.
Cambiar la granularidad después sería la migración más dolorosa del proyecto, por eso se congela
ahora. La tabla de identificadores y el nivel global vacío son precisamente los seguros que evitan
esa migración: se pagan baratos hoy (una tabla y una columna nullable) para no pagarlos carísimos
mañana.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 7), `architecture/freeze.md` (§B, §D.2)
- [ADR-002](ADR-002-multitenancy.md), [ADR-004](ADR-004-platform-intelligence.md), [ADR-024](ADR-024-persistencia.md)
