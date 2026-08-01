# ADR-015 — MVP determinista antes del LLM

## Estado

Aceptado

## Contexto

Es tentador empezar por lo llamativo: conectar un LLM cuanto antes y ver al asistente "hablar". Pero
todo el sistema alrededor del modelo —Conversation Engine, capacidades, Policy Gate, adaptadores,
outbox, resolución de identidad, memoria, canales— es infraestructura compleja que puede tener bugs
propios, independientes de la IA.

Si conectamos el LLM temprano, los bugs de infraestructura (un lock que no se libera, un evento que
se pierde, una capacidad que no revalida) se mezclan con los bugs de IA (una alucinación, un prompt
mal ordenado) y se vuelven **indistinguibles**. Depurar "el bot hizo algo raro" cuando no sabes si
fue el motor o el modelo es una pesadilla, y es cara: cada iteración de depuración con el modelo
premium cuesta dinero.

## Alternativas consideradas

**Empezar por el LLM y construir el resto alrededor.** El camino intuitivo y demo-able antes.
Descartada: mezcla las dos fuentes de error desde el día uno y hace que el sistema sea imposible de
depurar con confianza. Además ata el diseño de la infraestructura a lo que el modelo "parece
necesitar" en vez de a lo que el dominio necesita.

**Saltarse la fase determinista** y confiar en que la infraestructura "ya funcionará" cuando el
modelo la ejercite. Descartada: la infraestructura se prueba mejor con un conductor **predecible** que
con uno no determinista. Un bot determinista es un banco de pruebas perfecto; un LLM no.

**Construir el sistema completo sin IA primero, y conectar el LLM al final como un cliente más.**
Elegida.

## Decisión

La tesis del proyecto: **"Construimos el sistema completo sin IA. Cuando funcione, le conectamos la
IA como un cliente más."**

Se construye primero un **bot determinista** (menús, reglas, comandos conocidos) que ejercita **toda**
la espina dorsal —Conversation Engine, capacidades, Policy Gate, adaptadores, outbox, identidad—
**sin un solo token de LLM**. Ese es el **MVP interno** (fase F5). Solo cuando esa espina dorsal es
sólida y observable se conecta el primer modelo, primero en modo solo-lectura.

El LLM entra por el `ModelPort` ([ADR-018](ADR-018-estrategia-modelos.md)) como un conductor más del
mismo motor que el bot determinista ya condujo.

## Consecuencias positivas

- Cuando el LLM se conecta, la infraestructura ya está probada: cualquier fallo nuevo es **del
  modelo**, no del motor. Los bugs quedan separados y depurables.
- Retira ~70% del riesgo del proyecto (todo lo que no es IA) antes de gastar un peso en tokens.
- El Nivel 1 determinista no es andamiaje desechable: se queda como el nivel que nunca falla, nunca
  cuesta y nunca alucina ([ADR-018](ADR-018-estrategia-modelos.md)).

## Consecuencias negativas

- Produce **semanas sin nada de IA demo-able**. Para una startup, es un riesgo de ejecución real
  (perder visibilidad del avance). Se mitiga con victorias tempranas que **no** son IA — sobre todo
  la Ficha 360 del Cliente, que sale de la Fase 0 (ver `architecture/revision-01.md`, punto 2).
- El bot determinista puede *parecer* trabajo tirado a la basura a quien no entienda que es el banco
  de pruebas de todo lo demás. **Es la fase que más se querrá recortar y la que menos debería.**

## Impacto futuro

Marca el orden de construcción de todo el subsistema inteligente. Si en el futuro se añade una
vertical o un canal, el mismo principio aplica: se prueba con el conductor determinista antes de
soltarle el modelo. Es una disciplina de construcción, no una fase que se hace una vez.

## Fecha

2026-07-14

## Referencias

- `architecture/master-plan.md` (F5, MVP interno), `architecture/revision-01.md` (puntos 2 y 9)
- [ADR-014](ADR-014-conversation-engine.md), [ADR-016](ADR-016-webchat-hostil.md), [ADR-018](ADR-018-estrategia-modelos.md)
