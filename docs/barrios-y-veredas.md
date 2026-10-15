# Barrios y veredas: precio del domicilio por comuna o corregimiento (2026-10-15)

Configuración → **Cobros** → «Barrios y veredas». El negocio pone el precio del domicilio a cada
zona de la ciudad, y ese precio se suma solo al pedido: en la carta virtual, en el asistente de
WhatsApp y en el POS.

## Cómo funciona el precio

- Hay un **catálogo de la ciudad**, compartido por todos los negocios: `general.gener_geo_zona`
  (comuna o corregimiento) y `general.gener_geo_lugar` (barrio o vereda). Se sembró Pasto desde
  `migrations/data/barrios_pasto.json`, sacado del Excel `barriosPasto.xlsx`: 12 comunas,
  17 corregimientos, 555 lugares. Se quitaron 3 filas repetidas dentro de una misma comuna
  («San Andresito» ×2 en la 1, «Colonial» ×3 en la 9). El listado se copió tal cual (incluido
  «Uranización Zarama», que parece una errata de «Urbanización»).
- Cada negocio **copia** el catálogo a sus tablas con un botón («Cargar listado de Pasto»), sin
  precios: `restaurante.rest_zona_domicilio` y `restaurante.rest_barrio_domicilio`.
- **Precio de un barrio = el suyo, o si no tiene, el de su zona** (`COALESCE`). Sin ninguno, el
  barrio **no se ofrece**: así un negocio carga la ciudad entera y le pone precio solo a donde lleva.
- «Igualar» deja toda una zona a su precio (les quita el precio propio a sus barrios).
- «Subir / Bajar todos» suma o resta un monto a cada precio de zona y a cada precio propio. Lo que
  no tiene precio sigue sin tenerlo, y nada baja de 0.
- Los barrios de antes (sin zona, con su valor) siguen funcionando igual.

Los nombres se repiten entre zonas («San José» está en la Comuna 1, en Buesaquillo y en El Encano),
así que el nombre es único **por zona**, no por negocio.

## Plantilla de Excel

«Descargar Excel» trae lo que el negocio ya tiene (o, si aún no tiene nada, el listado de la
ciudad sin precios). Dos hojas: «Comunas y corregimientos» (precio de la zona) y «Barrios y
veredas» (precio propio; vacío = el de la zona), más una hoja de instrucciones. «Subir Excel»
aplica los precios, crea lo que no exista y **no toca lo que no esté en el archivo**. Todo o nada:
con un precio inválido no se guarda nada y el mensaje dice la fila.

## Dónde se usa

| Dónde | Qué hace |
|---|---|
| Carta virtual | Con más de 12 barrios, buscador («Escribe tu barrio o vereda») y resultados agrupados por zona. El barrio elegido viaja con su zona en el nombre. |
| Asistente de WhatsApp | Con más de 25 barrios no los lista (no caben): resume el precio **por zona** y pide el nombre. Si el nombre existe en varias zonas, los da numerados («1. San José (Comuna 1) — $5.000») y toma el número. «San José comuna 1» acierta a la primera. En la información del negocio, con más de 40 barrios va `domicilio_por_zona` en vez de la lista. |
| POS (Pedidos) | Al marcar «Cobrar domicilio», un campo de barrio con lista: al elegirlo, su precio pasa al valor (se puede corregir a mano). |
| Sedes | Al crear una sede se clonan las zonas y luego los barrios, con su enlace traducido. |

El valor que se cobra lo relee siempre el servidor (`barrioService.resolverBarrio`), nunca el que
venga en el mensaje.

## Despliegue

**La migración va ANTES del backend** (`valor` pasa a admitir NULL y el modelo tiene columnas nuevas):

```bash
node scripts/migrar.js restaurante-zonas-domicilio   # en el VPS, después del respaldo
```

Aplicada en la local, la compartida y **producción** el 2026-10-15 (~10:35). La siembra de
Pasto va dentro de la misma migración (tarda ~2 min contra la compartida por la latencia del túnel).
Otra ciudad = otro JSON en `migrations/data/` añadido a `CATALOGOS` en la migración.

Pruebas: `__tests__/restaurante/zonas_domicilio.test.js`, `__tests__/restaurante/barrios_domicilio.test.js`,
`__tests__/intelligence/pedido_barrio_zonas.test.js` (contra la local).

## Pendientes

- Despacho permite editar el valor del domicilio de un pedido ya tomado, pero todavía a mano: no
  tiene el selector de barrio del POS.
- El pedido no guarda **qué barrio** era (solo el valor y la dirección). Si hace falta para reportes
  por zona, es una columna en `pedid_orden`.
