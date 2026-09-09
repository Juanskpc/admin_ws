# Solicitudes de autoridades públicas: qué hacemos cuando llega una

**Estado: VIGENTE desde el 2026-09-10.** · Política interna, no publicada en el sitio.
**No la redactó un abogado** — vale lo mismo que advierte el [README](README.md) de esta carpeta.

---

## Por qué existe, y por qué hoy y no antes

Porque la declaramos. El **App Review de Meta** pregunta —en el paso «Gestión de datos»— qué
políticas tienes ante solicitudes de información de autoridades públicas, y el 2026-09-10 se
marcaron tres casillas:

- Revisión obligatoria de la legalidad de estas solicitudes.
- Política de minimización de datos.
- Documentación de estas solicitudes.

**Declarar una práctica que no existe es peor que no declararla.** Este documento las convierte en
algo que existe. No es burocracia de empresa grande: son tres reglas que caben en una página y que
una operación de dos personas puede cumplir de verdad.

Y hay un motivo que no viene de Meta: EscalApp es **Encargado** de los datos de los clientes de sus
clientes ([Política de Tratamiento](politica-tratamiento-datos.md) §2). Entregar una conversación de
WhatsApp de un comensal es entregar datos **de los que el Responsable es el restaurante**, no
nosotros. Eso obliga a mirar dos veces, no una.

---

## 1. Quién la recibe y qué hace en la primera hora

Toda solicitud —oficio, correo, citación, llamada— se dirige a
**`nicolasppaez00@gmail.com`**, que es el contacto publicado. Quien la reciba por otra vía la
reenvía ahí sin contestar nada.

**No se entrega nada en el momento.** Ni por teléfono, ni «para agilizar». Una solicitud legítima
tolera un día; una ilegítima cuenta con que nadie lo pida por escrito.

## 2. Revisión de legalidad — antes de mirar un solo dato

Antes de tocar la base de datos se comprueba, y se deja escrito, que la solicitud:

1. **Viene de una autoridad competente** y verificable — se contrasta el remitente por un canal
   independiente (el conmutador o el correo institucional de la entidad, nunca el teléfono que
   aparece en el propio oficio).
2. **Está por escrito, firmada, con número de radicado y fecha.**
3. **Cita la norma** que la faculta y el proceso al que pertenece.
4. **Identifica qué datos pide y de quién.** Una petición de «todos los datos» sin titular
   determinado no se responde: se contesta pidiendo que la acoten.
5. Si pide **contenido de comunicaciones**, exige **orden judicial**. La interceptación y el acceso
   a comunicaciones privadas están reservados a la autoridad judicial (art. 15 de la Constitución).
   Un oficio administrativo no alcanza.

Si algo de esto falta, **la respuesta es una solicitud de aclaración**, no los datos. Si la
solicitud parece ilegal y se mantiene tras la aclaración, se impugna por los medios que la ley
prevea antes de entregar nada.

## 3. Minimización — se entrega lo pedido, ni un campo más

- Se responde **solo por los titulares nombrados** y **solo por los campos citados**.
- **Un volcado de tabla nunca es una respuesta.** Se extrae la consulta concreta y se revisa a
  ojo antes de enviarla.
- Si de una consulta salen datos de terceros que van de paso —otros participantes de una
  conversación, otros pedidos del mismo día—, **se recortan**.
- El **contenido de conversaciones** se entrega únicamente si la orden lo pide expresamente; si
  basta con metadatos (que hubo un mensaje, cuándo), se entregan los metadatos.
- Cuando el dato pedido pertenece a un negocio cliente, **se le avisa** para que ejerza su papel de
  Responsable, salvo que la propia orden prohíba avisar.

## 4. Documentación — el registro que hace verificable todo lo anterior

Cada solicitud deja una carpeta en el almacenamiento del titular, nombrada
`AAAA-MM-DD-<entidad>-<radicado>`, con:

| Qué | Detalle |
|---|---|
| El documento original | tal como llegó, sin editar |
| La verificación | por qué canal se confirmó el remitente, y con quién se habló |
| El análisis de legalidad | los cinco puntos de §2, respondidos uno a uno |
| Qué se entregó | la consulta exacta ejecutada y el archivo enviado |
| Qué **no** se entregó y por qué | la parte que importa el día que alguien pregunte |
| Fechas | recepción, respuesta y, si la hubo, aclaración o impugnación |
| Aviso al titular y al negocio | o el motivo legal por el que no se avisó |

**Se conserva aunque la respuesta haya sido «no».** Una negativa sin expediente no se distingue de
no haber contestado.

## 5. Transparencia con quien es dueño de sus datos

Al titular afectado y al negocio Responsable se les informa de la solicitud **salvo prohibición
legal expresa**. Cuando la prohibición sea temporal, se avisa en cuanto caduque.

---

## Lo que este documento NO es

- **No es un compromiso de resistir cualquier orden.** Una orden judicial válida y acotada se
  cumple; lo que se revisa es que sea válida y esté acotada.
- **No sustituye a un abogado.** La primera solicitud real que llegue con contenido de
  comunicaciones de por medio se consulta con uno antes de responder.

## Fuentes

- Constitución Política de Colombia, art. 15 (inviolabilidad de la correspondencia).
- Ley 1581 de 2012, arts. 8, 10 y 17 (deberes del Responsable y del Encargado).
- [Términos de la Plataforma de Meta](https://developers.facebook.com/terms/), §3 y §5.
