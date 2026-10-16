# Ideas para innovar — qué hace el mercado y qué podría hacer EscalApp

**Estado:** exploración, nada decidido ni construido — **decisión del 2026-10-15: se documentan,
no se implementan todavía** · **Fecha:** 2026-10-15 (segunda tanda, ideas 7–15, el mismo día) ·
**Elegida para profundizar:** la idea 1 → [`fidelizacion-sellos.md`](fidelizacion-sellos.md)

> **En una frase.** Lo grande del plan original ya está hecho, así que se miró a quién se parece
> EscalApp afuera. El más parecido es **Owner.com** (EE. UU.: pedidos directos sin comisión, puntos
> y marketing automático para restaurantes independientes; US$240 M levantados en agosto de 2026 a
> una valoración de US$2.300 M). En Latinoamérica nadie junta las tres piezas que EscalApp ya junta
> —punto de venta, WhatsApp con IA y citas—: Loggro y Fudo son POS, Treble/Jelou/Yalo son bots
> para marcas grandes, AgendaPro es agenda. Ese hueco es el que conviene ocupar.

---

## 1. Las ideas, en orden de recomendación

| # | Idea | Quién lo hace afuera | Qué ya tenemos | Esfuerzo |
|---|---|---|---|---|
| 1 | **Tarjeta de sellos / puntos por WhatsApp, sin app** | Owner.com, AgendaPro, cadenas grandes | ficha del cliente (`platform.persona_negocio`), libro de cuenta de las tiqueteras, canal | medio |
| 2 | **Recuperar clientes que dejaron de venir** (mensaje automático a los ~45 días sin pedir) | Treble, Paytronix, Owner.com | promociones masivas F0–F2 en producción (piloto), segmentos con `ultimo_pedido` | bajo-medio |
| 3 | **El dueño le pregunta a su negocio por WhatsApp** + resumen automático al cerrar caja | Toast IQ, Lightspeed, Square | motor de Intelligence, capacidades de solo lectura, canal | medio |
| 4 | **Pedir la reseña en Google** tras entregar el pedido | Owner.com | aviso de «pedido listo», plantillas | bajo |
| 5 | **Pagar con Bre-B desde el chat** (llave/QR del negocio en el resumen + leer el comprobante) | QR interoperable de bancos (Bancolombia, BBVA/Credibanco) | resumen del pedido; «comprobantes» ya es pendiente del relevo del 2026-10-02 | bajo sin integración / alto con ella |
| 6 | **Reserva: tarjetas de regalo y lista de espera** que llena el hueco de una cancelación | AgendaPro (gift cards), Fresha (abonos) | abonos diseñados en `perfiles-de-reserva.md`; libro de cuenta reutilizable | medio |

### Notas por idea

**1 — Sellos.** Detalle completo en [`fidelizacion-sellos.md`](fidelizacion-sellos.md). Lo que
importa aquí: el premio lo regala **el negocio**, no EscalApp; EscalApp vende la herramienta.

**2 — Recuperar clientes.** La práctica que se repite es: cliente sin venir ~60 días → oferta con
vencimiento corto (~14 días). Medir con el **% que vuelve en 30 días**, no con aperturas. Casi todo
está construido en `promociones-masivas.md` §11–§14; lo nuevo es que el envío sea **automático**
(por regla) y no por campaña manual.

**3 — Preguntarle al negocio.** Toast vende «Toast IQ»: preguntas en lenguaje natural sobre los
propios datos y alertas sin que nadie pregunte. La versión mínima para nosotros no necesita IA: un
**resumen al cerrar caja** por WhatsApp al dueño (ventas, plato estrella, insumo que se acaba). La
versión con preguntas libres reutiliza el motor y capacidades de solo lectura nuevas.

**4 — Reseñas en Google.** Un mensaje por pedido entregado con el enlace de reseña del negocio. Sube
al negocio en Google Maps, que es de donde llega el cliente nuevo. Ojo con la calidad del número:
solo a quien acaba de recibir su pedido, nunca en lote.

**5 — Bre-B.** 36 M de usuarios y 115 M de llaves a septiembre de 2026; QR interoperable vigente.
**No se encontró documentación pública de una API para comercios**, así que la primera versión es
sin integración: el bot muestra la llave del negocio y el cajero confirma el pago (o el bot lee el
comprobante).

**6 — Reserva.** La tarjeta de regalo es un saldo prepagado: el mismo patrón que la tiquetera del
restaurante. La lista de espera convierte una cancelación en una cita de otro cliente sin que el
negocio haga nada.

## 1-bis. Segunda tanda (ideas 7–15)

Criterio de búsqueda: qué hacen los demás **y para qué ya tenemos los datos guardados**, porque eso
es lo que vuelve barata una idea. Un dato de contexto: el informe 2026 de la James Beard Foundation
con Deloitte encontró a los restaurantes independientes **abrumados por la cantidad de
herramientas** (29 % usa cuatro o más). Eso favorece al que junta todo en un sitio, que es la
posición de EscalApp: cada idea de abajo debería vivir **dentro** de lo que ya existe, no ser otra
app más.

| # | Idea | Quién lo hace afuera | Qué ya tenemos | Esfuerzo |
|---|---|---|---|---|
| 7 | **Costo real de cada plato y alerta de margen** («la carne subió: tu hamburguesa ahora deja 18 % menos») | Marge-Up, Kostly, RestauMargin (todos 2025–26, en pilotos) | **compras con `precio_unitario` por insumo** (`compraService`) + **recetas** del inventario | medio |
| 8 | **Pedirle al proveedor por WhatsApp** desde Inventario («faltan 5 kg de carne» → mensaje listo al proveedor) | Frubana lo hacía como mayorista y **cerró en Colombia en 2024** | proveedores (`proveedorService`), stock mínimo, compras | bajo |
| 9 | **WhatsApp Flows para los datos del domicilio** (un formulario dentro del chat en vez de pregunta-respuesta) | Infobip, Blip, Chattigo lo venden para formularios | el flujo de `FALTAN_DATOS` ya junta lo que falta en una pregunta | medio |
| 10 | **Pagar la cuenta desde la mesa** con el QR (enlace de pago o Bre-B) | Toast, Square, Obypay | la carta virtual ya **pide** desde la mesa (`mesaPublicaService`); falta pagar | medio |
| 11 | **Nómina electrónica DIAN** para los empleados del negocio | Nominapp, Siigo, Alegra | **integración con Factus**, que vende nómina por API de aliados (y la bolsa la incluye) | medio-alto |
| 12 | **Membresías en reserva** («cortes ilimitados por $X al mes») | Booksy, Boulevard, Zenoti | cobro recurrente con Wompi ya construido **para EscalApp** (pago automático) | alto |
| 13 | **Instagram como segundo canal** del asistente | bots genéricos (Tidio, Chatplace) | ADR-017 ya lo anticipa: el canal es un puerto; Meta es la misma plataforma | medio-alto |
| 14 | **«Reservar con Google»** para negocios de reserva | Booksy, Barberly, Timely (socios de Google) | portal de citas público por subdominio | alto (aprobación de Google) |
| 15 | **Adelanto de ventas / crédito al negocio** con un socio financiero | Rappi (financiación a aliados), R2 (opera en Colombia), Yofio | historial de ventas diario de cada negocio | muy alto (regulatorio) |

### Notas de la segunda tanda

**7 — Costo por plato.** Es la que más vale de esta tanda y la más barata, porque **los dos datos ya
están guardados** y nadie los cruza: lo que cuesta cada insumo (sale de las compras) y cuánto lleva
cada plato (la receta). Con eso se calcula:
- costo y margen de cada plato, con la última compra de cada insumo;
- la **matriz de la carta** (más vendido × más margen: «estrellas», «caballos de batalla»,
  «rompecabezas», «perros»), que es la herramienta clásica para decidir qué subir, qué promocionar
  y qué quitar;
- **alerta** cuando una compra registra un insumo más caro que la anterior y eso baja el margen de
  un plato por debajo de un umbral.

Los competidores agregan **IA que lee la factura del proveedor** desde una foto. Para nosotros eso
es natural: el dueño le manda la foto de la factura al WhatsApp y la compra queda registrada (lo que
habilita la idea 3). Requisito a medir antes: **cuántos negocios registran compras y recetas de
verdad**; sin eso no hay costo que calcular.

**8 — Pedido al proveedor.** La versión mínima no gasta mensajes de Meta: un botón en Inventario
arma el texto con lo que está bajo el mínimo y abre `wa.me/<número del proveedor>` en el celular
del dueño, que es quien lo envía. Cero costo, cero plantillas. Frubana dejó de operar en Colombia en
2024, así que los restaurantes volvieron a pedir por WhatsApp a mano: lo que se automatiza es
justamente eso.

**9 — WhatsApp Flows.** Detalle y ejemplo en [`whatsapp-flows.md`](whatsapp-flows.md). Un Flow es una ventana-formulario dentro del chat (dirección, barrio,
forma de pago, a domicilio o para recoger) que el cliente llena **de una vez**. Encaja con la
pelea por **menos mensajes por pedido** (6,9 hoy, el cupo rozando 6.000): varias idas y vueltas
pasan a ser un envío. Ojo: hay que comprobar cómo cobra Meta un Flow y si el asistente sigue
entendiendo lo que el cliente escribe fuera del formulario.

**10 — Pagar desde la mesa.** Las cifras de ticket más alto (+12 % Toast, +15 % un caso de Obypay,
+35 % de ventas en 30 días Square) **son todas del proveedor**. Y la encuesta de Toast de 2025 dice
que solo el 1 % de los comensales **prefiere** la carta por QR. La lectura sensata: sirve como
opción para pagar rápido, no para reemplazar al mesero. **WhatsApp Pay no está activo en Colombia**
(«planificado» según guías de marzo–mayo 2026), así que el camino es enlace de Wompi o Bre-B.

**11 — Nómina electrónica.** Todo negocio con empleados que quiera deducir esos pagos en su renta
debe transmitir la nómina a la DIAN cada mes (los primeros 10 días hábiles). La **lista de Factus
para nómina** ya está en `facturacion-electronica.md` (24 documentos/año → $60.000; 1.200 →
$480.000) y **la bolsa multifacturador la incluye** en el mismo cupo. Construimos la conexión con
Factus para facturas: la nómina sería la segunda cosa que pasa por ella. Lo pesado no es la DIAN
sino **liquidar** la nómina bien (prestaciones, horas extra), que es un producto en sí mismo.
Confirmar con Factus el alcance de su API de nómina antes de nada.

**12 — Membresías en reserva.** Zenoti reporta para 2026 que las membresías crecieron 20 % en
barberías y que las visitas de **clientes nuevos cayeron 17 %**: el foco del sector es retener.
Lo difícil es cobrar mes a mes **a nombre del negocio**: el pago automático que hicimos cobra
para EscalApp, no para el inquilino. Hace falta que cada negocio conecte su propia pasarela.

**13 — Instagram.** Hay un caso (no verificado) de una cadena de sushi de siete locales donde ~90 %
de los pedidos llegaban por mensajes de Instagram. Para negocios de comida de barrio WhatsApp manda,
pero para salones, barberías y comida «de moda» Instagram puede ser el canal principal. Falta leer
las reglas actuales de Meta para mensajes automáticos en Instagram.

**14 — Reservar con Google.** El botón «Reservar» en Google Maps viene de **socios aprobados por
Google** que sincronizan disponibilidad en tiempo real. Requiere solicitud y aprobación, y no se
encontraron las reglas de cobertura por país para 2026. Alto valor para reserva, pero no depende
solo de nosotros.

**15 — Crédito.** Se anota por completo: es lo que hacen Rappi, Toast y Square con los datos de
ventas, y en Colombia opera R2 (financiación pagada con un % de las ventas diarias). Para EscalApp
solo tendría sentido como **referidor** de un socio financiero, nunca prestando. Muy lejos.

### Recomendación de la segunda tanda

Si hubiera que escoger: **7 (costo por plato)** primero —los datos ya están, nadie más en el
segmento lo da integrado al POS—, **8 (pedido al proveedor)** como victoria rápida de un día, y
**9 (Flows)** cuando se vuelva a atacar el costo de mensajes. 11 vale explorarla con Factus porque
reaprovecha una integración ya pagada.

## 2. Lo que se descartó por ahora

- **Agente de voz que contesta el teléfono** (Loman, Slang.ai: ~US$300–500/mes por local en EE. UU.).
  En Colombia el canal es WhatsApp.
- **App propia para el comensal** y **marketplace tipo Rappi**. Las dos van contra nuestra ventaja:
  el canal **directo** del negocio con su cliente.

## 3. ⚠️ Corrección a la conversación que originó esto

En la primera versión de estas ideas se dijo que la tarjeta de sellos servía para «llenar la lista
de autorizados de promociones, que está vacía». **Es falso desde el 2026-10-12**:
`promociones-masivas.md` §4 decidió que la audiencia es **por defecto** (todo cliente con teléfono,
menos los que pidieron la baja) y que no se pregunta nada. La relación real entre sellos y
promociones es otra y está en `fidelizacion-sellos.md` §2: los sellos hacen que el cliente de
**mostrador y mesa** —que hoy no deja teléfono— lo dé, y eso agranda la audiencia.

## 4. Cuidado con las cifras

Casi todos los números de resultados que circulan («+60 % ventas», «recuperan el 22 % de los
clientes») son del propio proveedor y no están comprobados. El único dato independiente encontrado:
Circana (2025, citado por terceros) — los miembros de un programa de fidelización visitan un 22 %
más. Antes de anunciar números propios, medir con un piloto.

## 5. Fuentes

- Owner.com: [SiliconANGLE, ago. 2026](https://siliconangle.com/2026/08/28/owner-raises-240m-for-its-restaurant-management-platform/) · [reseña Dupple](https://dupple.com/reviews/owner)
- Toast IQ: [Toast](https://pos.toasttab.com/es-us/blog/on-the-line/toast-iq) · [Nasdaq](https://www.nasdaq.com/articles/toast-ai-strategy-will-agents-drive-restaurant-growth)
- WhatsApp en Latam: [Treble (El Espectador)](https://www.elespectador.com/economia/emprendimiento-y-liderazgo/trebleai-nosotros-ayudamos-a-las-companias-a-escalar-ventas-por-medio-de-whatsapp/) · [Jelou](https://www.jelou.ai/en/blog/how-smbs-in-latin-america-are-revolutionizing-their-sales-with-whats-app-and-ai) · [Yalo (EyN)](https://www.revistaeyn.com/especiales/pyme-emprende/tendencias/pequenos-negocios-tendran-acceso-a-la-inteligencia-artificial-por-medio-de-whatsapp-JL18206935)
- POS en Colombia: [Klikit](https://klikit.io/zh-CN/learn/best-restaurant-pos-colombia-2026) · [Fudo (TechCrunch)](https://techcrunch.com/?p=2374268)
- Reserva: [AgendaPro gift cards](https://agendapro.com/co/giftcards) · [AgendaPro recordatorios](https://agendapro.com/blog/recordatorios-de-citas-por-whatsapp/) · [Fresha abonos](https://www.irishbeauty.ie/Fresha-launches-appointment-deposits-features.html)
- Bre-B: [BanRep](https://banrep.gov.co/es/noticias/seis-meses-bre-b-acumula-34-millones-usuarios) · [El Colombiano](https://www.elcolombiano.com/inicio/bre-b-primer-ano-pagos-inmediatos-colombia-KI41948471) · [El País](https://www.elpais.com.co/economia/bancolombia-integro-sus-codigos-qr-a-bre-b-para-pagos-inmediatos-entre-bancos-asi-funciona-la-medida-0730.html)
- Recuperar clientes: [Purple](https://engage.purple.ai/es-mx/marketing-guides/win-back-campaigns-venues-bring-lapsed-guests-back) · [Paytronix](https://www.paytronix.com/hubfs/Case%20Studies/Paytronix_CaseStudy_We_Miss_You.pdf) · [US Tech Automations (cifra Circana)](https://ustechautomations.com/resources/blog/restaurant-loyalty-program-automation-35-percent-more-repeat-visits)
- Voz: [Techsy](https://techsy.io/en/blog/ai-voice-agent-for-restaurants)
- Tendencias / independientes: [Modern Restaurant Management](https://modernrestaurantmanagement.com/restaurant-tech-trends-that-will-define-2026/) · [James Beard Foundation](https://www.jamesbeard.org/impact/institute/restaurant-technology)
- Costo por plato: [Marge-Up (Capterra)](https://www.capterra.com/p/10045319/Marge-Up/) · [Kostly (Capterra)](https://www.capterra.com/p/10037552/Kostly/) · [RestauMargin](https://www.hunted.space/product/restaumargin) · [Supy](https://supy.io/blog/ai-for-recipe-costing-menu-engineering-the-future-of-restaurant-profitability)
- Proveedores: [Frubana cierra en Colombia (La República)](https://www.larepublica.co/empresas/frubana-cierra-en-colombia-3803987) · [Forbes](https://forbes.co/2024/02/16/negocios/frubana-se-enfocara-en-brasil-suspendera-sus-operaciones-en-colombia-y-mexico)
- Flows y pagos en WhatsApp: [Cliengo — pagos](https://guiawabusiness.cliengo.com/whatsapp-payments) · [EZContact — Flows](https://ezcontact.ai/es/blog/whatsapp-flows-guia-completa/) · [EZContact — cambios 2026](https://ezcontact.ai/es/blog/whatsapp-api-actualizaciones-2026/)
- Pagar en la mesa: [Square](https://squareup.com/us/en/the-bottom-line/reaching-customers/qr-code-ordering-system-ticket-size) · [Obypay](https://obypay.com/en/?p=2537) · [QRStuff (cifra de Toast)](https://www.qrstuff.com/feeds/blog/table-qr-code)
- Nómina electrónica: [ColombiaMove](https://colombiamove.com/blog/nomina-electronica-dian-pequenos-empleadores-colombia/) · [Occidente](https://occidente.co/empresario/el-abc-de-la-nomina-electronica/)
- Membresías: [Zenoti](https://www.zenoti.com/guides/barbershop-software-guide/) · [Boulevard](https://joinblvd.com/blog/best-barbershop-software)
- Instagram: [AI Productivity (caso sushi)](https://aiproductivity.ai/news/claude-agent-instagram-dm-ordering-sushi-chain/) · [Robylon](https://www.robylon.ai/blog/instagram-chatbot-automation-2026)
- Reservar con Google: [Google partners](https://www.google.com/maps/reserve/partners) · [Servme](https://servmeco.com/blog/reserve-with-google-for-restaurants-the-complete-guide/)
- Crédito: [R2](https://blog.r2.co/p/embedded-finance-in-latam-vs-the) · [Getnet](https://www.getnet.net/en/resources/blog/evolution-of-lending-solution) · [Rappi financiación (El Colombiano)](https://www.elcolombiano.com/negocios/rappi-ofrecera-financiamiento-a-sus-restaurantes-aliados-por-hasta-400-millones-CF22055337)
