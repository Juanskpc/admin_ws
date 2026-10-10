# Sedes de un negocio

Implementado el 2026-10-09. **No desplegado todavía.**

## Qué es una sede

Una sede **es** un negocio. Tiene su propio `id_negocio`, su caja, su inventario, su personal y su
plan. Lo único que la distingue es una columna nueva, `general.gener_negocio.id_negocio_padre`, que
dice de qué matriz cuelga.

`id_negocio_padre IS NULL` = es una matriz. Y una sede no puede tener sedes: un solo nivel.

## Por qué así, y no con un `id_sede` en las tablas

La alternativa era una tabla `gener_sede` y una columna `id_sede` en las tablas operativas, de modo
que un negocio contuviera varias sedes por dentro. Se midió el costo antes de descartarla:

| | |
|---|---|
| Tablas con `id_negocio` | **188** (84 `intelligence`, 26 `reserva`, 19 `restaurante`, 14 `auditoria`, 9 `parqueadero`, 8 `tienda`, 7 `general`, 7 `gym`, 5 `platform`, 5 `facturacion`, 4 `cobranza`) |
| Referencias a `id_negocio` en el backend | **6.398** en **461** archivos |

Cada query, cada informe y cada guard. Y además reabre la pregunta de aislamiento del
[ADR-002](adr/ADR-002-multitenancy.md), que es la peor clase de incidente del sistema: un `WHERE`
olvidado es una fuga entre clientes.

Con la sede como negocio hijo, el aislamiento que ya existe sirve tal cual. No cambia una sola
condición de ninguna consulta. Y operativamente es lo correcto: una sucursal real lleva su caja,
su inventario y su turno por separado.

El sistema ya estaba a medio camino sin saberlo:

- `gener_negocio_usuario` ya admitía N negocios por usuario.
- El header de `negocio_app` ya traía el selector, con el comentario `<!-- Selector de negocio (sede) -->`.
- `registrar-cliente` ya tenía el modo «usuario existente».
- `alcanceDeNegocios`, `req.principal` y `alcanceAdmin` ya acotaban por lista de membresías.

Lo que faltaba era el parentesco.

## Qué hereda, qué es propio y qué se copia

| | |
|---|---|
| **Hereda sin preguntar** | aplicativo (`id_tipo_negocio`) y rubro, país, paleta, colores, y los interruptores `permite_*` / `controla_inventario` / `asistente_mira_stock` / `muestra_iconos_productos`. Son decisiones de la empresa, no del local. También el NIT: es el mismo contribuyente. |
| **Propio de la sede** | nombre, dirección, teléfono, correo, `slug` (su URL pública), ficha fiscal, caja y **plan**. |
| **Se copia al nacer** | la configuración del vertical: carta/servicios, recetas, mesas, formas de pago, barrios, horario del local, puntos de caja y el ajuste de permisos por rol. |
| **No se copia nunca** | personal, stock, movimientos de caja, pedidos, citas, clientes y el canal de WhatsApp. |

### El plan es propio: se cobra aparte

Decisión tomada el 2026-10-09. Cada sede es un cliente pagador independiente, con su propio
`gener_negocio_plan` y su propia `cob_suscripcion`. Una sede puede estar al día y otra vencida.

La alternativa era un complemento «Sede adicional» sobre la suscripción de la matriz, con una sola
vigencia para todas. Se descartó: el plan propio no necesita nada nuevo en cobranza y funciona hoy.
El precio es que el cliente paga el plan completo por cada sede.

### Copia inicial, no catálogo compartido

Si la matriz sube un precio después, **la sede no se entera**. Es deliberado. Un catálogo en vivo
obligaría a que cada lectura resolviera «mi negocio o mi padre», y eso toca el POS, el inventario,
la vitrina y el asistente. Lo que la sede necesita de verdad es no volver a cargar 80 productos a
mano.

## Qué se tocó

### Base de datos

`npm run migrate:negocio-sede` (registrada con `node scripts/migrar.js negocio-sede`):

- `general.gener_negocio.id_negocio_padre` + `fk_gener_negocio_padre` (ON DELETE **RESTRICT**) +
  `ck_gener_negocio_padre_no_si_mismo` + índice parcial.
- **`UNIQUE (nit)` se acota a las matrices.** `gener_negocio_nit_key` bloqueaba la segunda sede,
  porque dos sucursales de la misma empresa comparten NIT. La unicidad no se tira: pasa a
  `uq_gener_negocio_nit_matriz`, único sobre `nit` *donde* `id_negocio_padre IS NULL`. La matriz
  sigue siendo la dueña del NIT y dos empresas distintas siguen sin poder compartirlo.

### Backend

| | |
|---|---|
| `app_core/sede/pasosDeClonado.js` | **Qué** se copia, por aplicativo. Declarativo. |
| `app_core/sede/clonarConfiguracion.js` | **Cómo** se copia. Fila a fila, traduciendo las FK. |
| `app_core/dao/sedeDao.js` | `crearSede`, `listarSedes`, `getMatriz`, `administradoresDe`. |
| `app_admin_api/controllers/sedeController.js` | `GET`/`POST /admin/negocios/:id/sedes` (super admin). |
| `negocioDao.getListaNegociosAdmin` | devuelve `id_negocio_padre`, `matriz_nombre`, `total_sedes`. |
| `negocioDao.contarSedesPorNegocio` | una sola consulta para toda la lista (sin N+1). |
| `loginDao` · `dashboardService` | `id_negocio_padre` viaja en la sesión, para etiquetar el selector. |
| `negocioCicloVidaService` | una matriz con sedes no se elimina (`SEDES_DEPENDIENTES`). |

### Frontends

- **`admin_app_v21`** → en Negocios, cada sede va sangrada bajo su matriz (`agrupados`), con
  etiqueta «Sede» / «N sedes», botón de sedes en la fila y un modal que lista y crea. El modal de
  eliminar avisa y deshabilita el botón si hay sedes.
- **`negocio_app`** → el selector del header distingue matriz de sede («Sede · de Pizzería Feliz»).

## El clonado, en detalle

### Lista de exclusión, no de inclusión

Cada paso dice qué **no** se copia. Las columnas de estas tablas no están iguales en todas las
bases —`migrate_restaurante_datos_pago.js` añade `datos_pago` a `rest_metodo_pago` y la base de
desarrollo no la tiene—, y una lista de inclusión se saltaría esa columna en producción sin decir
nada. Con la exclusión, una columna de configuración nueva viaja sola. El precio es acordarse de
excluir una columna nueva que lleve ESTADO en vez de configuración.

El ejecutor excluye siempre la PK, `id_negocio` y las cuatro columnas de fecha.

### Fila a fila, no `INSERT ... SELECT`

Un `INSERT ... SELECT` masivo sería más rápido pero no dice qué id nuevo le tocó a cada fila
vieja, y eso es lo que hace falta para traducir las FK: el producto clonado tiene que apuntar a la
categoría clonada. El orden de `RETURNING` sobre un `INSERT ... SELECT` no está garantizado por
Postgres, así que correlacionarlo por posición sería apostar. El volumen lo permite: una carta
grande son ~80 productos.

Medido contra la base de desarrollo **por el túnel SSH**: ~25 s para una carta de 20 productos,
11 insumos y 169 filas de permisos. Es latencia de red (~927 ms por ida y vuelta, ver
[`tests_tunel_latencia`]), no del código: en el VPS, con la base en `localhost`, son unas décimas.

### Columnas JSON

El driver devuelve una columna `jsonb` como objeto de JavaScript y el enlazador de Sequelize no
sabe convertirlo (`Invalid value { borde: ... }`). El ejecutor lee el tipo de
`information_schema` y esas columnas van al INSERT como texto con un `::jsonb` detrás.

### Cuando una FK no tiene equivalente

La matriz puede tener una **variante activa de un servicio que dio de baja**. El servicio no se
clona (los pasos filtran `estado = 'A'`), así que la variante se queda sin padre. Se distinguen dos
casos, y la distinción es la que importa:

- **El mapa del paso destino no existe** → ese paso no llegó a correr: es un error de **orden** en
  `pasosDeClonado.js`. Se lanza `SEDE_CLON_ORDEN_PASOS` y la sede no se crea.
- **El mapa existe pero esa fila no está** → lo apuntado quedó fuera a propósito. Si la columna
  admite NULL se queda en NULL; si no, la fila se salta entera. Queda un `console.warn` y el
  recuento viaja en el evento de auditoría del alta.

Lo que **nunca** se hace es dejar la FK apuntando a la fila de la matriz: eso sería una fuga entre
negocios.

### Otros detalles que no son obvios

- **`ical_token` de `reserva_unidad`** es único en toda la tabla y es lo que publica el calendario
  de esa unidad. Se omite para que lo regenere el `DEFAULT (gen_random_uuid())`: copiarlo daría a
  dos unidades el mismo calendario público.
- **El stock nace en 0** (`carta_ingrediente`, `reserva_producto`). La receta viaja; la bodega no.
- **El horario de una persona no viaja** (`rest_horario.id_usuario`, `reserva_horario.id_profesional`):
  solo el del local. El personal de la sede es otro.
- **El punto de caja** lleva `ON CONFLICT (id_negocio, nombre) DO NOTHING`, porque
  `asegurarCajaPrincipal` ya le dejó a la sede su «Caja principal» al crearla. Los rubros extra de
  la matriz sí entran.
- **La ficha fiscal no se copia**: la sede nace en modo `NINGUNO`. La resolución de facturación y
  el rango de numeración son por establecimiento.
- **`asegurarCajaPrincipal` solo corre si el aplicativo es RESTAURANTE**, resuelto por nombre.
  `reserva` lleva sus turnos en `reserva_caja` y no quiere una fila en `restaurante.rest_punto_caja`.

## Quién administra la sede

Tres modos, y el tercero es el normal:

1. `id_usuario_existente` — un usuario concreto.
2. `admin: { … }` — uno nuevo.
3. **Ninguno de los dos** — hereda los administradores de la matriz (`sedeDao.administradoresDe`).

El modo 3 deja fuera al usuario del asistente (`ASISTENTE-%`) y a quien tenga un rol **global**
—el super administrador—, porque esos ya lo ven todo y ocuparían un sitio del cupo de la sede sin
necesidad. Si la matriz no tiene ningún administrador que sea persona, se niega con
`SEDE_SIN_ADMIN` en vez de crear una sede que nadie puede abrir.

Ojo con el cupo: cada administrador heredado ocupa un sitio del plan **de la sede**
(`cupoUsuarios`).

## Lo que queda pendiente

- **WhatsApp.** `phone_number_id → id_negocio` es 1:1 (`intelligence/channels/whatsapp/numeros.js`).
  Hoy una sede nace sin canal y, si el cliente lo quiere, conecta otro número —con su propio costo
  de Meta—. La alternativa (un número para todas las sedes y el bot preguntando a cuál se dirige)
  está decidida **para después**: saca el `id_negocio` del número y lo mete en la conversación, que
  es justo lo que el [ADR-010](adr/ADR-010-ejecucion-segura.md) blinda.
- **Informes consolidados.** Cada sede informa lo suyo. No hay una vista «todas mis sedes juntas».
- **Desligar una sede.** Para eliminar una matriz hay que eliminar sus sedes; no hay un botón que
  convierta una sede en matriz independiente (sería un `UPDATE … SET id_negocio_padre = NULL`).
- **Verticales sin pasos de clonado.** Solo RESTAURANTE y RESERVA los tienen, que son los dos
  desplegados. Para otro, la consola avisa de que la sede nacería vacía y deja crearla igual.

## Un arreglo que vino de rebote

Al probar la eliminación salió un fallo **anterior a este trabajo y sin relación con sedes**:
eliminar **cualquier** negocio fallaba con «Las tablas del negocio se referencian en ciclo y no hay
orden seguro de borrado», y la previsualización tampoco se podía abrir.

La causa es `gener_negocio.id_metodo_pago_domicilio → rest_metodo_pago`, que llegó con
`migrate:restaurante-metodo-pago-domicilio` (en PROD desde el 2026-10-05) y cierra un ciclo con
`rest_metodo_pago.id_negocio → gener_negocio`. Ninguna de las dos tablas se podía borrar primero.

El arreglo: `construirPlan` detecta las FK que van **desde la fila del negocio hacia una tabla que
cuelga de él**, comprueba que admiten NULL y las saca del orden; `eliminarNegocio` las vacía en un
`UPDATE` antes de empezar a borrar. Vaciarlas no pierde nada porque la fila se va a borrar entera.
Si alguna vez una de esas FK fuera `NOT NULL` no se neutraliza y el borrado se sigue negando, que
es lo correcto.

El centinela es `__tests__/negocios/eliminar_orden.test.js`: solo lee el catálogo, así que corre
contra la base compartida, y falla el día que una FK nueva vuelva a romper el orden.

## Pruebas

```bash
npx jest __tests__/negocios/           # 6 suites · 63 pruebas
```

- `sede_pasos_clonado.test.js` — invariantes de `pasosDeClonado.js`: que ninguna tabla se clone dos
  veces, que cada `enlaces` apunte a una tabla clonada **antes**, que `autoEnlaces` apunte a su
  propia tabla, que ninguna columna esté en dos grupos a la vez, que no se cuele nada operativo y
  que el stock nazca en 0. Sin base de datos.
- `eliminar_orden.test.js` — que el orden de borrado siga siendo completo. Solo lectura.

El alta de verdad se probó a mano contra la base de desarrollo (sede de restaurante y de reserva,
herencia de administradores, bloqueo de la eliminación y borrado completo con la FK del domicilio
puesta). No está en la suite porque escribe filas, y la base de desarrollo es compartida: ver
[`desarrollo-local.md`](desarrollo-local.md).
