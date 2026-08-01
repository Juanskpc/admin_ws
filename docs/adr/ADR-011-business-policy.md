# ADR-011 — Business Policy como dato enforced

## Estado

Aceptado

## Contexto

La arquitectura garantiza que la IA no puede **hacer** nada fuera de las capacidades. Pero no le
impide **decir** cosas que comprometen al negocio: *"claro, te hago un 20% de descuento"*. Ninguna
capacidad se ejecutó, ningún dato se corrompió, el Policy Gate está impecable — y sin embargo el
negocio tiene mañana un cliente esperando un descuento que nadie autorizó. Toda nuestra seguridad
protege la base de datos; nada protege **la palabra del negocio**, que es literalmente el producto
que vendemos ("un empleado virtual").

Surge la pregunta de si debe existir un dominio donde vivan reglas como "la IA puede ofrecer
descuentos", "puede negociar precios", "puede prometer tiempos", "puede reagendar", "puede cancelar".

## Alternativas consideradas

**Meterlo todo en un solo saco "Business Policy" tal como se listó.** Descartada tras separar la
lista, porque mezcla dos cosas distintas:

- *"La IA puede reagendar / cancelar / modificar pedidos / comprometer recursos"* — **esto ya está
  resuelto y no es dominio nuevo.** Son **capacidades**: si `reagendar_cita` está registrada y
  habilitada para el asistente de este negocio, la IA reagenda; si no, no puede. Lo gobierna la
  habilitación de capacidades y el Policy Gate ([ADR-010](ADR-010-ejecucion-segura.md)). Duplicarlo
  en un "Business Policy" sería redundante.
- *"La IA puede ofrecer descuentos / negociar precios / prometer tiempos"* — **esto sí es nuevo**: no
  es una capacidad que se tenga o no, es un **parámetro económico** dentro de una capacidad, o un
  acto de habla sin capacidad ninguna.

**Resolverlo con una instrucción en el prompt** ("nunca ofrezcas más de 10% de descuento").
Descartada como mecanismo de enforcement: una instrucción es **ineforzable** (se elude con inyección)
e **intesteable** (no hay unit test de un prompt). Sirve como refuerzo, no como garantía.

**Un motor de reglas / DSL de políticas.** Descartada por sobreingeniería: para un equipo de una
persona, un motor de reglas es maquinaria pesada sin cliente que la justifique hoy.

**Fusionar con Business Context.** Descartada: Business Context es *advisory* (instrucciones que el
modelo puede ignorar); Business Policy es *enforced* (código que no se salta). Fusionarlos borraría
justo la distinción que queremos proteger.

## Decisión

**Business Policy es un dato de configuración por inquilino, aplicado por la capacidad — no un motor
de reglas ni una instrucción de prompt.** Un límite como `descuento_maximo = 10%` es un **valor** que
la capacidad `aplicar_descuento` lee y **hace cumplir dentro de su transacción**; es imposible de
violar diga lo que diga el modelo, y es testeable. Mismo principio que "el `id_negocio` nunca viene
del modelo": el enforcement es **estructural**, en el código, no en la buena voluntad del LLM.

Se empieza con **3–4 límites que una capacidad real aplique** (descuento máximo, piso de precio,
ventana cancelable, ¿reembolsable?). No se enumera la lista completa por adelantado; crece cuando una
capacidad nueva lo necesite.

Esto convive con el **guardarraíl de salida** ([ADR-023](ADR-023-guardarrailes.md)) como dos defensas
para dos fallos distintos: la policy caza *"invocó una capacidad con parámetros fuera de lo
permitido"*; el guardarraíl caza *"dijo algo que ninguna capacidad respalda"*.

## Consecuencias positivas

- Los límites económicos son imposibles de violar y son testeables, independientes del modelo.
- La distinción advisory/enforced queda nítida y protegida.
- Mínimo por diseño: sin motor de reglas, sin DSL, sin lista especulativa.

## Consecuencias negativas

- Cada límite nuevo exige que una capacidad lo lea y lo aplique: es trabajo de dominio, no
  configuración libre. (Es lo correcto, pero no es gratis.)
- No cubre las promesas *sin* capacidad (los descuentos hablados de la nada); ese hueco lo tapa el
  guardarraíl de salida, no este ADR.

## Impacto futuro

Business Policy es una superficie de configuración que la plataforma posee y las capacidades
consumen; junto con Features ([ADR-021](ADR-021-features.md)) y la habilitación de capacidades, forma
la compuerta de tres capas del Policy Gate: **comercial** (¿el plan incluye IA?) → **dominio** (¿la
capacidad está habilitada?) → **económica** (¿dentro de qué límites?). Mantener las tres separadas
evita que la lógica de facturación se filtre al dominio.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 3 y riesgo 11.2), `architecture/freeze.md` (§D.5)
- [ADR-010](ADR-010-ejecucion-segura.md), [ADR-021](ADR-021-features.md), [ADR-023](ADR-023-guardarrailes.md)
