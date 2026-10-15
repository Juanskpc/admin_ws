# Adiciones, toppings y extras en restaurante (2026-10-15)

Un producto puede ofrecer cosas que se le agregan y se cobran aparte: «adición de queso» en un
restaurante, «toppings» en una heladería. Es **opt-in por negocio** (Configuración → Operación) y
el negocio elige la palabra con la que se nombran.

En la misma sesión entraron otros dos cambios pequeños, anotados al final: el asistente de
WhatsApp nace en pausa al conectar el primer número, y la prueba gratuita pasa a 30 días.

## La decisión: una adición ES un producto

Una adición es una fila de `restaurante.carta_producto` con `es_adicion = true`. Así trae gratis
lo que una tabla aparte de «opciones» habría tenido que duplicar:

- precio, descripción, imagen;
- el interruptor de agotado (`disponible`);
- **receta** (`carta_producto_ingred`): una adición descuenta su insumo del inventario por el mismo
  camino que cualquier plato (`consumirIngredientesPorItems`);
- datos fiscales para la factura electrónica.

`restaurante.carta_producto_adicion (id_producto, id_adicion, orden, estado)` dice qué adiciones
ofrece cada plato. Una adición no ofrece adiciones (no hay «topping del topping»).

## En el pedido: una línea que cuelga del plato

`restaurante.pedid_detalle.id_detalle_padre` apunta a la línea del plato. La adición **sigue siendo
una línea normal** (precio, cantidad, subtotal), así que totales, caja, multipago, tiqueteras,
reportes y factura electrónica la cuentan sin cambiar nada. Lo que cambia es cómo se **pinta**.

- La `cantidad` que manda el cliente/POS es **por unidad** del plato; la guardada es la **total**
  (2 hamburguesas «con doble queso» → queso ×4).
- El precio sale **siempre de la base** (`adicionService.resolverItems`), nunca del navegador ni
  de la conversación.
- Solo entra una adición que el plato ofrece, activa, de ese negocio y no agotada. Con el negocio
  apagado, un pedido con adiciones se rechaza (`ADICIONES_NO_HABILITADAS`, 403).
- `quitarItemsOrden` empareja por producto + exclusiones + nota + **adiciones**, y al reducir el
  plato reduce sus adiciones en proporción (o las borra con él).
- Las consultas de Caja, Despacho, Mesas, Cocina y `getOrdenById` ordenan las líneas por
  `id_detalle`: como se crean seguidas, cada adición queda justo debajo de su plato.

## Dónde se ve

| Pantalla | Qué hace |
|---|---|
| Configuración | Interruptor + lista «¿Cómo las llamas?» (Adiciones, Toppings, Extras, Agregados, Acompañamientos, Complementos, Ingredientes extra, Salsas). Catálogo en `app_core/helpers/terminosAdicion.js` y copia en `restaurante_app/src/app/core/utils/terminos-adicion.ts` — **añadir un término = tocar los dos**. |
| Menú | Casilla «Es adición» (la categoría pasa a ser opcional: sin ella va a la del término, oculta de la carta) y, en los demás productos, la lista para marcar cuáles ofrece + «Crear» rápido. Para que descuente inventario se le pone receta como a cualquier producto. |
| Pedidos (POS) | Al tocar un producto con adiciones se abre la ventana de personalización con «− n +» por adición. La línea muestra «+ Queso» y el precio con adiciones. Un pedido cargado pliega las líneas hijas dentro de su plato. |
| Caja | Las adiciones van dentro de la tarjeta de su plato y el monto suma las dos. |
| Despacho / Mesas | «+ Queso» sangrado bajo el plato, también en el tiquete impreso. |
| Cocina | ➕ Queso dentro del plato; marcar el plato listo marca también sus adiciones. |
| Carta digital | La adición no se lista sola; el «+» del plato abre el modal con sus adiciones. |

Con la opción encendida, el POS y la carta no ofrecen las adiciones como producto suelto (filtro
en `cartaController` y `adicionService.adjuntarACartaPublica`). **El asistente de WhatsApp sí las
sigue encontrando** (`cartaService.buscarProductos` sin filtro), a propósito: si el modelo pide
«adición de costilla» por chat, se suma como línea suelta, que es como funcionaba antes.

## Contrato con el asistente: `-a` en el código de la carta

`#P12-4x2-r12-a31.31.40`: después del `-r`, los ids de las adiciones de esa línea; un id repetido
es una más por plato. Lo escribe `carrito.service.ts` y lo lee
`intelligence/adapters/restaurante/codigoPedido.js`. El flujo lo pasa a `tomar_pedido` como
`con: "31.31.40"` (el motor de argumentos no anida listas), la confirmación lo enseña con su
precio («(sin cebolla, + 2 Queso)») y `ejecutar` se lo da a `crearOrden`, que valida y pone precio.
Un código sin `-a` se lee exactamente igual que antes.

## Despliegue

**La migración va ANTES del backend**: los modelos de `carta_producto`, `pedid_detalle` y
`gener_negocio` ganaron columnas, y cualquier consulta sin lista de atributos fallaría sin ellas.

```bash
node scripts/migrar.js restaurante-adiciones     # en el VPS, después del respaldo
```

Aplicada en la local, la compartida y **producción** el 2026-10-15 (~10:35).
Frontends: `restaurante_app` (todas las pantallas de arriba) y `admin_app-v21` (solo los puntos de
abajo).

Pruebas: `npx jest __tests__/restaurante/adiciones.test.js __tests__/intelligence/pedido_adiciones_contrato.test.js`
(contra la local) y `carrito.service.spec.ts` en `restaurante_app`.

## Pendientes

- **Adiciones por chat libre**: si el cliente escribe «con queso extra» (sin carta), el modelo las
  suma como producto suelto, no ligadas al plato. Ligar eso es tocar el prompt y
  `agregar_items_pedido`; coordinar con quien lleva el prompt.
- **Zona Burger** ya tiene una categoría ADICIONALES con productos sueltos. Para usar la función:
  encender la opción, marcar esos productos como adición y asignarlos a las hamburguesas. Nada de
  eso se hizo; es decisión del negocio.
- Las adiciones se escogen de una en una («− n +»); no hay grupos con mínimo/máximo («elige 2
  salsas»). Si un cliente lo pide, es una columna en `carta_producto_adicion`.

## Los otros dos cambios de la sesión

- **WhatsApp nace en pausa**: `canalEmbeddedSignup.conectar()` deja
  `gener_negocio.asistente_pausado = true` en la misma transacción **si es la primera conexión del
  negocio** (ninguna fila previa en `platform.numero_canal`). Una reconexión no lo toca. El dueño
  lo reanuda desde la Bandeja, que ya enseña la revisión de preparación y ahora lo recuerda en la
  franja de pausa. La migración `negocio-asistente-pausa` faltaba en la compartida y se aplicó.
- **Prueba gratuita de 30 días**: `DIAS_PRUEBA` en `app_core/dao/negocioDao.js` (alta por el super
  admin) es ahora la única constante — `registroTrialService` (landing) la importa en vez de tener
  su propio 7. Textos del correo, la landing y la consola actualizados; en el frontend la
  constante vive en `admin_app-v21/src/app/core/utils/vigencia.ts`. Los negocios que ya están en
  prueba conservan su fecha de fin.
