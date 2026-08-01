# ADR-023 — Guardarraíles de producto: promesas y handoff

## Estado

Propuesto

## Contexto

Toda la arquitectura de seguridad protege la **base de datos**: la IA no puede hacer nada fuera de las
capacidades ([ADR-007](ADR-007-capacidades.md)), el `id_negocio` lo impone la plataforma, las
mutaciones se confirman ([ADR-010](ADR-010-ejecucion-segura.md)). Pero nada de eso impide que la IA
**diga** algo que compromete al negocio.

Dos huecos, ambos de producto y no de datos, ambos descubiertos en la revisión de estrés:

1. **Promesas no respaldadas.** *"Claro, te hago un 20% de descuento por cliente frecuente."* Ninguna
   capacidad se ejecutó, ningún dato se corrompió, el Policy Gate impecable — y mañana llega un cliente
   esperando ese descuento, con una promesa por escrito de un agente que actuaba en nombre del negocio.
   Protegemos la BD; no protegemos **la palabra del negocio**, que es literalmente el producto que
   vendemos ("un empleado virtual"). Es un riesgo de responsabilidad, no de integridad.
2. **Handoff sin humano.** La válvula de escape a un humano asume que hay alguien al otro lado. A las 11
   de la noche, en una barbería de un solo dueño, no lo hay. Un handoff que deja al cliente en silencio
   es peor que un bot que se equivoca.

Este ADR queda en estado **Propuesto** a propósito: la decisión de mecanismo debe tomarse **antes de
F7** (la primera fase con mutaciones vía IA), no ahora, pero se registra hoy para que no se descubra en
producción.

## Alternativas consideradas

**Solo una instrucción en el prompt** ("nunca ofrezcas descuentos que no vengan de una capacidad").
Necesaria pero insuficiente: es una instrucción, y las instrucciones se eluden con inyección de
prompts. No es una defensa estructural.

**Un handoff que asume humano siempre disponible.** Descartada: falla exactamente cuando más se
necesita (fuera de horario, negocios unipersonales).

**No hacer nada y confiar en el buen comportamiento del modelo.** Descartada: es la postura que
convierte un riesgo conocido en un incidente con un cliente real.

## Decisión (propuesta, a confirmar antes de F7)

- **Guardarraíl de salida contra promesas no respaldadas:** una comprobación **posterior a la
  generación** que detecta compromisos (cifras, descuentos, promesas de tiempo) **no respaldados por el
  resultado de una capacidad ejecutada en ese turno**, y los bloquea o escala a un humano. Es la única
  defensa *estructural* del hueco 1; complementa a Business Policy
  ([ADR-011](ADR-011-business-policy.md)), que acota los parámetros de las capacidades *legítimas*. Dos
  defensas, dos fallos: la policy caza "parámetros fuera de límite"; el guardarraíl caza "dijo algo que
  ninguna capacidad respalda".
- **Registro de lo prometido**, para que el negocio pueda auditar qué dijo su empleado virtual.
- **Comportamiento definido del handoff cuando nadie responde:** un mensaje honesto al cliente ("le
  respondemos por la mañana"), una expectativa clara y una cola para el humano.

## Consecuencias positivas

- Protege la palabra del negocio con un mecanismo estructural, no con un ruego al modelo.
- El handoff se vuelve fiable incluso fuera de horario o en negocios unipersonales.
- El registro de promesas da trazabilidad y defensa ante reclamos.

## Consecuencias negativas

- El guardarraíl de salida añade una comprobación post-generación por turno (latencia y complejidad), y
  detectar "compromisos" en texto libre es un problema difícil con falsos positivos/negativos.
- Es un riesgo **abierto**: hasta que se confirme el mecanismo en F7, el sistema queda expuesto a él (de
  forma consciente y anotada, no accidental).

## Impacto futuro

Es el reconocimiento de que la seguridad de datos no basta para un producto que vende "un empleado que
habla en tu nombre". Cualquier capacidad de mutación o negociación futura entra bajo el alcance del
guardarraíl. La decisión de mecanismo se toma antes de habilitar mutaciones vía IA; este ADR pasará a
`Aceptado` cuando eso ocurra.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (riesgos 11.2 y 11.4), `architecture/freeze.md` (§D.4, decisión abierta)
- [ADR-007](ADR-007-capacidades.md), [ADR-010](ADR-010-ejecucion-segura.md), [ADR-011](ADR-011-business-policy.md)
