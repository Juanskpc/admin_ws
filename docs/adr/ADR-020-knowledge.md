# ADR-020 — Knowledge como bounded context reservado

## Estado

Aceptado *(implementación diferida)*

## Contexto

El asistente necesita dos cosas que parecen la misma pero no lo son: la **configuración** del negocio
(horarios, servicios, instrucciones para el asistente) y el **conocimiento** del negocio (un PDF de
menú, un reglamento, un catálogo, FAQs). Es tentador meter ambas en "el contexto que le pasamos al
modelo". Sería un error de categoría con factura mensual.

Son cosas con propiedades técnicas **opuestas**:

| | Business Context (configuración) | Knowledge (conocimiento) |
|---|---|---|
| Naturaleza | Estructurada, pequeña, escrita a mano | No estructurada, grande, ingerida |
| Volumen | Cientos de bytes | Megabytes por inquilino |
| Cambia | Rara vez | Al subir un PDF, cambiar el menú… |
| En el prompt | SIEMPRE, en el prefijo estable | SELECTIVAMENTE, recuperado por turno |
| Respecto a la caché | Parte del prefijo cacheado | **Después** del punto de corte |
| Autoridad | Instrucción para el asistente | Dato que el asistente consulta |

La última fila decide: si metemos el menú o el reglamento en Business Context, o el prompt se infla
hasta ser insostenible, o —peor— **cada vez que el negocio suba un PDF se invalida el prefijo cacheado
de todas sus conversaciones** ([ADR-019](ADR-019-prompt-builder.md)), y el costo se multiplica sin que
nadie entienda por qué.

## Alternativas consideradas

**Meter el conocimiento en Business Context.** Descartada: el error de categoría descrito arriba.
Rompe la caché y confunde "instrucción que el modelo obedece" con "dato que el modelo consulta".

**Implementar RAG con embeddings / pgvector ya.** Descartada por prematura: es un pipeline de ingesta,
un índice vectorial y un sistema nuevo que operar, para un problema que aún no tenemos. La v1 de
Knowledge, cuando llegue, será **pares pregunta/respuesta aprobados por el negocio**, recuperados por
coincidencia determinista (Nivel 1) — cero embeddings. Eso resuelve el 80% de los casos reales de una
PyME ("¿tienen parqueadero?", "¿aceptan tarjeta?") a coste cero y con respuestas **aprobadas, no
generadas**, que además es mejor producto. RAG con embeddings llega el día que un inquilino suba un PDF
de 40 páginas — y puede que ese día no llegue nunca.

**No reservar nada y resolverlo cuando aparezca.** Descartada: sin reservar el terreno, el primer FAQ
se cuela en Business Context "temporalmente" y ahí se queda para siempre.

## Decisión

Se **reserva el bounded context `knowledge` ahora y no se implementa nada**. Reservar cuesta casi nada
y son tres cosas:

1. **Nombrarlo.** Existe el contexto `knowledge`; está declarado; nadie más ocupa ese terreno.
2. **Blindar Business Context:** contiene solo configuración e instrucciones. Si alguien quiere meter
   *contenido*, va a Knowledge.
3. **Dejar la ranura en el Prompt Builder:** una ranura de "conocimiento recuperado" **después** del
   punto de corte de caché ([ADR-019](ADR-019-prompt-builder.md)). En v1 está vacía. El día que
   Knowledge exista, se llena, y no hay que rediseñar nada.

## Consecuencias positivas

- Business Context queda protegido de convertirse en un cajón de contenido que rompe la caché.
- La costura queda lista: activar Knowledge más adelante es aditivo, no un rediseño.
- Cuando se implemente, la v1 barata (Q/A aprobadas) da valor real sin la complejidad de RAG.

## Consecuencias negativas

- Reservar un contexto que hoy está vacío puede parecer burocracia a quien no vea la factura que evita.
- Existe el riesgo de que "reservado" se confunda con "hazlo ya"; este ADR deja explícito que **no** se
  implementa hasta que un caso real lo pida.

## Impacto futuro

Protege la disciplina de caché ([ADR-019](ADR-019-prompt-builder.md)) a largo plazo y deja abierto el
camino a RAG sin comprometerlo hoy. Cuando llegue un inquilino con documentos extensos, Knowledge
evoluciona de Q/A determinista a recuperación semántica **detrás de la misma ranura**, sin tocar el
Prompt Builder ni Business Context.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 3, Knowledge reservado), `architecture/freeze.md`
- [ADR-019](ADR-019-prompt-builder.md)
