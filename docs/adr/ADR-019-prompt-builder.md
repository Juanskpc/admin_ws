# ADR-019 — Prompt Builder y disciplina de caché

## Estado

Aceptado

## Contexto

Cada turno del nivel premium envía un prompt al LLM, y ese prompt tiene partes que se repiten entre
turnos (instrucciones del sistema, contexto del negocio, catálogo de capacidades) y partes que cambian
(el historial reciente, el mensaje nuevo, la fecha/hora). Los proveedores ofrecen **caché de prefijo**:
si el principio del prompt es idéntico byte a byte al de una petición anterior, esa parte se cobra
~0.1× en vez de 1×.

Pero la caché es un **match de prefijo**: cualquier byte que cambie **invalida todo lo que viene
después**. Si ensamblamos el prompt sin cuidado —poniendo la fecha o un dato volátil al principio—
destruimos la caché de todo el resto en cada turno, y el costo se multiplica por diez sin que nadie
entienda por qué. Con conversaciones de muchos turnos, esto es la diferencia entre un producto rentable
y uno que quema dinero.

## Alternativas consideradas

**Ensamblar el prompt ad-hoc, en cualquier orden.** Descartada: garantiza invalidar la caché por
accidente. Un cambio de orden inocente (mover el contexto del negocio después del historial) tira toda
la ventaja de caché.

**Poner los datos volátiles (fecha, último mensaje) al principio** por "importancia". Descartada: es
exactamente lo que rompe la caché. La importancia para el modelo no tiene nada que ver con el orden
óptimo para la caché.

**Ignorar la caché** y optimizar solo la calidad del prompt. Descartada: a volumen, el costo de
ignorar la caché es insostenible para una PyME SaaS.

## Decisión

El **Prompt Builder** ensambla el prompt en un orden fijo, **de lo más estable a lo más volátil**, con
una regla dura: **la fecha/hora va SIEMPRE al final**. Orden aproximado:

```
[ instrucciones del sistema ]        ← estable (rara vez cambia)
[ contexto del negocio (config) ]    ← estable por inquilino  ← ADR-020: aquí NO va conocimiento
[ catálogo de capacidades ]          ← estable
──────── punto de corte de caché ────────
[ ranura de conocimiento recuperado ]← volátil (vacía en v1, ADR-020)
[ historial reciente de la conversación ]
[ mensaje nuevo ]
[ fecha y hora actual ]              ← SIEMPRE lo último
```

Todo lo que está antes del punto de corte se cachea y se reutiliza entre turnos; todo lo volátil va
después. La fecha, por ser lo que más cambia, cierra siempre el prompt.

## Consecuencias positivas

- El prefijo estable se reutiliza a ~0.1× en cada turno de una conversación: el costo por turno cae
  drásticamente en conversaciones largas.
- El orden es una regla mecánica y auditable, no un juicio caso por caso.
- Deja lista la ranura de conocimiento ([ADR-020](ADR-020-knowledge.md)) en el lugar correcto (después
  del corte), de modo que activarla no rediseña nada.

## Consecuencias negativas

- Impone una restricción rígida sobre cómo se arma el prompt; quien lo modifique debe **entender** la
  regla o romperá la caché sin darse cuenta. Es conocimiento que hay que transmitir.
- Optimizar para la caché a veces riñe con el orden que sería "más natural" para el modelo; ganamos
  costo aceptando esa tensión.

## Impacto futuro

Es una disciplina permanente del nivel premium. Cualquier feature que añada contenido al prompt
(memoria, conocimiento, más contexto) debe respetar el punto de corte: estable antes, volátil después.
Es también la razón técnica por la que Business Context (config, estable) y Knowledge (contenido,
volátil) **no** pueden mezclarse ([ADR-020](ADR-020-knowledge.md)): viven en lados opuestos del corte.

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (Prompt Builder), skill `claude-api` (caché de prefijo, orden `tools`→`system`→`messages`)
- [ADR-018](ADR-018-estrategia-modelos.md), [ADR-020](ADR-020-knowledge.md), [ADR-022](ADR-022-observabilidad.md)
