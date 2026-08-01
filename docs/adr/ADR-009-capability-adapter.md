# ADR-009 — Capability Adapter = Anticorruption Layer

## Estado

Aceptado

## Contexto

Una capacidad como `reservar_turno` tiene que, en algún momento, hablar con la vertical de reservas:
consultar disponibilidad, crear la cita. Ese código **sabe qué es una cita** — conoce el dominio de
reservas. La pregunta es **dónde vive ese conocimiento**, y la respuesta parece atrapada entre dos
principios que se contradicen:

- Si el código que sabe de citas vive **dentro de la vertical**, entonces la vertical tiene un módulo
  cuya razón de existir es servir a la IA → la vertical depende de Intelligence, y eso **viola el
  principio de independencia** ([ADR-005](ADR-005-independencia-verticales.md)).
- Si vive **dentro de Intelligence**, entonces Intelligence contiene código que sabe qué es una cita
  → ¿no viola eso el principio de que el núcleo sea **agnóstico de vertical**?

Resolver esta aparente contradicción es lo que este ADR hace, y es una de las decisiones que más
fácil se toma mal.

## Alternativas consideradas

**El adapter vive dentro de la vertical.** Descartada: invierte la flecha de dependencia. La vertical
pasaría a conocer y servir a la IA, violando [ADR-005](ADR-005-independencia-verticales.md). El día
que apagáramos Intelligence, la vertical tendría un módulo huérfano.

**El núcleo de Intelligence conoce el dominio de cada vertical.** Descartada: haría imposible el
objetivo de un núcleo con `git diff = 0` al añadir verticales, y acoplaría el cerebro conversacional
a cada dominio. Una vertical nueva obligaría a cirugía en el núcleo.

**El adapter vive en Intelligence, en una capa de adaptadores separada del núcleo.** Elegida. Es la
respuesta hexagonal: el **núcleo** es agnóstico; los **adaptadores** son, por definición, el lugar
donde vive el acoplamiento. Para eso existen.

## Decisión

El Capability Adapter vive en **`intelligence/adapters/<vertical>/`** y **consume el contrato público
que la vertical ya expone** (su servicio de dominio existente), no sus internals.

```
intelligence/
  core/         ← Engine, Orchestrator, Registry, Prompt Builder, Policy Gate.
                ← NUNCA sabe qué es una cita. El "git diff = 0" aplica AQUÍ.
  adapters/
    reserva/    ← Sabe qué es una cita. Consume el contrato público de reserva.
    restaurante/ ← Sabe qué es un pedido.
```

La flecha de dependencia es **siempre Intelligence → Vertical**. La vertical no sabe que Intelligence
existe. El adapter es también una **capa anticorrupción**: donde el modelo del Grupo 1 no permite
hacer algo limpio (p.ej. `pedid_orden` denormalizado, [ADR-003](ADR-003-madurez-esquemas.md)), la
compensación vive **aquí**, en el adapter, no dentro de la vertical.

## Consecuencias positivas

- Se cumplen a la vez la independencia de las verticales y el agnosticismo del núcleo, sin
  contradicción: cada principio aplica a su capa.
- Añadir una vertical al asistente es escribir un adapter nuevo; el núcleo no se toca.
- La deuda técnica del Grupo 1 se compensa fuera de la vertical, sin tocar producción.

## Consecuencias negativas

- El adapter depende del contrato público de la vertical: si ese contrato cambia, el adapter se
  actualiza. Es acoplamiento real, pero está **localizado y es explícito** — exactamente donde debe
  estar.
- La compensación anticorrupción puede acumular lógica fea (traducir modelos imperfectos). Es fea a
  propósito y está aislada; el precio de no ensuciar ni el núcleo ni la vertical.

## Impacto futuro

Todo el modelo de extensibilidad depende de esta separación núcleo/adaptador. Si un día un adapter
"se cuela" en el núcleo (el núcleo empieza a saber de citas), se pierde el `git diff = 0` y cada
vertical nueva vuelve a costar cirugía. Se protege con la disciplina de que el núcleo no importe
nada específico de una vertical — verificable por inspección.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 10, ubicación del adapter), `architecture/freeze.md`
- [ADR-003](ADR-003-madurez-esquemas.md), [ADR-005](ADR-005-independencia-verticales.md), [ADR-007](ADR-007-capacidades.md)
