# ADR-027 — Avisos en vivo a las pantallas: SSE, y una señal que no es un evento de dominio

**Estado:** Propuesto · **Fecha:** 2026-09-11

## Contexto

Con tres clientes en producción apareció un problema que con uno no se veía: **varias personas
del mismo negocio trabajando a la vez en equipos distintos no se ven entre ellas.** Un mesero
cobra una mesa en el computador y en la tablet del otro sigue ocupada; cocina marca un plato
listo y Despacho no se entera; alguien abre la caja y los demás siguen con el POS bloqueado.

El estado de partida, medido: de las cinco pantallas de trabajo de restaurante, **solo Cocina se
refrescaba sola, cada 30 segundos**. Mesas, POS, Despacho y Caja no se refrescaban nunca —solo al
entrar o al hacer algo—. El infraestructura es un VPS de **1 vCPU y 1 GB**, compartido con la base
de datos.

## Decisión

**Un canal SSE (Server-Sent Events) por pestaña, que transporta una SEÑAL efímera —no los datos y
no un evento de dominio— y que hace que la pantalla recargue por el endpoint de siempre.**

Tres partes, y las tres importan por separado:

1. **SSE, no WebSockets.**
2. **Viaja la señal («cambió algo de pedidos»), no el contenido.**
3. **No pasa por el outbox de ADR-012.**

## Alternativas descartadas

**WebSockets (`socket.io`).** Descartada. Es un tubo de dos vías y aquí solo se usa una: lo que el
usuario *hace* ya viaja por las rutas REST. A cambio de la vía que nadie usa se paga ~1 MB de
dependencias, un protocolo de handshake propio, salas y su propia maquinaria de reconexión. SSE da
lo mismo con `res.write()` y una API que el navegador ya trae.

**Sondear más rápido (bajar el refresco a 5 segundos y extenderlo a las cinco pantallas).**
Descartada por coste, que es lo contrario de lo que parece: con las ~12 pantallas de tres clientes
son **~8.600 consultas a la base por hora aunque no pase nada**. Con SSE, en reposo el gasto es
**cero consultas** y una conexión abierta por pestaña. Sale más barato *y* baja la espera de 30
segundos a menos de uno.

**Mandar los datos en el aviso** (el pedido nuevo, la mesa cambiada). Descartada, y es la
decisión más importante de las tres: las reglas de quién puede ver qué viven en los endpoints
—por ejemplo, `caja_ver_ingresos` vacía los importes para quien no lo tiene—. Mandar datos por el
canal obliga a repetir esas reglas en un segundo camino, y el día que se olvide una, **el canal
enseña lo que la pantalla esconde**. La señal cuesta una consulta extra y mantiene las reglas en
un solo sitio.

**Hacerlo pasar por el outbox transaccional (ADR-012).** Descartada, y hay que reconciliarla
explícitamente porque ADR-012 dice que el outbox «es el canal por el que todo evento de dominio
fluye hacia todo consumidor». La reconciliación es que **esto no es un evento de dominio**: no
tiene significado de negocio, no se puede reproducir, no lleva orden y **perderlo no tiene
consecuencia** —la siguiente señal, o la reconexión, ponen al día—. Meterlo ahí significaría
escribir una fila en la base cada vez que alguien toca un pedido y sondear esa tabla cada 5
segundos, en la misma máquina donde corre la base del cliente. Si algún día un evento de dominio
de verdad tiene que llegar a una pantalla, se registra un consumidor del relay que llame a
`emitir()`: los dos caminos conviven sin mezclarse.

**Postgres `LISTEN/NOTIFY` como transporte interno.** Descartada *por ahora*: hace falta cuando
hay varios procesos de Node, y hoy hay uno solo (systemd, sin cluster). Un `EventEmitter` en
memoria basta. El día que haya dos procesos, esto es lo que cambia —y solo esto, porque está
detrás de `emitir()`.

## Consecuencias

### Positivas

- La espera baja de 30 segundos (solo cocina) a **menos de un segundo en las cinco pantallas**.
- **En reposo no se consulta la base.** Es más barato que lo que había.
- Cero dependencias nuevas.
- Los pedidos que entran **por WhatsApp** aparecen solos en Despacho, sin que el canal sepa que
  existe un bot: el aviso cuelga del commit de la transacción, no de quién la abrió.
- La ruta `/restaurante/eventos` **comprueba la pertenencia al negocio ella misma y falla
  cerrada**, sin importar `AUTHZ_MODO`. Es más estricta que el resto de la API a propósito: aquí
  no se responde una vez, se abre un grifo que suelta la operación de un negocio durante horas.

### Negativas

- **Una conexión abierta por pestaña.** Hay topes (40 por negocio, 200 en total) para que un
  cliente con un bucle roto no se lleve por delante el servidor; al superarlos se responde 503 y
  la pantalla se queda con su refresco por reloj.
- **Sobre HTTP/1.1 el navegador solo mantiene 6 conexiones por origen.** Por eso hay **una sola
  conexión por pestaña compartida por todas las pantallas**, y no una por pantalla: eso se comería
  el cupo y dejaría al POS esperando turno detrás de conexiones que no terminan nunca. En
  producción Caddy sirve HTTP/2 y el límite deja de aplicar; en desarrollo (`localhost:3000`) no.
- **Falta verificar en el VPS que Caddy no esté reteniendo la respuesta.** Si comprime o
  almacena en búfer, los avisos llegan a bocanadas o no llegan. El código manda
  `Cache-Control: no-transform` y `X-Accel-Buffering: no`, pero **hay que comprobarlo con el
  canal abierto contra producción antes de darlo por bueno**.
- La entrega es **al menos cero veces**: no hay garantía ninguna. Es aceptable porque la puesta al
  día la hace la pantalla preguntando (al reconectar y al volver a la pestaña), no el servidor
  recordando. Cualquier cosa que necesite garantía **no va por aquí, va por el outbox**.

## Impacto futuro

`app_core/realtime/` es compartido a propósito: `reserva` tiene el mismo problema (la agenda la
miran varias personas) y engancharla es registrar sus temas y llamar a `emitir()`, sin tocar nada
de esto. Los temas son áreas de datos (`pedidos`, `mesas`, `cocina`, `caja`) y no pantallas, para
que añadir una pantalla no obligue a repasar cada punto de emisión del backend.
