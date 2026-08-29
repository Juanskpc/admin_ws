# La Bandeja — donde el negocio contesta cuando el asistente no sabe

**Construida el 2026-08-29 y desplegada el mismo día.** Backend en
`app_admin_api/controllers/intelligenceBandejaController.js`, pantalla en `admin_app-v21` bajo
`/admin/bandeja`.

---

## Por qué existe: el handoff estaba a medias y no se veía

Desde F7 el asistente sabía escalar bien. Reconoce que no sabe, dice honestamente cuándo habrá
alguien —del horario del negocio si está configurado— y **se calla**, porque un bot hablando encima
de una persona es peor que un bot mudo.

Lo que faltaba era el otro lado de esa promesa. **El negocio no tenía dónde contestar.**

Y no por descuido: el número está conectado a la Cloud API, así que **deja de funcionar en la app de
WhatsApp del móvil**. El dueño no puede coger el teléfono. El cliente final recibía una promesa
honesta —«le respondemos por la mañana»— y después silencio, que es exactamente lo que el handoff se
escribió para evitar.

Hasta ese día la única superficie que enseñaba conversaciones era la **Consola de F5-E**, y es de
super admin y de solo lectura. Su propia cabecera lo dejó anotado: *«un panel por inquilino es otra
conversación»*. Esta es esa conversación.

---

## Las decisiones que gobiernan el diseño

### 1. El `id_negocio` de la petición no se cree nunca

La Consola acepta el `id_negocio` que le manden porque quien la usa ya lo ve todo. En cuanto la
misma pantalla se abre a un inquilino, **ese parámetro pasa a ser la frontera entre dos clientes**.

Se cruza contra `alcanceDeNegocios()` (en `app_core/middleware/auth.js`), y en el detalle se
comprueba contra el negocio **de la fila**, no contra el de la URL. F2 ya cerró una fuga real por
aquí, y el patrón que la causó es el que esta superficie vuelve a tener a mano.

**Una conversación ajena contesta 404, no 403.** Un 403 confirmaría que ese UUID existe, y entre
inquilinos eso ya es filtrar información por la puerta de atrás.

### 2. No se importa `intelligence/`, ni para enviar

Mismo patrón que la Consola y la Ficha 360: se lee y se escribe el esquema con SQL. Así sigue en pie
el test del apagón de [ADR-005](adr/ADR-005-fase-cero.md) — se borra el directorio `intelligence/` y
el backend arranca igual.

Lo interesante es cómo sale un mensaje sin importar el canal: **no se llama a la Cloud API desde
aquí**. Se inserta la fila saliente en `estado_entrega = 'pendiente'` y el Channel Gateway, que ya
recorre esa tabla cada segundo, la entrega con sus reintentos y su backoff. Es la entrega asíncrona
de [ADR-016](adr/ADR-016-entrega-asincrona.md) usada tal cual, y tiene una propiedad que un `fetch`
directo no tendría: **si Intelligence está apagado, el mensaje espera en vez de perderse**.

### 3. Fuera de la ventana de 24 h se rechaza aquí, no al entregar

La Cloud API rechazaría el envío igualmente, pero varias capas más abajo y de forma asíncrona: el
usuario habría visto su mensaje aceptado y nunca sabría que no llegó. Un **409 con el instante en
que expiró** es la única respuesta honesta.

En la pantalla, el aviso **ocupa el lugar del cuadro de escribir**. Enterarse de que no se puede
responder *después* de redactar un párrafo es la peor forma de descubrirlo.

### 4. El cerrojo del número

Hasta F8-C el canal tenía un solo número global, y responderle al cliente del negocio B lo habría
mandado **por el número del negocio A**. La bandeja no podía arreglar eso, pero sí **negarse a
causarlo**: `409 NUMERO_DE_OTRO_NEGOCIO`.

Con F8-C hecho, el cerrojo sigue puesto y ahora casi nunca salta: solo cuando un negocio no tiene
número propio.

---

## «Atendida» y «el bot no vuelve» son dos cosas distintas

Aquí hubo un fallo que se vio **el mismo día, usándola en producción**, y que enseña algo:

«Espera respuesta» se marcaba con `estado = 'handoff_humano'`. Y **responder es justo lo que pone
ese estado**, porque el bot tiene que callarse. Así que contestar dejaba la conversación marcada
como pendiente **para siempre**: la lista de lo que espera solo podía crecer, y la acción de
atenderla era la que la dejaba marcada.

La tentación era añadir `atendida` al CHECK de `estado`. **Se descartó**, y el motivo importa:
`handoff_humano` significa «el bot no habla aquí» y el motor lo trata como pasivo desde F5-B. Un
estado nuevo obligaría a enseñarle al motor que ése también es pasivo, y el día que a alguien se le
olvide, el asistente vuelve a hablar encima de una persona — el peor fallo que este módulo puede
tener.

Son **dos preguntas distintas** y por eso son **dos columnas**:

| Columna | Pregunta | Quién la decide |
|---|---|---|
| `estado` | ¿puede hablar el bot? | el motor |
| `atendida_en` | ¿le queda algo por hacer a una persona? | la persona |

`atendida_en` **se rearma sola**: si el cliente vuelve a escribir, la ingesta la pone a `NULL` y la
conversación reaparece. Sin eso, atenderla una vez la escondería para siempre y el siguiente mensaje
de esa persona no lo vería nadie — el fallo silencioso de cualquier bandeja.

---

## Devolverle la conversación al asistente (ADR-023, Enmienda 1)

El otro lado del handoff: una conversación escalada se quedaba **del humano para siempre**. El
cliente vuelve tres días después a preguntar otra cosa —una que el asistente sabe hacer— y no le
contesta nadie.

[ADR-023](adr/ADR-023-guardarrailes.md) decía «el bot no vuelve». La **Enmienda 1** acota qué
prohibía esa frase: **no que el bot vuelva nunca, sino que vuelva solo.** La promesa era «le
responde una persona», y se cumple en cuanto una persona responde.

Las tres condiciones que hacen que no sea revocar el ADR:

1. **Nace de un clic, nunca de un temporizador.** Sin caducidad. Si nadie pulsa, sigue siendo del
   humano.
2. **El asistente hereda el contexto sabiendo que era de otro.** Los mensajes escritos a mano se
   guardan con `crudo.origen = 'humano'` y `historialReciente()` se los da marcados.
3. **Si vuelve a no saber, vuelve a escalar.** No se desactiva nada del handoff.

> ### ⚠️ La condición 2 no es cosmética, y casi se escapa
>
> `historialReciente()` mapea todo saliente a `rol: 'asistente'`. Sin marcar, el modelo lee lo que
> escribió una persona **como si lo hubiera dicho él**: le devuelves la conversación, lee «te lo
> dejo en 30 mil» en su propia voz, y sostiene un descuento que nunca hizo.
>
> Eso es **el hueco 1 de ADR-023 —promesas no respaldadas— entrando por la puerta de atrás**, y el
> guardarraíl de promesas no lo cazaría, porque solo mira lo que se genera en el turno.
>
> Se marca con un prefijo en el texto y **no con un rol nuevo**: un rol obligaría a tocar
> `puerto.ROLES_VALIDOS` y los dos adaptadores del modelo por un solo caso.

Hay una prueba dedicada a que **marcar como atendida siga sin devolver la conversación al bot**. Si
algún día eso cambiara, «el bot no vuelve» dejaría de significar nada.

---

## Por qué se refresca sondeando y no con un canal de eventos

Se miró SSE y se descartó **por dos medidas, no por gusto**:

- El proxy lleva `encode gzip zstd` sobre la API: una respuesta en streaming saldría
  **bufferizada**, así que «en vivo» exigiría tocar el `Caddyfile`.
- El servidor es **1 vCPU con 955 MB**. Una conexión abierta por pestaña de admin cuesta más que
  una petición cada cinco segundos.

Cinco segundos, para dos o tres personas mirando, es indistinguible de un push. Y el Channel Gateway
ya sondea la base cada segundo, así que esto no cambia la naturaleza de nada. **Con cien negocios
conectados, esta decisión se vuelve a mirar.**

La mitad del trabajo fue lo que el refresco **no** puede hacer: pisar lo que estás escribiendo,
moverte el scroll mientras lees algo de más arriba, parpadear, o seguir consumiendo servidor con la
pestaña en segundo plano. Y una carrera que habría aparecido sola: si cierras la conversación
mientras su petición vuelve, la respuesta se descarta en vez de reabrírtela.

---

## Cómo probarla sin esperar a que escriba un cliente

La bandeja solo deja escribir dentro de la ventana de 24 h. En una base de desarrollo, donde las
conversaciones son de hace días, **el cuadro de texto no aparece nunca** y la pantalla parece rota
cuando está haciendo lo correcto. Pasó, y por eso existe:

```bash
node scripts/bandeja_conversacion_prueba.js <id_negocio> "Nombre"
```

Deja una conversación con un entrante de hace un minuto. **Imprime contra qué base va a escribir
antes de hacerlo**, porque `DB_PORT=5433` es la compartida del VPS y ahí trabaja la otra persona.

---

## Dos cosas de CSS que costaron más de lo que parecen

Se anotan porque van a repetirse en la siguiente pantalla con paneles:

- **No scrolleaba ninguna de las dos columnas.** A los paneles les faltaba `min-height: 0`. Un item
  de grid (y uno de flex) vale por defecto `min-height: auto`, o sea «tan alto como su contenido»:
  el panel crece, la altura del contenedor deja de acotar nada, y el `overflow-y` de dentro no llega
  a activarse nunca.
- **Solo se veían dos pastillas de negocio.** La fila tenía `overflow-x: auto` con la barra
  escondida a propósito: las que no cabían quedaban invisibles **y** sin forma de llegar a ellas.

Y una de producto: **el botón flotante de WhatsApp del admin se sentaba encima del botón de
enviar**. Ahora solo sale en el inicio, y por **lista blanca**: la siguiente pantalla con algo en esa
esquina no tiene por qué acordarse de ese archivo.

---

## Lo que falta

**El aviso.** La bandeja existe y se actualiza sola, pero **nadie te avisa cuando algo se escala**:
hay que entrar a mirar. La infraestructura está —el outbox de F1—; es enganchar el evento y decidir
por dónde avisa: correo, o una campanita en el admin.
