# El Nivel 4: qué proveedor, qué modelo, y cómo se decide

**Fase:** F6 · **Gobierna:** [ADR-018](adr/ADR-018-estrategia-modelos.md), [ADR-019](adr/ADR-019-prompt-builder.md)

## Hay dos proveedores montados, y es transitorio

ADR-018 descartó por escrito **mantener cinco integraciones vivas**: «la abstracción existe para
*poder* cambiar, no para *estar cambiando*». Lo que no descartó es comparar antes de elegir — y
elegir proveedor sin medirlo es exactamente la corazonada que el ADR quiere sustituir por datos.

Así que hoy están montados los dos, `openai` y `anthropic`, con una condición: **esto tiene fecha
de caducidad.** Se mide, se decide, y el que pierda se borra del disco y de
`intelligence/model/adaptadores/index.js`. Dos adaptadores mantenidos a medias es el impuesto que
ADR-018 no quiere pagar.

```bash
# La comparación que decide. Mismas conversaciones, mismos criterios, distinto modelo.
FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js respuestas --negocio 1 \
    --comparar gpt-5.6-luna,gpt-5.6-terra,claude-opus-5
```

La tabla ordena por **acierto** y, a igualdad de acierto, por **costo**. Si el modelo barato
acierta lo mismo que el caro, eso no es solo una decisión de proveedor: es evidencia sobre la
pregunta que ADR-018 dejó abierta —si el nivel intermedio de la escalera se justifica— y la
respuesta sale de la medición, no de la intuición.

### Lo que el segundo adaptador demostró

Que el puerto era delgado de verdad. Enchufar un proveedor con otra forma de API **no obligó a
tocar el núcleo**: ni el Prompt Builder, ni el orquestador, ni el manejador de Nivel 4, ni el
Ledger, ni un solo test de los que ya existían. Lo único que se generalizó fue la tabla de
precios, y por un motivo del mundo real: OpenAI cobra la caché de otra manera.

### Las cuatro diferencias que muerden al cambiar de proveedor

| | Anthropic | OpenAI |
|---|---|---|
| Contadores de tokens | Disjuntos | **`prompt_tokens` incluye los cacheados** — hay que restar, o se cobra dos veces |
| Argumentos de una capacidad | Objeto ya parseado | Texto JSON, y el propio SDK avisa de que puede venir roto |
| Caché de prefijo | Se marca en el prompt | Automática, no hay nada que marcar (la disciplina de ADR-019 vale igual) |
| Resultados de capacidades | Todos en un mensaje | Uno por mensaje |

La primera es la peligrosa: **no falla nada**, simplemente el Ledger dice un número y el
proveedor cobra otro, hasta 10× por encima. Tiene su propio test, y se comprobó rompiéndolo.

## La quinta diferencia, la que dejó el adaptador inservible (2026-08-18)

Las cuatro de arriba se descubrieron leyendo documentación. Ésta apareció en la **primera llamada
real** y era la única que importaba: **`gpt-5.6-*` no admite herramientas y `reasoning_effort` a la
vez** en `/v1/chat/completions`.

```
400 Function tools with reasoning_effort are not supported for gpt-5.6-luna
in /v1/chat/completions. To use function tools, use /v1/responses
or set reasoning_effort to 'none'.
```

Tres cosas que conviene tener claras:

- **No es del modelo barato.** `gpt-5.6-terra` da el mismo 400. Es de la familia y del endpoint.
- **Omitir el parámetro no arregla nada**: también da 400, porque el modelo razona por defecto. Hay
  que pedir `'none'` explícitamente.
- **Muerde en todos los turnos que importan.** El Nivel 4 ofrece capacidades siempre, así que el
  adaptador no servía para nada — con 164 tests en verde, porque un cliente falso acepta cualquier
  combinación de parámetros.

Hoy está **apañado**: `esfuerzoParaChatCompletions()` manda `'none'` cuando hay capacidades y avisa
por consola una vez. El precio es real y hay que decirlo en voz alta: **`LLM_ESFUERZO` queda inerte
en OpenAI** para los turnos con capacidades, y con él el barrido de esfuerzo que este documento
pedía. La salida definitiva es la que señala la propia API: **migrar el adaptador a
`/v1/responses`**, donde las dos cosas conviven.

No se hizo ya por una razón medible: **sin razonamiento, `gpt-5.6-luna` acierta 19/19 en
`respuestas` y 20/20 en `inyeccion`**. Migrar el endpoint para recuperar un parámetro que quizá no
haga falta es trabajo antes de la evidencia. Ahora bien, es lo primero que hay que resolver antes de
elegir modelo definitivo — y si se elige Anthropic, no hace falta en absoluto.

### Y la caché tiene un umbral, no solo un prefijo

`cache_read = 0` no siempre acusa al Prompt Builder. **OpenAI no cachea por debajo de 1024 tokens de
entrada.** Los prompts de las suites rondan los 950-1020, así que el cero era el umbral. Medido:
dos llamadas idénticas de 3213 tokens → **3210 cacheados** en la segunda. El criterio de aceptación
de ADR-019 sigue, por tanto, **sin verificar de verdad**; se verificará cuando Knowledge (ADR-020)
engorde el prompt por encima del umbral.

## La divergencia con ADR-018, dicha en voz alta

[ADR-018](adr/ADR-018-estrategia-modelos.md) fija el **Nivel 4 premium** como «el LLM más capaz,
**hoy** `claude-opus-4-8`», y el `master-plan` recomienda ese mismo id. La implementación usa
`claude-opus-5`.

No es una decisión de arquitectura tomada por la implementación: es la palabra «hoy». El ADR
congela **que haya dos niveles y que el de arriba sea el modelo más capaz disponible**; el id
concreto es la lectura del catálogo en la fecha en que se escribió. Claude Opus 5 es el sucesor
directo de Opus 4.8 en la misma línea, **al mismo precio de lista** ($5 / $25 por millón de
tokens), así que seguir la regla del ADR lleva a este id y no al otro.

Lo que **no** cambia con esto:

- El puerto sigue siendo la única vía al modelo, así que el cambio es una cadena en `precios.js`
  y en `LLM_MODELO`, no una cirugía.
- Ambos modelos están declarados en `intelligence/model/precios.js` con su tarifa, y la
  composición comprueba al arrancar que todo modelo servible sea facturable.
- Volver a `claude-opus-4-8` es una variable de entorno: `LLM_MODELO=claude-opus-4-8`.

Si la decisión se quiere cerrar formalmente en el corpus, el sitio es una nota en ADR-018 —no
este archivo—, y el criterio para elegir debería salir del arnés, no de la ficha del proveedor.

## Los tres parámetros que mueven dinero

| Variable | Por defecto | Qué pasa si se cambia |
|---|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | vacías | Con ninguna, la escalera se queda en el Nivel 1 y todo cuesta $0.00. No es un fallo. |
| `LLM_MODELO` | el del proveedor con clave | Cambia tarifa y calidad. **Su proveedor se deduce del modelo**, así que basta con esto. Debe existir en `precios.js`. |
| `LLM_PROVEEDOR` | deducido | Solo hace falta con las dos claves puestas. Si contradice a `LLM_MODELO`, el arranque falla en vez de elegir en silencio. |
| `LLM_ESFUERZO` | `low` | Sube la profundidad de razonamiento, el costo y la latencia. |
| `LLM_MAX_CENTAVOS_TURNO` | `5` | Tope duro por turno. Al saltar, el turno responde con el handoff. |

### Modelos con tarifa declarada

| Modelo | Proveedor | Entrada / Salida / Caché (USD por millón) | Peldaño |
|---|---|---|---|
| `gpt-5.6-luna` | openai | 0.20 / 1.20 / 0.02 | 2 (el barato) |
| `gpt-5.6-terra` | openai | 2.00 / 12.00 / 0.20 | 4 |
| `gpt-5.6-sol` | openai | 5.00 / 30.00 / 0.50 | 4 |
| `gpt-4o` | openai | 2.50 / 10.00 / 1.25 | 4 |
| `claude-haiku-4-5` | anthropic | 1.00 / 5.00 / 0.10 | 2 |
| `claude-opus-4-8` | anthropic | 5.00 / 25.00 / 0.50 | 4 |
| `claude-opus-5` | anthropic | 5.00 / 25.00 / 0.50 | 4 |

Añadir un modelo es una fila en `precios.js` con **las cuatro tarifas tal como las publica el
proveedor**. No se derivan de un multiplicador: eso fue verdad con un solo proveedor y dejó de
serlo con el segundo. Y si una tarifa no cae en un múltiplo de 10 nanodólares por token, el
catálogo la rechaza al cargar — porque entonces el importe no cabe exacto en la columna que
factura, y el fallo aparecería en producción en el primer turno con la paridad equivocada
(le pasa a `gpt-4o-mini`, y por eso no está en la tabla).

**El esfuerzo no se elige a ojo.** Para eso está el arnés: mide acierto, costo y latencia sobre
las mismas conversaciones doradas, así que un barrido responde la pregunta con datos.

```bash
FEATURES_FORZADAS=asistente_ia LLM_ESFUERZO=low    node scripts/evaluar.js respuestas --negocio 1
FEATURES_FORZADAS=asistente_ia LLM_ESFUERZO=medium node scripts/evaluar.js respuestas --negocio 1
```

## Lo que hay que mirar para saber que F6 sigue cumpliendo

| Señal | Valor esperado | Qué significa si cambia |
|---|---|---|
| `cache_read_input_tokens` sostenido | **> 0** | Cero de forma sostenida **no** es «no hay caché»: es un invalidador silencioso delante del punto de corte, y ADR-019 lo convierte en criterio de aceptación — con eso a cero, **la fase no está terminada**. |
| Capacidades invocadas por el LLM | solo `tipo = consulta` | Una mutación invocada desde el Nivel 4 es la frontera de F7 rota. |
| Filas en `intelligence.costo` por turno `llm` | ≥ 1 | Un turno con LLM sin costo es un agujero en la factura. |
| `ratio_determinista` en la Consola | **< 1** y estable | Que baje es lo esperado en F6 (antes era 1 por definición). Que se desplome significa que la tabla de enrutado está mandando al modelo lo que la FSM hacía gratis. |

## La frontera que F6 no cruza

El modelo **no tiene ninguna capacidad de mutación**. No es una restricción de configuración que
alguien pueda relajar con una variable: `manejadorLlm.js` filtra por `tipo === 'consulta'` al
construir el prompt y **vuelve a comprobarlo** antes de ejecutar. El día que F7 lo cambie, lo hará
con confirmación humana explícita en el canal y con el guardarraíl de
[ADR-023](adr/ADR-023-guardarrailes.md) decidido — que a día de hoy sigue en estado *Propuesto*.
