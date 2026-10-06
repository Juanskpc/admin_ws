# Sesión 2026-10-05 — Zona Burger: auditoría en vivo de la primera noche con `gpt-5.6-luna`

**Estado al cerrar (2026-10-05 ~20:00):** todo lo de este documento está **en producción**.
El código es `admin_ws` `8139d79` (`master`); el commit siguiente solo añade esta documentación. No hubo cambios en los frontends
ni migraciones. Documento anterior:
[`sesion-2026-10-04-zona-burger-costo-carta-diagnostico.md`](sesion-2026-10-04-zona-burger-costo-carta-diagnostico.md).

> Se auditó **mientras el local atendía** (17:00–20:00), con los scripts de solo lectura
> (`auditoria_banderas.js`, `auditoria_transcripciones.js`) y arreglando lo puntual sobre la marcha.
> Cinco despliegues en tres horas; cada uno con sus pruebas y, si tocaba al modelo, con el arnés.

## 1. Lo que cambió

| Qué pasaba (caso real) | Qué hace ahora | Dónde | Commit |
|---|---|---|---|
| El modelo pedía confirmar **«para recoger» sin que nadie lo dijera**. Un domicilio quedó tomado para recoger | `tomar_pedido` con `LLEVAR` (o `MESA` sin mesa) vuelve al modelo con `ENTREGA_SIN_DECIR` si en el chat nadie habló de eso; el modelo pregunta | `confirmacion.falta` en `adapters/restaurante/index.js`; lo aplica `manejadorLlm.ejecutarSolicitud` antes del ensayo en seco | `57df5c8`, `13d1cdc` |
| «¿Hacen domicilio?» con un pedido para recoger esperando el sí → el bot pedía la dirección **y a la vez** «¿lo confirmo?» | Hablar de domicilio **suelta** esa confirmación; el modelo rehace el pedido (lleva los argumentos en una nota) | `entregaQueCambia` en `flujo.js`; `soltarTarea` / `notaParaElModelo` en `manejadorEscalera.js` | `57df5c8` |
| «Salchilimon grande» → «no está en la carta» (hay personal y mediana) | `buscar_producto` busca sin el tamaño y devuelve `tamano_que_no_hay` + una nota | `sinElTamano` en `adapters/restaurante/index.js` | `57df5c8` |
| El modelo preguntaba «¿Cuáles dos sabores prefieres?» y se le pegaba «¿Lo confirmo? sí o no»; el «sí» creó el pedido sin los hervidos | Si el modelo termina en pregunta no se añade el recordatorio y el pendiente queda con `pregunta_abierta`: el siguiente «sí» **no ejecuta**, vuelve a enseñar el resumen; lo demás lo lee el modelo | `conSiPendiente` (escalera) + rama `pregunta_abierta` en `flujo.js` | `dc034e6` |
| «Ahora mismo no tengo a nadie del negocio disponible… en el transcurso del día», con el local abierto | En restaurante, cuando el Nivel 4 se atasca dice lo mismo que `pasar_a_persona`. El resto de verticales conserva la frase de ADR-023 | `decisionDeHandoff` en `manejadorLlm.js` | `dc034e6` |
| El cliente escribe por partes («Esa viene con queso mor»… 6 s… «A domicilio») y el bot ya había contestado lo primero | Segunda espera para **texto libre**: 7 s tras el último mensaje, techo 20 s. Lo completo (sí/no, botón, pedido de la carta, saludo, teléfono) sigue en 2,5 s | `puedeSeguirEscribiendo` en `texto.js`, `debounceTextoMs` en `cola.js` | `dc034e6` |
| «¿Viene con queso?» → pasaba a una persona | Prompt **`sistema.v15`**: mira la descripción; si no lo trae, lo dice y ofrece la **adición** con su precio | `model/prompts/sistema.v15.md` | `13d1cdc` |
| «¿La viciosa trae tocineta?» → «la descripción no lo indica» (no la había recibido) | `buscar_producto` manda descripción hasta con **4** resultados (los cuatro tamaños de un plato) | `MAX_CON_DESCRIPCION` | `13d1cdc` |
| «Buenas noches veci», «Hola cómo está» iban al modelo, que saludaba **sin la carta** | `esSaludo` acepta vocativos y «¿cómo está?» (hasta 6 palabras, todas de saludar) | `texto.js` | `13d1cdc` |
| Pedidos de 3–4 productos acababan en una persona (`max_vueltas`) | `LLM_MAX_VUELTAS=8`: luna busca **un producto por vuelta** y con 4 se quedaba sin margen | `.env` del VPS | — |
| «Por favor me regalan Nequi para cancelar» → «¿anular o pagar?» | La pregunta de pago reconoce el plural | `pago.js` | `c3e9ab8` |
| A un «Personal» se le repetía el resumen entero | Repregunta corta: «¿Confirmo lo de arriba? Respóndeme sí o no.» | `engine/confirmacion.js` | `8139d79` |

**Variables nuevas en el `.env` del VPS** (copia previa: `.env.antes-espera-20261005`):

```
CONVERSACION_DEBOUNCE_TEXTO_MS=7000   # 0 o sin la línea = apagada (el valor por defecto del código)
LLM_MAX_VUELTAS=8                     # por defecto 4
```

## 2. Lo que conviene saber antes de tocar esto otra vez

- **`gpt-5.6-luna` rellena lo que no sabe.** Sin dato de entrega elegía «para recoger»; cerrada esa
  puerta, probó con «para servir». El patrón que funciona es el de `TELEFONO_REQUERIDO`: **lo impone
  la plataforma y el error vuelve al modelo**, que entonces pregunta. Una regla en el prompt no basta.
- **`confirmacion.falta({ args, cliente, asistente })`** es el gancho nuevo para eso: lo declara la
  capacidad, recibe lo dicho en el chat (los últimos `LLM_HISTORIAL` mensajes, 10) y devuelve
  `{ codigo, mensaje }` o `null`. Es deliberadamente laxa: solo bloquea si **nadie** habló del tema.
  Límite conocido: en una conversación de más de 10 mensajes puede volver a preguntar algo ya dicho.
- **WhatsApp no avisa de que el cliente «está escribiendo».** La Cloud API no entrega ese evento:
  la única forma de esperar a quien escribe por partes es esperar más. El precio son ~4,5 s de más
  en cada respuesta a texto libre; si se siente lento, bajar a 5000.
- **ADR-014 pide un debounce de 2–4 s.** La espera de texto libre (7 s) se sale de ese rango a
  propósito, por decisión del dueño, y vive detrás de una variable de entorno apagada por defecto.
  Si se queda, merece una enmienda al ADR.
- **`pregunta_abierta` vive en `tarea_datos`** de la confirmación pendiente. La pone la escalera, la
  consume el flujo de restaurante. Una vertical que no la lea se comporta como antes.
- **Una regresión propia, cazada a la hora:** al hacer tolerante `noTraeLoPedido` con `mismaPalabra`,
  «salchibarril» (agotada) casó con «Salchi-limón» por el prefijo `salchi`, dejaron de mirarse los
  agotados y el modelo anotó una Salchi-limón. `mismaPalabra` da por iguales dos palabras si la
  corta (≥4 letras) es prefijo de la larga: sirve para buscar, **no** para decidir que algo «sí es
  lo pedido». Quedó en comparar sin guiones ni espacios.
- **El «mensaje vacío» que confirma un pedido no es un bug:** es el toque de un botón que el cliente
  borró después (`crudo.eliminado`). En las transcripciones sale como `CLIENTE: ` sin texto.

## 3. La evaluación

`intelligence/evaluacion/conversaciones/respuestas_restaurante.json` pasó de 26 a **31 casos**
(`tamano-que-no-existe`, `pedido-sin-decir-como-lo-recibe`, `dos-productos-sin-decir-como-los-recibe`,
`ingrediente-que-es-adicion`, `ingrediente-que-si-trae`). Con luna, `sistema.v15` y
`LLM_MAX_VUELTAS=8`: 30/31, 31/31 y 31/31 en las tres últimas rondas. Cada ronda ≈ US$0,013.

```bash
# Base LOCAL (5432). Ojo: sin LLM_MAX_VUELTAS=8 el caso «varios-productos-falta-telefono» falla.
LLM_MAX_VUELTAS=8 DB_PORT=5432 FEATURES_FORZADAS=asistente_ia LLM_MODELO=gpt-5.6-luna \
    node scripts/evaluar.js respuestas_restaurante --negocio 1815 --detalle
```

Tests nuevos: `auditoria_2026_10_05.test.js`, `auditoria_2026_10_05_noche.test.js`,
`saludo_con_vocativo.test.js`. La repregunta corta cambió una expectativa de
`auditoria_2026_10_02.test.js`. `e2e_agendar` sigue fallando en local desde antes (3 tests).

## 4. Lo que se midió (1–5 de octubre, negocio 6)

**Mensajes del asistente entregados: 1.048 en cinco días** (177, 178, 223, 360 —domingo— y 110 hasta
las 20:00 del lunes). ≈ 235 al día → **~7.000 al mes**. Zona Burger pasó los 1.000 gratis el día 5.

| Clase | Mensajes | |
|---|---|---|
| Respuestas del modelo (precios, tamaños, preguntas) | 494 | la mitad; la única palanca grande |
| Saludo con la carta | 124 | |
| Resumen para confirmar | 121 | |
| «Pedido tomado» | 107 | |
| «¡Con gusto!» a un gracias | 46 | se decidió **dejarlo** (ver §5) |
| Paso a una persona | 40 | |
| Saludo con el local cerrado / «seguimos cerrados» | 22 / 9 | |
| Tiempo estimado | 28 | |
| Aviso de pedido listo | 23 | |
| «Anotado» + resumen · pagos · resumen repetido · «¿Lo confirmo?» | 11 · 10 · 8 · 5 | |

Los mensajes que el local escribe desde su celular (`crudo.origen = 'app_negocio'`, 465 en esos días)
**no pasan por la Cloud API y no se cobran**.

**Confirmaciones:** de 116 conversaciones que llegaron a «¿Confirmo tu pedido?», 106 confirmaron, 4
dijeron «no» y unas 6 se quedaron sin contestar (≈1 al día). Tardan 17–79 s de media; **ninguna pasó
de 10 minutos** (ninguna caducó).

**Clientes sin número visible (BSUID):** 40 de 217 conversaciones, casi 1 de cada 5.

## 5. El costo de Meta, ya con número

**Tarifa de Colombia: US$0,0008 por mensaje** (dato del dueño, del *rate card* de Meta, 2026-10-05;
pendiente de confirmar contra el primer cobro real en `/admin/terceros`, que Meta reporta con retraso).

- ~6.000 mensajes cobrables al mes × US$0,0008 = **~US$4,80 ≈ $20.000 COP** para un cliente como
  Zona Burger. Con todos los días como un domingo (360/día): ~US$7,80 ≈ $32.000.
- **~$3,3 COP por mensaje.** Un pedido por la carta digital (3 mensajes) ≈ $10; uno conversado
  (6–10) ≈ $20–33.
- Lo paga el cliente a Meta (cuenta propia por Embedded Signup), no EscalApp.
- Sumado al modelo (US$1,5–2,5 con luna): **~US$6–7 al mes** de costo variable del asistente.

**Consecuencia de producto:** a $3 el mensaje, recortar cortesías no mueve nada (quitar el «¡Con
gusto!» ahorraría ~$900 al mes). Lo que cuesta es **un pedido perdido** —uno de $16.000 es casi un
mes de Meta—. La prioridad es que el asistente acierte, no que hable menos.

## 6. Decisiones del dueño en esta sesión

- **Sí:** esperar a quien escribe por partes; que el asistente conteste lo de los ingredientes y
  ofrezca la adición; la bienvenida con la carta ante cualquier saludo; repregunta corta.
- **No:** un recordatorio automático al cliente que no confirma. Descartado: recuperaría ~1 pedido
  al día, exige que el asistente hable sin que le escriban (un temporizador nuevo) y es un mensaje más.
- **Se deja:** el «¡Con gusto! 😊».

## 7. Pendientes, por prioridad

1. **Ligar pedido ↔ conversación con una columna** (decidido, sin hacer; con el local cerrado). Hoy
   quién es el dueño de un pedido se comprueba por teléfono, y a un cliente BSUID se le niega
   consultar, cancelar y añadir a **su propio** pedido (`PEDIDO_NO_ES_DE_QUIEN_PIDE`). Con la
   columna: «lo creó este chat → es suyo». Es la misma pieza que necesita «Avisar que está listo»,
   que hoy adivina el chat por el texto. No cubre los pedidos creados a mano en caja.
2. **«¿Ya salió mi pedido?» en chats que atendió una persona:** no hay número de orden y el modelo
   usó como número el total que dijo el cajero («76.000», «77»). Debería pasar a una persona.
3. **La suma «con domicilio incluido»** olvidó el empaque ($15.500 + domicilio en vez de $16.000).
4. **Orden de llegada** de la respuesta del modelo y el «¿Lo confirmo?» cuando salen en el mismo
   turno: se encolan bien, pero con la misma hora; sin comprobar cómo le llegan al cliente.
5. **Auditar mañana** lo de esta noche que aún no se vio en un chat real: `pregunta_abierta`, la
   espera de 7 s, `sistema.v15` con ingredientes, los saludos con «veci».
6. **Empujar la carta digital desde el chat** sigue siendo la palanca de costo (mitad de los mensajes
   son conversación con el modelo).
7. Avisarle a Juan David: prompt en uso `sistema.v15`, y las dos variables nuevas del `.env`.
8. Del negocio, no del asistente: **domicilios de 1 h 30 a 2 h** (una clienta canceló, otra escribió
   molesta). El asistente las pasó bien a una persona.
9. Siguen del documento anterior: `migrate:negocio-asistente-pausa` en la base compartida, corregir
   `precios.js`, el envío semanal del informe.

## 8. Cómo deshacer

- Todo el código de la sesión: `git checkout bdd8540` en el VPS + reiniciar.
- Solo la espera: quitar `CONVERSACION_DEBOUNCE_TEXTO_MS` del `.env` + reiniciar.
- Solo el prompt: `PROMPT_SISTEMA = 'sistema.v14'` en `model/promptBuilder.js`.
- Solo las vueltas: quitar `LLM_MAX_VUELTAS`.

## 9. Añadido tras la auditoría de las 21:25 (`ef40bdd`, en producción 22:13)

Segunda auditoría de la noche (19:10–21:25, 21 conversaciones, 10 pedidos del asistente, ninguno
equivocado). Se vieron funcionando en chats reales `ENTREGA_SIN_DECIR`, la espera a quien escribe
por partes, los agotados, `tamano_que_no_hay` y el saludo con «veci». Dos arreglos más:

- **Cambiar un pedido ya tomado no crea otro (`YA_HAY_PEDIDO`).** Con ORD-7789 tomado, «solo salsa
  de piña y tomate, menos la BBQ» hizo que el modelo llamara otra vez a `tomar_pedido`: un «sí» y a
  cocina le entraban dos. Ahora `confirmacion.falta` —que pasó a ser **asíncrona** y recibe `hilo`
  (el chat en orden) e `idConversacion`— mira en el Ledger si este chat tomó un pedido en las
  últimas 2 h; si es así y el cliente no habla de «otro», el error vuelve al modelo: cambios →
  `pasar_a_persona`, añadidos → `agregar_items_pedido`.
- **«Que me regalen salsa de ajo» va a la nota.** Empezar por «que» lo hacía pregunta; se pasó a una
  persona y el pedido salió sin la salsa. `texto.esPeticionConQue`.

Pendientes nuevos:

- **Tiempo estimado distinto para recoger y para domicilio** (decidido, sin hacer: campo nuevo en la
  configuración). A «¿en cuánto puedo pasar?» el asistente dijo «40 a 60 minutos» —el del
  domicilio— y el cajero tuvo que aclarar «no es tanto, es la IA».
- Un «sí»/«no» suelto después de «pedido tomado» (toque tardío de un botón) va al modelo.
- «Veci, ¿se demora?» con el pedido a punto de pasarse del estimado debería ir a una persona.
- Noche de domicilios de más de una hora: el asistente siguió prometiendo 40–60 min. El negocio
  puede subir el tiempo de entrega en «Configuración del asistente» cuando esté saturado.
