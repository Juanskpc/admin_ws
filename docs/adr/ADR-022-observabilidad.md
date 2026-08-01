# ADR-022 — Observabilidad y Ledger de costos

## Estado

Aceptado

## Contexto

Un sistema conversacional con IA es opaco por naturaleza: cuando "el bot hizo algo raro", hay que poder
reconstruir qué pasó — qué mensajes llegaron, qué nivel resolvió el turno, qué capacidades se
ejecutaron, qué decidió, cuánto costó, cuánto tardó. Sin eso, depurar es adivinar y el costo es un
misterio.

Y hay una parte que es más seria que "telemetría": **el costo por conversación no es una métrica de
operaciones, es un insumo de facturación.** Determina el margen por inquilino, alimenta los límites del
plan y decide si un cliente es rentable o te está costando dinero. Eso cambia el estándar de fiabilidad
con el que se registra.

## Alternativas consideradas

**Observabilidad como una fase del roadmap.** Descartada: una fase tiene principio y fin, y la
observabilidad no termina nunca. Convertirla en fase garantiza que se haga una vez y se pudra después.

**Costo con muestreo / best-effort** (como se hace con logs y métricas). Descartada para el costo:
tratar el costo como telemetría —con pérdidas aceptables, reintentos que se descartan— es inaceptable
cuando ese número factura. Los logs se pueden perder; esto no.

**Una consola con datos simulados** para tener algo visible temprano. Descartada: construir UI contra
datos que no existen obliga a inventar sus formas, que cambian en cuanto los datos son reales; y —peor—
da una **falsa sensación de progreso**, justo lo que se quería evitar.

## Decisión

Tres decisiones que convergen:

- **Observabilidad = criterio de aceptación de toda fase, no una fase.** Regla dura: *ninguna fase se
  da por terminada si su comportamiento no es observable; no hay entregable sin su métrica.* Es más
  fuerte que una fase porque no se puede posponer ni recortar.
- **El Ledger de decisiones y costos** (`turno`, `decision`, `tool_call`, `costo`) se trata con
  **estándar contable, no de telemetría**: se escribe **transaccionalmente** junto con el turno, en
  `intelligence`, no se pierde y cuadra. No es un log. Su esquema se diseña en F5 tomando como
  especificación literal las doce preguntas que debe poder responder (costo por conversación, por
  negocio, modelo usado, tokens, latencia, tool calls, capacidades ejecutadas, errores, reintentos,
  conversaciones fallidas, tasa de resolución, ratio determinista-vs-IA). Si el esquema no responde a
  las doce, está mal diseñado. Es **irreversible**: lo que no registres hoy no lo podrás responder
  nunca.
- **La Intelligence Console** es la superficie de visualización de esta observabilidad — la misma cosa
  vista desde el otro lado. Nace en F5 con **datos reales** (el bot determinista produce
  conversaciones, turnos y decisiones reales; sin IA, el costo mostrado es $0, y eso también se
  muestra) y crece por fase: F6 añade nivel/modelo/tokens/costo/latencia/aciertos de caché; F7 añade el
  handoff y la auditoría. Es, además, la herramienta de depuración principal del desarrollador.
  **Prohibido construirla con datos simulados.**

## Consecuencias positivas

- Cada fase entrega comportamiento observable; nada se despliega a ciegas.
- El costo es fiable a nivel de facturación: se puede saber si un inquilino es rentable.
- La Console multiplica la velocidad de depuración de un equipo de una persona, sin trabajo tirado.

## Consecuencias negativas

- El estándar contable del costo (escritura transaccional, sin pérdidas) es más caro de implementar que
  telemetría best-effort. Justificado porque ese número factura.
- "Observabilidad en cada fase" es una carga continua: cada entregable arrastra su métrica. Es
  deliberado.

## Impacto futuro

El Ledger es de escritura única e irreversible: su esquema debe nacer completo en F5 porque los datos
no registrados no se recuperan. La Console evoluciona aditivamente por fase. El costo registrado aquí
es lo que, más adelante, alimenta límites de plan y decisiones de precio ([ADR-021](ADR-021-features.md)).

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (puntos 2 y 5, Console + Observabilidad convergen)
- [ADR-018](ADR-018-estrategia-modelos.md), [ADR-021](ADR-021-features.md), [ADR-024](ADR-024-persistencia.md)
