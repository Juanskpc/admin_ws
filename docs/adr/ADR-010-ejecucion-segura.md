# ADR-010 — Ejecución segura: Policy Gate, `id_negocio`, propose→hold→confirm

## Estado

Aceptado

## Contexto

Que la IA solo ejecute capacidades ([ADR-007](ADR-007-capacidades.md)) acota *qué* puede hacer, pero
no resuelve tres riesgos del *cómo*:

1. **¿De dónde sale el `id_negocio`?** Si el modelo lo aporta, un prompt malicioso podría pedir la
   agenda de otro inquilino. El aislamiento no puede depender de la buena fe del modelo.
2. **Las mutaciones son peligrosas si son ciegas.** Que el modelo diga "cancela la cita" y se ejecute
   sin más deja al negocio a merced de un malentendido o una alucinación.
3. **El contexto de la conversación envejece.** El cliente empezó a reagendar su cita de las 3; a
   mitad de la charla, la recepcionista la canceló desde el panel. El modelo sigue razonando sobre
   una cita que ya no existe.

Este ADR agrupa las tres defensas porque son **una sola decisión**: cómo se ejecuta una capacidad de
forma segura.

## Alternativas consideradas

**El `id_negocio` viene del modelo / de los parámetros que el modelo llena.** Descartada: convierte
el aislamiento multi-inquilino en algo que un prompt puede manipular. Es la vulnerabilidad más grave
posible en un SaaS multi-tenant.

**Mutación directa sin confirmación.** El modelo invoca `cancelar_cita` y se ejecuta. Descartada: sin
un paso de confirmación, cualquier malentendido conversacional es una acción irreversible sobre datos
reales del negocio.

**Confiar en el estado que el modelo recuerda del contexto.** Descartada: el contexto es una foto
vieja. Actuar sobre él corrompe datos cuando el mundo cambió durante la conversación.

## Decisión

Toda ejecución de capacidad pasa por el **Policy Gate**, con tres reglas fijas:

- **El `id_negocio` lo inyecta la plataforma, nunca el modelo.** El Policy Gate lo resuelve desde el
  contexto autenticado de la conversación (qué negocio, qué canal) y lo impone; el modelo jamás lo
  ve como parámetro que pueda rellenar.
- **Las mutaciones siguen propose → hold → confirm.** La capacidad primero *propone* (calcula y
  reserva un *hold*: p.ej. bloquea el slot), la propuesta se confirma (con el cliente, o según
  política), y solo entonces se *confirma* la mutación. Las consultas de solo-lectura no requieren
  este ciclo.
- **El contexto conversacional es una pista, nunca un hecho.** La única fuente de verdad del dominio
  son las capacidades, consultadas en el momento de actuar. Una capacidad de mutación **relee y
  revalida** el estado dentro de su propia transacción; nunca confía en lo que el modelo cree
  recordar de tres turnos atrás.

## Consecuencias positivas

- El aislamiento entre inquilinos deja de depender del modelo: es estructural, impuesto por la
  plataforma.
- Las acciones irreversibles requieren un paso deliberado; un malentendido no basta para ejecutarlas.
- El sistema es correcto aunque el mundo cambie a mitad de conversación (concurrencia con el panel).

## Consecuencias negativas

- Más pasos por mutación (proponer, sostener, revalidar, confirmar) → más latencia y más código que
  una ejecución directa. Es el precio de operar sobre datos reales de negocio.
- El *hold* introduce estado temporal que hay que expirar y limpiar (un slot reservado que nunca se
  confirma debe liberarse). Complejidad operativa aceptada.

## Impacto futuro

Es el corazón del modelo de seguridad en ejecución. La inyección del `id_negocio` en particular es
innegociable y refuerza [ADR-002](ADR-002-multitenancy.md): si alguna vez una capacidad aceptara el
`id_negocio` desde el modelo, se abriría una fuga entre inquilinos. La regla "el contexto es una
pista" aplica a toda capacidad de mutación presente y futura, en cualquier vertical.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (riesgo 11.1, contexto vs hecho), `architecture/freeze.md`
- [ADR-002](ADR-002-multitenancy.md), [ADR-007](ADR-007-capacidades.md), [ADR-011](ADR-011-business-policy.md)
