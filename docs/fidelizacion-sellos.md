# Tarjeta de sellos por WhatsApp — propuesta de diseño

**Estado:** propuesta, **sin decidir y sin construir** · **Fecha:** 2026-10-15 ·
**Viene de:** [`ideas-de-innovacion.md`](ideas-de-innovacion.md) (idea 1) ·
**Hermanos:** [`tiqueteras-y-fiado.md`](tiqueteras-y-fiado.md) (el libro de cuenta y cómo no contar
la plata dos veces) · [`promociones-masivas.md`](promociones-masivas.md) (audiencia, baja, plantillas)

> **En una frase.** «Llevas 7 de 10: la 10.ª va por la casa», sin app y sin tarjeta de cartón:
> los sellos salen **solos de los pedidos pagados** del cliente, se consultan por WhatsApp y el
> premio se canjea en el cobro como una línea con descuento. **El premio lo regala el negocio, no
> EscalApp**: EscalApp vende la herramienta.

---

## 1. Quién regala qué (la duda que hay que despejar primero)

| | Pone | Recibe |
|---|---|---|
| **El negocio** | el premio (la hamburguesa) — le cuesta su **costo de producción**, no el precio de carta | clientes que vuelven más seguido |
| **EscalApp** | la herramienta | lo que cobre por ella (plan o complemento, §9) |
| **El cliente final** | sus compras | el premio |

EscalApp **no** debe financiar premios: sería pagar una parte de cada venta de cada cliente, sin
techo, con plata nuestra. Owner.com, AgendaPro y todos los demás funcionan igual: el comercio pone
el premio.

### Por qué al negocio le conviene (ejemplo con supuestos, no con datos)

Supuestos: ticket promedio **$25.000**, premio = una hamburguesa de **$20.000** cuyo costo de
producción es ~**35 %** (≈ **$7.000**), meta de **10 sellos**.

- 10 compras = **$250.000** en ventas. El premio le cuesta **$7.000 ≈ 2,8 %** de esas ventas.
- Comparado con un **10 % de descuento a todo el mundo**, que cuesta 10 % siempre —también a quien
  habría venido igual—, el sello cuesta ~3 % y **solo a quien vuelve 10 veces**.
- Muchos clientes nunca completan la tarjeta, así que el costo real es menor.

Hay que poner este cálculo en la pantalla de configuración con los números del negocio: es lo que
convence al dueño.

---

## 2. Qué resuelve, de verdad

1. **Frecuencia.** Es el objetivo. El único dato independiente encontrado: los miembros de un
   programa visitan un 22 % más (Circana 2025, citado por terceros). Hay que medirlo nosotros (§10).
2. **Identificar al cliente de mostrador y mesa.** Hoy solo tienen ficha
   (`platform.persona_negocio`) los pedidos que traen teléfono —WhatsApp, domicilio, carta virtual—;
   el POS no manda teléfono en una mesa (`pedidoService.js`, comentario sobre la identidad). Con
   sellos, **el cliente de mostrador tiene una razón para dar su número**. Eso:
   - agranda la audiencia de promociones, que es «todo cliente con teléfono» (`promociones-masivas.md` §4),
   - y llena «Clientes» con gente que hoy es invisible.
3. **Un motivo para escribirle al negocio por WhatsApp**, que es el canal sin comisión.

> ⚠️ En la conversación original se dijo que servía para «llenar la lista de autorizados». Es falso:
> la audiencia de promociones es por defecto desde el 2026-10-12. Lo que sí hace es el punto 2.

---

## 3. La decisión central: los sellos **se calculan**, no se guardan

Hay dos maneras de llevar los sellos:

| | A. Anotar un sello en cada cobro | **B. Contarlos de los pedidos pagados** (recomendada) |
|---|---|---|
| Dónde se engancha | un gancho más en `marcarPagado` / `cerrarOrden` | ninguno: se cuentan al leer |
| Si el gancho falla | el sello se pierde sin aviso | no hay gancho que falle |
| Pedido anulado | hay que acordarse de revertir el sello | deja de contar solo |
| Arrancar con historia | imposible | posible: «ya tienes 4 sellos» el día del lanzamiento (§3.2) |
| Costo | escribir una fila por cobro | una consulta indexada por cliente |

Es el mismo criterio que ya usa el sistema dos veces: **el saldo de una tiquetera nunca se guarda,
se suma del libro**, y la **Cartera copia sus movimientos al leer**, sin gancho en
`aplicarPagoAprobado`. Y deja intacto el código de cobro, que es donde un error cuesta plata.

### 3.1 Cómo se cuenta

```
sellos_disponibles =
    compras_elegibles(persona, desde = max(inicio_programa, hoy − vigencia))
  − sellos_gastados_en_canjes_vigentes
```

- **Compra elegible**: pedido del negocio con `id_persona_negocio` de la persona, **pagado**, no
  anulado, con total ≥ `monto_minimo` del programa, en un canal que el programa cuente (§8).
  Máximo **un sello por día** por cliente (evita partir una cuenta en cinco pedidos).
- **Canje**: la única fila que sí se escribe (§4), porque es una decisión de alguien en un momento.
- **Por vertical**: la fuente de «compras» es un adaptador. Restaurante = `pedid_orden`; reserva
  (fase 3) = citas atendidas y pagadas. El resto del motor no sabe de verticales.

### 3.2 Arrancar con historia (opción al encender)

Al encender el programa, el dueño elige: **«empezar todos en cero»** o **«contar las compras de los
últimos N días»**. La segunda hace que el lanzamiento llegue con clientes que ya van por la mitad, que
es lo que más engancha. Decisión del dueño de cada negocio, no nuestra.

---

## 4. Tablas (esquema `platform`, como las promociones)

Vive en `platform` y en `app_core/fidelizacion/` —no en `restaurante`— porque sirve igual para
reserva, como ya pasó con `app_core/promociones`.

```sql
platform.fidelizacion_programa
  id_programa        SERIAL PK
  id_negocio         INTEGER NOT NULL  -- uno activo por negocio
  sellos_meta        SMALLINT NOT NULL            -- p. ej. 10
  premio_texto       VARCHAR(120) NOT NULL        -- «Una hamburguesa clásica»
  id_producto_premio INTEGER NULL                 -- si el premio es un producto fijo
  premio_valor_max   NUMERIC(12,2) NULL           -- o «cualquier plato hasta $X»
  monto_minimo       NUMERIC(12,2) NOT NULL DEFAULT 0
  vigencia_dias      INTEGER NULL                 -- NULL = los sellos no vencen
  canales            TEXT[] NOT NULL              -- MESA, LLEVAR, DOMICILIO, WHATSAPP…
  fecha_inicio       TIMESTAMP NOT NULL
  estado             CHAR(1) NOT NULL DEFAULT 'A'

platform.fidelizacion_canje
  id_canje           SERIAL PK
  id_programa        INTEGER NOT NULL
  id_negocio         INTEGER NOT NULL
  id_persona_negocio INTEGER NOT NULL
  sellos             SMALLINT NOT NULL            -- los que gastó (= sellos_meta al canjear)
  id_orden           INTEGER NULL                 -- el pedido donde se usó
  id_usuario         INTEGER NOT NULL             -- quién lo aplicó
  id_canje_anula     INTEGER NULL                 -- anulación = fila nueva, nunca UPDATE
  fecha              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
```

Interruptor: `gener_negocio.permite_fidelizacion`, **nace apagado**, mismo patrón que
`permite_cuentas_cliente` (sin él: ni menú, ni opción en el cobro, ni API → 403). Y registrarlo en
`CAMPOS_EDITABLES` de `configuracionController`, que ya se tragó dos banderas.

Cambiar la meta o el premio con el programa en marcha **cierra el programa y abre otro**: los
canjes viejos quedan atados a sus reglas y nadie pierde sellos por un cambio de configuración.

---

## 5. El canje en caja

1. En el cobro, si el cliente identificado tiene premio, aparece un aviso «🎁 Tiene un premio
   disponible» con el botón **Usar premio**.
2. El premio entra como **línea normal del pedido con descuento del 100 %** (o hasta
   `premio_valor_max`), etiquetada «Premio fidelidad».
3. En **la misma transacción** del cobro se escribe la fila de `fidelizacion_canje`. Si el pedido se
   anula, se anula el canje con una fila nueva y el premio vuelve.

### Contabilidad — que no mienta

| | ¿Es venta? | ¿Mueve el cajón? | ¿Descuenta inventario? |
|---|---|---|---|
| Línea del premio | sí, a **$0** (precio de carta − descuento «Premio fidelidad») | no | **sí** — la hamburguesa salió de la cocina |

El informe de ventas debe mostrar aparte **premios entregados (N)** y su **valor de carta**, para
que el descuento no se confunda con descuentos comerciales. ⚠️ **Facturación electrónica:**
comprobar con Factus que acepta una línea con descuento del 100 % (pregunta abierta).

---

## 6. WhatsApp: lo que ve el cliente

Regla de oro, por el cupo de mensajes (Zona Burger roza los 6.000/mes): **ningún mensaje extra por
pedido**. Los sellos viajan dentro de mensajes que ya salen o se contestan cuando el cliente pregunta.

```
Cliente:  cuántos sellos tengo?
Bot:      Llevas 7 de 10 🍔 Te faltan 3 para tu hamburguesa clásica gratis.
          Tus sellos vencen el 15 de enero.
```

```
(en el aviso de «pedido listo», que ya se envía)
Bot:      ¡Tu pedido está listo! … Con este llevas 8 de 10 sellos.
```

```
(al pedir, cuando tiene premio)
Bot:      Tienes una hamburguesa clásica gratis. ¿La usamos en este pedido?   [Sí] [Después]
```

- **Capacidad nueva de solo lectura** `consultar_sellos` (registro + Policy Gate, sin
  confirmación, como `consultar_info_negocio`).
- **Usar el premio por WhatsApp** es una mutación: pasa por la confirmación de F7 y por las guardias
  de «sí» ya existentes (`pregunta_abierta`, «un sí tras escribir el cajero no ejecuta»).
- ⚠️ **No tocar la confirmación del pedido**: hay un test que exige que diga *exactamente* lo que
  devuelve la capacidad (`promociones-masivas.md` §11.2, decisión 1). La línea de sellos va en el
  aviso de «listo» o en la respuesta a la consulta, no ahí.
- Al cliente de **mostrador** no se le manda nada por defecto: escribirle a quien no tiene la
  conversación abierta exige plantilla, cuesta y probablemente Meta la clasifica como marketing.

---

## 7. Lo que ve el negocio

- **Configuración → Tarjeta de sellos**: meta, premio, monto mínimo, vigencia, canales, «arrancar
  con historia», y la calculadora del §1 con sus propios números.
- **Clientes**: columna «Sellos» y, en la ficha, la tarjeta con sus sellos y canjes.
- **Cobro**: el campo para identificar al cliente por teléfono (reutilizando el selector de cliente
  que ya vive en `MultipagoSelectorComponent`) y el botón «Usar premio».
- **Informe**: miembros activos, premios canjeados, valor de carta regalado, y la frecuencia de
  miembros vs. no miembros (§10).

---

## 8. Trampas y abusos

| Riesgo | Mitigación |
|---|---|
| Cajero que inventa sellos | no se pueden inventar: salen de pedidos **pagados** (un pedido falso le descuadra la caja) |
| Partir una cuenta para sumar sellos | máximo un sello por día y `monto_minimo` |
| Cajero que canjea el premio de otro con su número | canje auditado con `id_usuario`; informe de canjes por cajero. Fase 2: aviso al cliente por WhatsApp si tiene ventana abierta |
| Ajustes manuales («se me olvidó ponerle el número») | permiso `fidelizacion_ajustar`, denegado por defecto, con auditoría |
| Pedido de tiquetera | **sí** cuenta (es venta, `tiqueteras-y-fiado.md`) — decisión a confirmar |
| El pedido del premio | cuenta como sello solo por la parte pagada que supere `monto_minimo` |

---

## 9. Cómo lo cobra EscalApp (decisión abierta)

Propuesta: **sellos en caja en todos los planes** (gancho de venta, casi sin costo para nosotros) y
**sellos por WhatsApp en el Plan Avanzado**, que es donde ya vive `asistente_ia`. No cobrarlo por
sello ni por canje: mismo argumento de `precios-y-planes.md` sobre la forma del costo.

---

## 10. Cómo saber si funciona

Piloto en **un** negocio, 60 días. Antes de construir, medir el punto de partida:

1. **% de pedidos con cliente identificado, por canal.** Es el requisito: sin cliente no hay sellos.
   Si en mesa es ~0 %, el éxito depende de que el cajero pida el número.
2. **Frecuencia**: pedidos por cliente al mes, miembros vs. el mismo grupo antes del programa.
3. **Premios canjeados** y **valor regalado / ventas de los miembros** (debería rondar el 3 % del §1).
4. **Nuevos clientes con teléfono** gracias al mostrador.

Candidato natural: Restaurante pregonchos (negocio 12, de prueba) para validar y Zona Burger
(negocio 6) como primer cliente real, si su dueño quiere.

---

## 11. Fases

| Fase | Qué | Necesita |
|---|---|---|
| **F0** | Programa, conteo derivado, canje en cobro, sellos en Clientes, informe. Solo restaurante | migración + `app_core/fidelizacion/` + pantallas en `restaurante_app` |
| **F1** | WhatsApp: `consultar_sellos`, línea en el aviso de «listo», ofrecer el premio al pedir | capacidad nueva + texto en el aviso |
| **F2** | Tarjeta visible por enlace en la vitrina; «te falta 1» y «tus sellos vencen» (enlaza con la idea 2 de recuperar clientes) | página pública + plantilla de marketing |
| **F3** | Reserva («el 10.º corte gratis») | adaptador de citas |

## 12. Decisiones pendientes

1. Sellos (por compra) o puntos (por plata). **Recomendado: sellos**, más fácil de entender en un
   negocio de barrio; puntos se puede añadir después con la misma tabla de canjes.
2. ¿Los sellos vencen? ¿Cuánto?
3. ¿Qué canales cuentan? ¿El domicilio de Rappi (si algún día se integra) no?
4. ¿Cuenta el pedido pagado con tiquetera?
5. ¿Se puede «arrancar con historia»? ¿Cuántos días?
6. ¿En qué plan va? (§9)
7. ¿Factus acepta la línea con descuento del 100 %?
