# El Nivel 4: qué modelo, y por qué no el que dice el ADR

**Fase:** F6 · **Gobierna:** [ADR-018](adr/ADR-018-estrategia-modelos.md), [ADR-019](adr/ADR-019-prompt-builder.md)

## La divergencia, dicha en voz alta

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
| `LLM_MODELO` | `claude-opus-5` | Cambia la tarifa y la calidad. Debe existir en `precios.js`. |
| `LLM_ESFUERZO` | `low` | Sube la profundidad de razonamiento, el costo y la latencia. |
| `LLM_MAX_CENTAVOS_TURNO` | `5` | Tope duro por turno. Al saltar, el turno responde con el handoff. |

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
