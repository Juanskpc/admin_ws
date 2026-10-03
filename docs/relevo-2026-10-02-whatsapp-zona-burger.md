# Relevo — WhatsApp de Zona Burger, 2026-10-02 (cierre ~20:45)

> **Para quien toma el control de los mensajes.** Todo lo de este documento está **commiteado,
> subido a GitHub, desplegado en producción y migrado** (producción y base compartida 5433). Al
> cierre, producción estaba sana: servicio activo, sin errores en el log, sin 4xx/5xx desde el
> último despliegue. Lo que falta está en «Pendiente».

---

## 1. Bajar los cambios

```bash
cd admin_ws        && git pull     # master — último: 48ac038 (+ este doc)
cd admin_app-v21   && git pull     # main   — último: 888ec77
cd restaurante_app && git pull     # master — último: be93da5
```

**Migraciones nuevas del día** (las tres ya están en producción **y** en la compartida 5433; en tu
base LOCAL 5432 hay que correrlas, o el código nuevo falla al leer `pedid_orden`):

```bash
npm run migrate:negocio-domicilio-rango        # gener_negocio.domicilio_valor_min/max/nota
npm run migrate:restaurante-para-servir        # pedid_orden.para_servir
npm run migrate:restaurante-empaque-producto   # (la de Juan David, también de hoy)
```

⚠️ `para_servir` está en el **modelo de Sequelize**: en cualquier entorno, migrar **antes** de
reiniciar el backend, o toda consulta a `PedidOrden` sin `attributes` revienta.

---

## 2. Qué se desplegó (orden cronológico)

| Commit | Repo | Qué |
|---|---|---|
| `1463f91` / `649c914` | ws / admin | **Domicilio como rango** («$7.000 a $9.000» + nota) en la Bandeja, en vez de barrio por barrio. Zona Burger: 7.000–9.000, «Fuera de Pasto, desde $10.000.» |
| `c5427a2` | ws | **`pasar_a_persona`** (herramienta del motor, no del Registry): sin el dato, handoff real en vez de «confírmalo con ZONA BURGER». **`agotados_ahora`** en `buscar_producto`. Tiempo estimado sin pedido no dice «tu pedido». Confirmación: precios no son nota, foto no repite el resumen, 2.º desvío de un PEDIDO → persona. Prompt **`sistema.v8`**. |
| `888ec77` | admin | Bandeja: `CO.1084…` (usuario de WhatsApp sin número, «BSUID») ya no sale como teléfono. |
| `da3b9e1` | ws | Scripts de auditoría de solo lectura (ver §4). |
| `21dc898` / `be93da5` | ws / restaurante | **«Para servir»** (comer en el local): MESA sin `id_mesa` → primera mesa libre, `para_servir`, nombre; marca «🍽️ Para servir · <nombre>» en **Mesas** y **Cocina**; botón «Para servir aquí» en el flujo si hay mesas. Prompt **`sistema.v9`** (sin pregunta de confirmación propia). `[revoke]` (mensaje borrado) sin turno. |
| `cac5a03` | ws | **Un número nunca es «cortesía»**: el filtro se comió los teléfonos de una clienta y el pedido no se creó. |
| `f079ccb` | ws | **«Avisar que está listo»** encuentra el chat por el número de pedido cuando el cliente no tiene teléfono (BSUID). |
| `48ac038` | ws | **Búsqueda**: pasadas 2 y 3 se juntan («salchipapa criollita» solo traía la familiar). **Preguntas de domicilio/tiempo durante la confirmación** se contestan. **Estado del pedido** sin etapa inventada + minutos/pasado del estimado. «Te paso con alguien» sin herramienta → **handoff real**. |

Respaldos de la base de producción antes de cada migración: `db_2026-10-02_1310.dump` y
`db_2026-10-02_1941.dump` en `/home/escalapp/backups/`.

---

## 3. Cómo se comporta ahora el asistente (lo que hay que saber al leer chats)

- **Cuando no sabe algo, pasa la conversación a una persona** («Eso te lo confirma alguien del
  equipo de ZONA BURGER por este mismo chat 🙌»). La conversación queda en **«Esperan respuesta»**
  de la Bandeja, con campanita y correo. **El bot no vuelve solo si nadie contesta** (ADR-023); si
  alguien contesta, vuelve tras los minutos de reactivación configurados.
- **Lo mismo pasa** si el bot escribe «te paso con alguien», si un pedido lleva más que el tiempo
  estimado (60 min) y el cliente pregunta, o si el cliente se desvía dos veces al confirmar un pedido.
- **Producto agotado** → «hoy se nos acabó», nunca «no está en la carta».
- **«Para servir»** → mesa libre asignada; si no hay libres, ofrece recoger.
- **Domicilio** → dice el rango; el valor exacto lo confirma el restaurante. **No se suma al total.**
- **Clientes sin número visible** (`CO.…`): el pedido nace sin teléfono; el aviso de «listo» los
  encuentra solo si el pedido lo tomó el asistente.

### Lo que hace Zona Burger que condiciona al bot (no es código)

- **No usa la pantalla de Cocina**: `estado_cocina` siempre nulo. Por eso el estado del pedido se
  dice por tiempo transcurrido, no por etapa.
- **Apagó el control de inventario** (el pan brioche estaba en −321 y escondía la Discordia).
- **El domicilio se le paga al domiciliario**: los ~2.060 pedidos a domicilio tienen
  `valor_domicilio = 0`. No hay historial de precios por zona en la base.
- **El personal contesta desde el celular** (coexistencia) y **crea pedidos a mano** en la caja
  muchas veces sin teléfono; esos pedidos no quedan ligados al chat.
- **Nequi cargado** en «Info para el asistente»: 3236388196.

---

## 4. Cómo auditar (solo lectura, en el VPS)

Los scripts ya están en `/var/www/admin_ws/scripts/` (vienen con el `git pull`). **Nunca `psql`
con la clave**: siempre estos scripts con `node`.

```bash
ssh escalapp@45.63.105.95
cd /var/www/admin_ws
node scripts/auditoria_banderas.js 6 "2026-10-02 20:30"        # resumen + banderas por chat
node scripts/auditoria_transcripciones.js 6 "2026-10-02 20:30" # cada chat completo, con decisiones
node scripts/auditoria_conversacion.js 6 <dígitos del id_externo>  # un chat, a fondo
node scripts/auditoria_domicilio_zona_burger.js 6               # todo lo de domicilio
```

Banderas: `PEDIDO_PERDIDO`, `PROMESA_FALSA`, `NO_ENCONTRADO`, `CONFIRMA_CON`, `SIN_RESPUESTA`. Qué
mirar en las transcripciones: `modelo_pide_persona`, `promesa_de_persona_cumplida`,
`confirmacion_a_persona` (handoffs: ¿alguien contestó?), `cortesia_sin_respuesta` sobre un mensaje
con contenido (ya no debería pasar), y pedidos `por Asistente` vs `por OSCAR/ADRIANA`.

---

## 5. Pendiente (decidido dejarlo para después)

1. **Comprobantes de pago** (fotos): el bot no las ve; hoy un comprobante no avisa a nadie.
2. **Domicilio por comuna**: investigado y viable. Barrios de Pasto en OpenStreetMap (~360, con
   ubicación) + los 12 polígonos de comunas (servicio UNOSAT, capa 2) → cada barrio cae en su
   comuna automáticamente; el 60 % de las direcciones reales se reconocen con un emparejador
   simple. Precios reales conocidos: Alameda (c. 11) $8.000, Palermo (c. 9) $8.000, El Pilar
   (c. 5) $7.000. Falta preguntarle a Zona Burger su tabla y quién cobra (restaurante o domiciliario).
   Detalle de la investigación: el chat de la sesión; atribución obligatoria «© OpenStreetMap contributors».
3. **Ligar pedido ↔ conversación con una columna** (hoy el aviso de «listo» lo infiere del texto
   del bot; los pedidos creados a mano sin teléfono no tienen chat).
4. **Mensaje de la carta sin el código `#P…`**: el de Alejandra llegó sin código y lo atendió el
   modelo en vez del flujo. Sin investigar (¿lo borró al pegar?).

## 6. Tests que ya fallaban (no son de estos cambios)

Con `DB_PORT=5432`: `e2e_agendar`, `reinicio_por_inactividad`, `reportes`,
`whatsapp_embedded_signup` (falta columna `pin_cifrado` en local), `platform/capacidades_restaurante`
(un texto de `agregar_items_pedido`) y `restaurante/auditoria_actor_restaurante` (cierre de caja).
`canal` y `ventana` fallan a veces en la suite completa y pasan solos. Se comprobó con `git stash`
que fallan igual sin los cambios del día.
