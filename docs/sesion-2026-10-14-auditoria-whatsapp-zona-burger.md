# Sesión 2026-10-14 (noche) — Zona Burger: auditoría del 10-10 al 10-14 y pedidos de clientes sin número

**Estado:** desplegado en producción (2026-10-14 23:14) · **Ventana auditada:** 2026-10-10 23:57 →
2026-10-14 22:53 · **Documento anterior:**
[`sesion-2026-10-10-menos-mensajes-zona-burger.md`](sesion-2026-10-10-menos-mensajes-zona-burger.md)

> La auditoría es de solo lectura (`scripts/auditoria_banderas.js`, `auditoria_transcripciones.js`
> y un script de cifras temporal, ver §5). No se tocó ninguna conversación de clientes.

---

## 1. Cifras de la ventana

| | |
|---|---|
| Conversaciones | 150 |
| Pedidos tomados por WhatsApp | **111** (10-11: 31 · 10-12: 39 · 10-13: 24 · 10-14: 17) ≈ la mitad de los del negocio |
| Turnos con error | **0** · 1 envío fallido de ~3.000 desde el 10-05 |
| Latencia con modelo | p50 ~2,9 s · p90 ~4,5 s |
| IA (Ledger) | ~US$0,05/día, < US$0,002 por pedido |
| **Mensajes facturables por pedido** | **8,3 → 6,9** (−17 %; 10-05→10-10 contra 10-11→10-14). Los recortes del 10-10 funcionaron; la meta de 4–5 sigue lejos |
| `ENTREGA_SIN_DECIR` | 26 veces, a propósito; ningún pedido con la entrega equivocada |

**Cupo:** 2.873 de 6.000 al día 14 (48 %). A ~195/día el mes cierra en **~6.150**: el freno entraría
hacia el **30 de octubre**. Mejor que la proyección del 10-10 (~6.300), pero sigue al límite.

Los 42 `SIN_RESPUESTA` de `auditoria_banderas.js` son casi todos «gracias», «ok» y stickers, que el
bot calla **a propósito** desde el 10-10. Para leer la bandera hay que filtrarlos primero.

## 2. Lo que se arregló (desplegado)

### 2.1 «No Veci» es un no — `c78330d`

Producción, 10-12: ante el resumen de un pedido, «No Veci» se anotó como **nota de cocina**
(«Anotado ✍️ … _Nota: … No Veci_») y se repreguntó. Al «Si Veci» se le enseñó el 10-01; al no, no.

`esNegacion()` en `intelligence/engine/texto.js` es el espejo de `esAfirmacion`: «no» y luego solo
cortesías (`CORTESIA`). La usan `confirmacion.resolver` (rechaza) y `lineasParaAnotar` (no lo anota).
«No, sin cebolla» sigue yendo a la nota. Test: `__tests__/intelligence/confirmacion_no_veci.test.js`.

### 2.2 El cliente sin número visible ve su propio pedido — `8805342`

**El caso:** el **18 % de los chats** (27 de 150) llega sin teléfono (`id_externo` `CO.…`). Esos
clientes pedían y, a la hora, «¿cómo va mi orden ORD-8196?» recibía *«No puedo comprobar que ese
pedido sea tuyo. Llama al restaurante»* — mientras le escribían al restaurante. 6 veces en la
ventana (5 consultas y 1 cancelación). La pertenencia (`PEDIDO_NO_ES_DE_QUIEN_PIDE`) solo comparaba
`principal.telefono_verificado` con `pedid_orden.contacto_telefono`.

**El arreglo:** `esDeQuienPide(orden, contexto)` en `intelligence/adapters/restaurante/index.js`,
usada por `consultar_estado_pedido`, `cancelar_pedido` y `agregar_items_pedido`. Un pedido es de
quien pregunta si **coincide el teléfono** o si **se tomó en ese mismo chat**.

- **La prueba del chat es estricta a propósito:** el mensaje «El número es ORD-…» **del mismo turno**
  en que `tomar_pedido` quedó `ok` y no `dry_run` (JOIN `mensaje` ↔ `invocacion_capacidad` por
  `id_turno`, últimos 7 días). No vale cualquier mensaje del bot con el número: el modelo puede
  repetir uno que el cliente se inventó («no encuentro el ORD-5000»), y con eso se abriría el pedido
  de otro. Por eso **no** se reutilizó `avisoPedido.conversacionDondeSeDioElPedido`, que sí acepta
  cualquier mensaje del bot (para avisar sirve, para autorizar no).
- **El chat lo pone la plataforma, nunca el modelo:** `policyGate.ejecutar` acepta
  `idConversacion` y lo pasa en `contexto`; lo envían `manejadorLlm` (las dos llamadas) y
  `confirmacion.resolver`.
- Falla cerrada: sin chat, sin número de orden o si la consulta falla → no es suyo.
- Verificado en producción, de solo lectura y dentro de una transacción deshecha: ORD-8196 responde
  desde su chat y da `PEDIDO_NO_ES_DE_QUIEN_PIDE` desde otro.

### 2.3 Si aun así no se puede comprobar, lo atiende una persona — `8805342`

Idea del dueño. Cuando una capacidad devuelve `PEDIDO_NO_ES_DE_QUIEN_PIDE` (pidió por teléfono,
desde otro chat, en el local…), `manejadorLlm` **corta el turno y pasa a una persona**
(`handoff.decisionAPersona`, paso `pedido_sin_comprobar`) sin otra vuelta del modelo. La lista es
`A_PERSONA_SI_DENIEGA`. Cuesta el mismo mensaje que antes y el cliente queda atendido.

⚠️ Como todo handoff (ADR-023), el bot se calla en ese chat hasta que alguien lo devuelva desde la
Bandeja.

Tests: `__tests__/intelligence/pedido_del_mismo_chat.test.js` (5) y dos casos nuevos en
`modelo.test.js`.

## 3. Lo que se vio y NO se tocó

1. **El cajero escribe en medio de un pedido y el modelo se enreda** (10-13 22:46). Tras «no
   tenemos… sí tenemos costilla» del cajero, el resumen **perdió la Criollita grande** y puso una
   costilla personal de $15.000 en vez del adicional de $5.000. El cajero lo rescató a mano. Es un
   error del modelo, sin arreglo determinista evidente: vigilar si se repite.
2. **Clientes sin respuesta mientras atendía una persona** (~5): «¿cuánto sería con domicilio?»
   después de «le voy a comandar manualmente», una queja por las papas sin pelar, «me regala
   salsas». El bot hizo bien en callar. **No es código.**
3. **Bienvenida + carta repetida** a 9 clientes que ya habían pedido y volvieron a saludar. Es parte
   del pendiente de la bienvenida (12 % de los mensajes, §6.1 del 10-10).
4. Un mensaje de publicidad (operador móvil) acabó en handoff. Un pedido quedó a nombre de
   «Nombre<nombre real>»: probablemente así está el perfil de WhatsApp, **sin comprobar**.

## 4. Pendientes

- **El cupo** (§1): sigue rozando el techo. Lo que queda por recortar es el resumen de confirmación
  y la bienvenida, como dice el 10-10 §6.1.
- **Auditar las próximas noches** para ver cuántos `pedido_sin_comprobar` salen ahora y si el
  cajero los atiende.
- Sigue todo lo de §6 del 10-10 (caja sin abrir en horario, Ledger por debajo de la factura, motivo
  de envío fallido, `gpt-4o-mini`).
- **Pruebas en la base local:** 33 casos de 7 archivos (`aviso_escalado`, `e2e_agendar`,
  `features_plan`, `reinicio_por_inactividad`, `reportes`, `tarea_caducada`,
  `whatsapp_embedded_signup`) fallan **también sin estos cambios**. Es la base local desactualizada
  (faltan migraciones), no regresión. La contraseña local es `escalapp_dev_2026`: hay que pasarla
  con `DB_PASS`, porque el `.env` trae la de la compartida.

## 5. Cómo se hizo (para repetirla)

```bash
ssh escalapp@45.63.105.95
cd /var/www/admin_ws
node scripts/auditoria_banderas.js 6 "2026-10-10 23:57"
node scripts/auditoria_transcripciones.js 6 "2026-10-10 23:57"
```

Las cifras por día (mensajes, facturables, pedidos `tomar_pedido ok`, turnos, costo y cupo con
`cuota.consumoDelMes`) salieron de un script temporal que se copió al VPS, se ejecutó y se borró.
Si se repite seguido, vale la pena dejarlo como `scripts/auditoria_cifras.js`.

## 6. Cómo deshacer

Sin migraciones ni frontend. `git checkout c78330d~1` (todo) o `8805342~1` (solo §2.2–2.3) en
`/var/www/admin_ws` y `sudo systemctl restart escalapp-api`. Solo el respaldo de §2.3: vaciar
`A_PERSONA_SI_DENIEGA`.
