# ADR-023 — Guardarraíles de producto: promesas y handoff

## Estado

**Aceptado** (2026-08-19, al empezar F7 — el propio ADR lo pedía así: «la decisión de mecanismo se
toma antes de habilitar mutaciones vía IA»).

Los dos mecanismos que quedaban por decidir están decididos y construidos:

| Hueco | Mecanismo | Dónde |
|---|---|---|
| Promesas no respaldadas | Comparación de **cifras** contra lo que devolvieron las capacidades del turno; `PROMESAS_MODO=observacion` mientras se mide | `intelligence/engine/guardarrailPromesas.js` |
| Handoff sin humano | Frase honesta con el horario si lo hay, la conversación pasa a `handoff_humano` y **el bot no vuelve solo** (ver Enmienda 1) | `intelligence/engine/handoff.js` |

Y la regla de producto que los gobierna, del dueño (2026-08-18): *«debe existir una regla implícita
y estricta para esto, solo debe limitarse a lo que existe»*. En F7 esa regla se extendió al terreno
nuevo —las mutaciones— con dos comprobaciones nuevas en el arnés: pedir confirmación de algo cuyo
dato el cliente no dio cuenta como inventar, aunque no se ejecute nada.

El detalle de por qué cada mecanismo es así, y los dos agujeros que solo aparecieron probándolos
contra un modelo real, está en `ESTADO-Y-CONTINUACION.md` §6.13 y §6.14.

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

Este ADR quedó en estado **Propuesto** a propósito: la decisión de mecanismo debía tomarse **antes de
F7** (la primera fase con mutaciones vía IA), no en julio, pero se registró entonces para que no se
descubriera en producción. Se cumplió: los dos mecanismos se decidieron y se construyeron el
2026-08-18, y el ADR pasó a *Aceptado* al empezar F7 el 2026-08-19.

## Alternativas consideradas

**Solo una instrucción en el prompt** ("nunca ofrezcas descuentos que no vengan de una capacidad").
Necesaria pero insuficiente: es una instrucción, y las instrucciones se eluden con inyección de
prompts. No es una defensa estructural.

**Un handoff que asume humano siempre disponible.** Descartada: falla exactamente cuando más se
necesita (fuera de horario, negocios unipersonales).

**No hacer nada y confiar en el buen comportamiento del modelo.** Descartada: es la postura que
convierte un riesgo conocido en un incidente con un cliente real.

## Decisión (confirmada en F7)

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
- ~~Es un riesgo **abierto**: hasta que se confirme el mecanismo en F7, el sistema queda expuesto a él~~
  **Cerrado en F7.** Lo que queda no es exposición, son límites conocidos y anotados: el guardarraíl no
  ve promesas sin número («te lo dejamos gratis»), y el horario del handoff llega `null` mientras
  `platform.business_context` no exista (ADR-020).

## Enmienda 1 (2026-08-29) — «el bot no vuelve» **solo** significa que no vuelve solo

**Estado: Aceptada.** No revoca nada de lo anterior; acota qué prohibía.

### Qué pasó

La Bandeja (F8, `intelligenceBandejaController`) le dio por fin al negocio un sitio donde
contestar. Y al usarla apareció el otro lado de esta decisión: **una conversación escalada se
quedaba del humano para siempre.** El cliente vuelve tres días después a preguntar otra cosa —una
cosa que el asistente sabe hacer, como pedir a domicilio— y no le contesta nadie hasta que una
persona lo vea.

Eso no es lo que este ADR quería proteger. Lo que quería proteger es la frase del §Contexto:
*«sería contradecir lo que ya se le prometió al cliente»*. La promesa era **«le responde una
persona»**, y esa promesa se cumple en cuanto una persona responde. Lo que pase después ya no la
toca.

### La distinción, que es la enmienda entera

|  | ¿Permitido? |
|---|---|
| El bot **vuelve solo** pasadas unas horas | **NO.** Sigue prohibido, y es lo que decidió el ADR original. |
| Una persona dice «ya terminé, que siga el asistente» | **SÍ.** Es una decisión humana, no una recuperación automática. |

El acto es distinto y el actor también. Nada vuelve por un temporizador: alguien pulsa un botón
sabiendo lo que hay en el hilo.

### Las tres condiciones que la hacen segura

Sin ellas, esto sí sería revocar el ADR:

1. **Explícita y por persona.** No hay caducidad, ni «pasadas 24 h vuelve», ni nada que ocurra sin
   que alguien lo decida. Si nadie pulsa, la conversación sigue siendo del humano para siempre —
   el comportamiento de hoy.
2. **El asistente hereda el contexto, y sabe que era de otro.** Los mensajes escritos a mano se
   guardan con `crudo.origen = 'humano'` y `historialReciente()` se los presenta marcados. Sin esa
   marca, el modelo leería lo que dijo una persona **como si lo hubiera dicho él**, y podría
   sostener un compromiso que nunca hizo — que es justo el hueco 1 de este ADR entrando por la
   puerta de atrás.
3. **Si vuelve a no saber, vuelve a escalar.** El handoff no se desactiva al devolver la
   conversación: el ciclo no se puede quedar atrapado, y el segundo escalado se comporta igual que
   el primero.

### Lo que NO cambia

- `handoff_humano` sigue significando «el bot no habla aquí», y el motor lo sigue tratando como
  pasivo.
- Marcar una conversación como **atendida** (`atendida_en`) sigue sin devolvérsela al bot: son dos
  preguntas distintas y siguen siendo dos columnas.
- Ninguna ruta automática puede cambiar `estado` de `handoff_humano` a `activa`. La única que lo
  hace es la que nace de un clic.

## Impacto futuro

Es el reconocimiento de que la seguridad de datos no basta para un producto que vende "un empleado que
habla en tu nombre". Cualquier capacidad de mutación o negociación futura entra bajo el alcance del
guardarraíl.

Lo que F7 añadió al alcance: **una capacidad de mutación nueva declara si exige confirmación humana**
(`registry.CONFIRMACION`) y el Policy Gate se niega a ejecutarla sin la prueba del sí. Es fail-closed a
propósito — omitirlo no ejecuta— porque el modo de fallo real de esta regla no es que alguien la
falsifique, es que un camino nuevo se olvide de ella.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (riesgos 11.2 y 11.4), `architecture/freeze.md` (§D.4, decisión abierta)
- [ADR-007](ADR-007-capacidades.md), [ADR-010](ADR-010-ejecucion-segura.md), [ADR-011](ADR-011-business-policy.md)
