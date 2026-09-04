# Cómo eliminar tus datos

**VIGENTE desde el 3 de septiembre de 2026.** Versión 1.0 · Publicado sin revisión de abogado -
ver la advertencia del [README](README.md).

*Publicado en `escalapp.cloud/admin/eliminacion-datos`. El contenido que ve el público vive en
`admin_app-v21/src/app/legal/legal-content.ts` (`ELIMINACION`); este markdown es la copia de
trabajo y hay que mantener los dos en sintonía.*

> ## Por qué existe este documento aparte
>
> **Meta lo exige.** Para publicar una app hay que dar una *URL de instrucciones de eliminación de
> datos*, y es un campo **distinto** del de la política de privacidad: el revisor la abre y busca
> instrucciones concretas, no una cláusula enterrada dentro de otro documento.
>
> Pero no se escribió para pasar una revisión. La política ya reconocía el derecho de supresión
> (§5) y decía por dónde ejercerlo (§6). Lo que faltaba era la respuesta a la pregunta que de
> verdad se hace quien llega hasta aquí: **a quién se lo tengo que pedir.** Y en EscalApp esa
> respuesta depende de quién pregunta, porque de un lado somos Responsables y del otro Encargados.

---

## 1. Primero: a quién se lo tienes que pedir

EscalApp trata datos personales en **dos papeles distintos**, y de eso depende quién puede
borrarlos.

| Si tú eres… | Quién decide sobre tus datos | A quién escribes |
|---|---|---|
| Un **negocio** que contrató EscalApp, o alguien de su equipo con cuenta en la plataforma | **EscalApp** — somos Responsables | A nosotros, como dice el punto 3 |
| Un **cliente de un negocio**: escribiste al asistente de WhatsApp, hiciste un pedido, reservaste una cita o te atendieron en el mostrador | **El negocio que te atendió** — nosotros solo somos Encargados: guardamos sus datos por instrucción suya | Al negocio. Si nos escribes a nosotros, trasladamos tu solicitud y te avisamos |

No es un tecnicismo para pasar la pelota: es el reparto de papeles que exige la **Ley 1581 de
2012**. El negocio decidió qué datos recoger y para qué, así que no podemos borrar por nuestra
cuenta la información de sus clientes sin su instrucción.

**Aun así, escríbenos si no sabes a quién acudir.** Trasladamos la solicitud al negocio
responsable, le damos tu contacto y te confirmamos que lo hicimos.

## 2. Si solo quieres dejar de recibir mensajes

Eso es inmediato y no hace falta escribirle a nadie. **Responde `STOP`** a cualquier mensaje del
asistente de WhatsApp. También valen `BAJA`, `NO MÁS MENSAJES`, `CANCELAR SUSCRIPCIÓN` y
`UNSUBSCRIBE`.

El asistente **se calla en el acto y no vuelve a escribirte**, ni siquiera para confirmarte la
baja. El silencio es la confirmación: es exactamente lo que pediste.

Dos cosas que conviene saber, y se dicen antes y no después:

- **Darse de baja no es borrar.** Dejas de recibir mensajes, pero la conversación anterior sigue
  guardada. Si además quieres que se elimine, hay que pedirlo como dice el punto 3.
- **La baja no se deshace escribiendo otra vez.** Está hecha así a propósito, porque es una
  obligación legal y falla del lado seguro. Si te diste de baja por error, tiene que reactivarte
  una persona del negocio.

<!-- Los dos puntos de arriba describen `intelligence/engine/optout.js` tal como está construido,
     no una intención: el estado pasa a `bloqueada`, ESTADOS_PROCESABLES no lo incluye y
     asegurarConversacion() no reactiva. Si algún día se añade una vía de reactivación por el
     propio canal, este párrafo miente y hay que cambiarlo. -->

## 3. Cómo pedir la eliminación

Escribe a **nicolasppaez00@gmail.com** con el asunto **«Eliminación de datos»** e incluye:

- Tu **nombre completo** y tu número de documento.
- El **dato con el que te identificamos**: el número de WhatsApp desde el que escribiste, o el
  correo con el que inicias sesión.
- El **nombre del negocio** con el que tuviste contacto, si lo recuerdas. Nos ahorra buscarte en el
  sitio equivocado.
- Qué quieres exactamente: **eliminar todo**, o solo un dato concreto.

Te pedimos el documento para no borrarle los datos a otra persona: una solicitud de supresión que
se atiende sin verificar quién la hace es, en la práctica, una forma de borrarle la información a
cualquiera.

**No hace falta tener cuenta, ni pagar nada.** El acceso y la supresión son gratuitos por ley.

## 4. En cuánto tiempo respondemos

Son los plazos de los artículos 14 y 15 de la Ley 1581, contados desde que recibimos la solicitud
completa:

| Tipo | Plazo | Prórroga |
|---|---|---|
| **Consultas** — qué datos míos tienes | 10 días hábiles | +5 días hábiles |
| **Reclamos** — corregir, actualizar o suprimir | 15 días hábiles | +8 días hábiles |

Si la solicitud llega incompleta te lo diremos dentro de los cinco (5) días siguientes. Si no se
completa en dos meses, se entiende desistida y hay que empezar de nuevo.

Cuando el responsable es el negocio y no nosotros (punto 1), el plazo lo cuenta él; lo nuestro es
trasladar la solicitud sin demora y confirmártelo.

## 5. Qué se elimina y qué no

**Se elimina:** tus datos de contacto, tu perfil y tus preferencias, el historial de conversaciones
con el asistente, y los datos de tu actividad que no estén sujetos a un deber legal de
conservación.

**No se puede eliminar, y no es una excusa nuestra:**

- **Facturas y documentos con efectos fiscales**, con sus soportes. El artículo 632 del Estatuto
  Tributario obliga a conservarlos **cinco (5) años**. Si tus datos están en una factura ya
  emitida, esa factura se queda — pero **dejamos de usar esos datos para cualquier otra cosa**:
  nada de comunicaciones, mercadeo ni conversaciones futuras.
- **Registros de auditoría** mínimos, que son justamente la prueba de que atendimos tu solicitud.
- Lo que debamos conservar por una **orden judicial o administrativa**.

Los **respaldos** se sobrescriben en su ciclo normal: un dato borrado puede seguir existiendo unos
días en una copia de seguridad, sin usarse para nada, hasta que esa copia se reemplaza.

## 6. Si llegaste desde WhatsApp o Facebook

EscalApp usa la **Plataforma de WhatsApp Business** de Meta para enviar y recibir los mensajes del
asistente, así que los mensajes pasan también por los sistemas de Meta, donde **Meta responde de su
propio tratamiento**.

Esta página cubre los datos que tratamos **nosotros**. Para eliminar lo que tenga Meta —tu cuenta
de WhatsApp, tu cuenta de Facebook o los datos asociados a ellas— hay que pedírselo a Meta desde la
configuración de tu cuenta: nosotros no tenemos acceso a eso ni podemos borrarlo por ti.

## 7. Si no te respondemos

Puedes presentar una queja ante la **Superintendencia de Industria y Comercio (SIC)**, que es la
autoridad de protección de datos en Colombia. La ley pide haber agotado antes la consulta o el
reclamo ante nosotros, que es de lo que trata esta página.

Los demás derechos que tienes como titular —conocer, actualizar, rectificar, pedir prueba de la
autorización y revocarla— están en la
[Política de Tratamiento de Datos Personales](politica-tratamiento-datos.md), §5.

**NICOLÁS PANTOJA PÁEZ** (ESCALAPP) · NIT 1193035399-6 · CR 3 E 19 A 49, Barrio Betania, Pasto,
Nariño, Colombia · nicolasppaez00@gmail.com

---

## Nota para el abogado

Dos puntos que conviene mirar con calma:

1. **El reparto Responsable/Encargado del punto 1.** Es la decisión de fondo de todo el documento
   y viene del [anexo de encargado](anexo-encargado-tratamiento.md). Si esa calificación fuera
   discutible en algún supuesto —por ejemplo, los datos que EscalApp usa para su propia operación
   sobre conversaciones de clientes finales— cambiaría quién tiene que atender la supresión.
2. **La conservación fiscal de cinco años frente al derecho de supresión.** Aquí se resuelve
   diciendo que prevalece el deber legal pero cesa toda otra finalidad. Es la lectura del artículo
   9 del Decreto 1377 de 2013 y del 632 del Estatuto Tributario, y conviene confirmarla.
