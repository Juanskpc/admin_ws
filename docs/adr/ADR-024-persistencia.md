# ADR-024 — Convenciones de persistencia y gobierno de datos

## Estado

Aceptado

## Contexto

Los esquemas nuevos (`platform`, `intelligence`) son la última oportunidad barata de elegir
convenciones de persistencia sin pelear con lo heredado. Algunas de estas elecciones son
baratas-hoy / carísimas-mañana: cambiarlas después, con tablas llenas y clientes en producción, es
una migración dolorosa. Este ADR agrupa varias sub-decisiones porque son **una sola elección**: cómo
persiste y se gobierna el dato nuevo. Cada una se justifica abajo.

## Alternativas consideradas

**`bigserial` para las claves primarias de `intelligence` y `persona`.** Descartada: son las dos
piezas candidatas a extraerse a su propio servicio ([ADR-004](ADR-004-platform-intelligence.md)) y a
respaldar un portal público ([ADR-006](ADR-006-persona.md), riesgo de enumeración). `bigserial` ata la
generación de IDs a una sola base de datos y expone contadores secuenciales.

**Timestamps wall-time `-05:00` en `intelligence`**, como en las verticales. Descartada: la convención
wall-time existe para fechas de negocio **humanas** (la cita de las 3pm). Los datos de `intelligence`
son de **máquina** (orden de mensajes, costo, latencia), críticos en ordenamiento y posiblemente
cruzan husos horarios. Es seguro divergir porque `intelligence` **nunca hace JOIN con las verticales**
(no hay FKs, [ADR-004](ADR-004-platform-intelligence.md)), así que las dos convenciones no colisionan.

**No particionar y particionar después.** Descartada: particionar una tabla de mensajes/turnos de
cientos de millones de filas en caliente es brutal; hacerlo con la tabla vacía es gratis.

**Enviar PII a un proveedor de LLM extranjero sin base legal.** Descartada: las conversaciones
contienen datos personales de ciudadanos colombianos (Ley 1581 de 2012); enviarlos al extranjero sin
base legal, consentimiento informado y acuerdo de tratamiento con el proveedor es un riesgo de negocio
que puede **detener el producto**.

## Decisión

Convenciones congeladas para los esquemas nuevos:

- **PK en UUID (v7)** para los agregados de `intelligence` y para `persona` / `persona_negocio`. Las FK
  a `id_negocio` siguen siendo **enteras** (clave existente de la plataforma, [ADR-002](ADR-002-multitenancy.md)).
  UUIDv7 da ordenamiento temporal sin acoplar la generación a una sola BD ni exponer contadores.
- **Timestamps `timestamptz` (UTC)** en `intelligence`. Las verticales conservan su wall-time `-05:00`.
  La divergencia es segura por la ausencia de FKs entre ambos.
- **Particionado declarativo mensual** de las tablas de alto volumen de `intelligence`
  (mensajes, turnos, costos), definido con las tablas vacías, más políticas de retención.
- **Gobierno de PII:** el envío de datos personales a un proveedor extranjero exige base legal para la
  transferencia internacional, consentimiento informado y acuerdo de tratamiento de datos. Debe
  resolverse **antes del MVP comercial**, no después del primer cliente que lo pregunte. Es también el
  argumento **no económico** a favor de un modelo local ([ADR-018](ADR-018-estrategia-modelos.md)): si
  algún día la ley empuja hacia Ollama, será mejor razón que el ahorro.

## Consecuencias positivas

- `intelligence` y `persona` quedan listas para extracción y para un portal público sin migrar claves.
- El costo y el orden de los datos de máquina son correctos y a prueba de husos horarios.
- El particionado y la retención existen desde el día uno, cuando cuestan cero.
- El riesgo legal de PII queda nombrado y con dueño temporal, no escondido.

## Consecuencias negativas

- UUID como PK es más pesado que un entero en índices y almacenamiento; aceptado a cambio de
  portabilidad y no-enumeración. (Las verticales existentes siguen con enteros; no se tocan.)
- Convivir con dos convenciones de tiempo (wall-time en verticales, UTC en intelligence) exige recordar
  cuál aplica dónde. Mitigado porque los dos mundos no se cruzan.
- El gobierno de PII añade trabajo legal/administrativo que un proyecto puramente técnico ignoraría — y
  que es precisamente el que se descubre tarde si no se anota.

## Impacto futuro

Estas convenciones son caras de revertir una vez las tablas tienen datos: cambiar el tipo de PK o el
manejo de tiempo de la entidad más referenciada, o particionar en caliente, son migraciones mayores.
Por eso se congelan con las tablas vacías. El gobierno de PII condiciona qué modelos y qué regiones son
aceptables, y puede reabrir [ADR-018](ADR-018-estrategia-modelos.md) si la regulación lo exige.

## Fecha

2026-07-14

## Referencias

- `architecture/freeze.md` (§D.3, §D.4), `architecture/revision-01.md` (riesgo 11.3, PII)
- [ADR-002](ADR-002-multitenancy.md), [ADR-004](ADR-004-platform-intelligence.md), [ADR-006](ADR-006-persona.md), [ADR-018](ADR-018-estrategia-modelos.md)
