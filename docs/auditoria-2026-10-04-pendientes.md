# Auditoría EscalApp — pendientes para cerrar admin, restaurante y reserva

2026-10-04

> Copia en el repositorio del documento que vivía en el conector de Claude Docs
> (`claude.ai/artifact/Naq4gjBsABCDAjdvSZB5Ti`). Ese documento **se borró** el 2026-10-05 y ya no
> es legible; este archivo se reconstruyó íntegro desde la transcripción de la sesión, con las dos
> correcciones posteriores ya aplicadas (el apartado del JWT y el conteo del barrido: 54 endpoints,
> no 58). Las casillas siguen como estaban: lo hecho se lee en los dos apartados de «Avance» del
> final.

Producción funciona y tiene uso real —4 restaurantes, ~3.100 pedidos en 30 días—, pero tres
interruptores que faltan en el `.env` del VPS dejan apagadas la autorización multi-inquilino, el
límite de peticiones y el cobro automático. Eso, más 4 cuentas cuya contraseña sigue siendo la
cédula, es lo que hay que cerrar antes de vender a más clientes. El resto son huecos de producto,
listados por app.

## Lo que hay hoy en producción

El VPS de Vultr (45.63.105.95, Ubuntu 24.04, 955 MB de RAM, 41 % de disco) sirve los cuatro
proyectos, y lo desplegado coincide con el último commit de cada repo: no hay nada construido sin
subir. La base pesa 61 MB. Node v22.23.2, PostgreSQL 17, Caddy con TLS automático, `fail2ban`
activo.

El uso real está muy concentrado:

| Inquilino | Vertical | Plan | Uso en 30 días | Vence |
| --- | --- | --- | --- | --- |
| 6 · Zona Burger | Restaurante | Avanzado | 1.660 pedidos | 2026-10-26 |
| 13 · El Callejero | Restaurante | Básico | 950 pedidos | 2026-10-23 |
| 15 · ICONIC | Restaurante | Básico | 421 pedidos | 2026-10-09 |
| 12 · Pregonchos | Restaurante | Avanzado | 66 pedidos | sin fecha |
| 16 · D'ALEX BARBERIA | Reserva | Básico | 60 citas | 2026-10-09 |
| 10 · D'Alex Barberia | Reserva | Avanzado | 23 citas | sin fecha |
| 2 · PARKIN CR | Parqueadero | Básico | sin app | sin fecha |
| 7 · Mi Gimnasio | Gimnasio | Básico | sin app | sin fecha |
| 8 · Tienda Demo | Tienda | Básico (vencido) | sin app | 2026-06-14 |
| 14 · La Esquina del Barril | Restaurante | vencido | 0 pedidos | 2026-08-24 |

De aquí salen tres hechos que condicionan todo lo demás. **Restaurante es el producto**: 3.097 de
los 3.180 eventos de uso. **Reserva está sin validar de verdad**: 83 citas, y las dos fichas son el
mismo cliente duplicado (negocios 10 y 16). **Cuatro inquilinos tienen plan sin fecha de fin**, así
que nunca se les genera factura — entre ellos los dos de Plan Avanzado a $59.999.

## Seguridad — cerrar antes de vender a más clientes

Todo lo de aquí está verificado contra el `.env` y el código que corren hoy en el VPS, no contra la
documentación.

- [ ] **`AUTHZ_MODO` no está en el `.env` → la autorización multi-inquilino solo observa, no
  bloquea.** `app_core/middleware/authzNegocio.js:36` cae a `observacion` por defecto: audita el
  acceso a un negocio ajeno y *deja pasar*. El propio archivo lo llama «una vulnerabilidad activa
  hoy». **La buena noticia:** la medición que faltaba ya está hecha y está limpia — 1.710 eventos
  `authz/negocio_ajeno` entre el 11 y el 30 de septiembre, concentrados en **tres rutas y seis
  usuarios**, y nada nuevo desde el 30 de septiembre.
- [ ] **Investigar la causa de esas tres rutas y poner `AUTHZ_MODO=bloqueo`.** 1.705 de los 1.710
  eventos son `GET /restaurante/inventario/resumen`, y todos piden `id_negocio=12` desde usuarios
  que pertenecen a 16, 13, 6 y 15. El polling del encabezado
  (`negocio_app/src/app/layout/header.ts:177`) manda un `id_negocio` que no es el de la sesión. Las
  otras dos rutas son `GET /restaurante/perfil` (3) y `GET /restaurante/eventos` (2). Es un día de
  trabajo, no un proyecto.
- [ ] **Escalada de privilegios en el API de administración: las rutas de usuarios, roles, planes y
  negocios solo piden token, no super admin.** `app_admin_api/routes/index.js:269-280` monta sin
  `requireSuperAdmin`: `GET/POST /usuarios/admin`, `PUT /usuarios/admin/:id`,
  `PATCH /usuarios/admin/:id/estado`, `DELETE /usuarios/admin/:id` y
  `PUT /roles/admin/:id/permisos`. Los controladores tampoco comprueban nada — `listUsuarios`
  (`usuarioAdminController.js:187`) llama al DAO sin filtro de alcance. Con el token de un mesero de
  Zona Burger se puede listar los 62 usuarios de la plataforma, editar o suspender al super admin, y
  darse a sí mismo cualquier permiso. Lo mismo en línea 735: `POST/PUT /planes` deja a cualquier
  usuario autenticado cambiar el precio de los planes.
- [ ] **`RATE_LIMIT_ENABLED` no está en el `.env` → no hay límite de peticiones en ninguna ruta.** Se
  apagó al migrar a Vultr porque contaba por la IP de Caddy y agrupaba a todos los clientes en un
  cubo (`app.js:107`). El `CLAUDE.md` sigue diciendo «200/15min prod». Sin él, el login es fuerza
  bruta libre, y los únicos limitadores que sobreviven son los del portal de pagos. Rediseñarlo con
  clave por usuario o negocio en vez de por IP.
- [ ] **4 cuentas activas siguen con `debe_cambiar_password = true`, o sea con la cédula como
  contraseña.** El campo se escribe en el registro de prueba (`registroTrialService.js:182`) y lo
  devuelve el login (`loginDao.js:94`), pero **ningún frontend lo lee y ningún middleware bloquea la
  sesión**. En Colombia la cédula es el usuario *y* la contraseña, y es un dato fácil de conseguir.
  Con el límite de peticiones apagado, es la ruta de toma de cuenta más corta que hay.
- [ ] **Los frontends se sirven sin una sola cabecera de seguridad.** `helmet` protege el API (CSP,
  HSTS, X-Frame-Options), pero `escalapp.cloud` y `*.escalapp.cloud` devuelven solo `Server: Caddy`.
  La consola se puede meter en un iframe, no hay HSTS en el dominio principal, y el JWT vive en
  `localStorage` sin CSP que lo cubra. Se arregla con un bloque `header` en el `Caddyfile`.
- [ ] **`WHATSAPP_TOKEN_KEY` está vacía en el `.env` de producción.**
  `app_core/helpers/credencialCifrada.js:32` lanza sin ella: no se puede cifrar ni descifrar ninguna
  credencial. El alta de WhatsApp por coexistencia (*embedded signup*) no puede guardar el token de
  un cliente nuevo. Zona Burger quedó conectada, así que esto no se nota hasta el segundo cliente.
- [x] **El JWT dura 24 h y no se puede revocar.** Suspender a un usuario no invalida su sesión: sigue
  entrando hasta que el token caduque. **DESCARTADO COMO MEJORA (decisión del 2026-10-05):** los
  clientes de reserva abren la app desde el móvil y entran directo al dashboard, y esa facilidad
  vende. No se bajará la vigencia ni se añadirá revocación. Lo que falta es lo **contrario**: un
  token deslizante, porque hoy la sesión muere a las 24 h y obliga a un login diario.

## Continuidad y operación

- [ ] **Los respaldos existen pero viven en el mismo disco que la base.** `backup.sh` corre a las
  3:30 y guarda 360 MB en `/home/escalapp/backups`, con retención de 14 días. La copia externa está
  escrita pero nunca activada: el script pregunta por un remoto `rclone` llamado `backups` y, al no
  existir, escribe «AVISO: sin remoto rclone, backup solo LOCAL» y sigue. Si se pierde el disco, se
  pierden la base y sus respaldos a la vez. Configurar R2 o B2 es media hora.
- [ ] **Nadie ha restaurado un respaldo nunca.** Un `pg_restore` de prueba contra una base
  desechable, una vez, y anotado. Un respaldo sin restauración probada es una suposición.
- [ ] **No hay monitoreo ni alertas de ningún tipo.** Sin APM, sin Sentry, sin ping externo. Si
  `escalapp-api` se cae a las 2 de la madrugada, lo descubre el cliente. El *health check* es `GET /`
  y devuelve 200 sin tocar la base, así que ni detectaría una base caída. Falta un `/health` con
  `SELECT 1` y un monitor externo que avise.
- [ ] **Los errores del servidor solo se ven con `journalctl`.** Dos sin atender en la última semana:
  un `SyntaxError` por JSON mal formado llegando a un endpoint (2 de octubre) y
  `[canalGateway] Error entregando mensajes: read ECONNRESET`.
- [ ] **El correo transaccional sale de una cuenta personal de Gmail.** Hoy responde `SMTP OK`, pero
  el 29 de septiembre estuvo caído todo el día con
  `534-5.7.9 Application-specific password required` — y por ahí pasan los códigos OTP del registro
  de prueba, que es la entrada pública principal. Gmail limita a ~500 envíos diarios y no hay
  SPF/DKIM para `escalapp.cloud`. Mover a un proveedor transaccional (SES, Resend, Brevo).
- [ ] **Un solo proceso de Node, una sola máquina, 955 MB de RAM.** `systemd` lo reinicia si muere,
  pero no hay réplica ni plan de recuperación escrito. Con 61 MB de base y 41 % de disco no urge,
  pero conviene dejar el procedimiento anotado antes de necesitarlo.
- [ ] **`bullmq` está en las dependencias y no hay Redis instalado.** Si algún día se usa de verdad,
  falla en producción. Quitarlo o instalar Redis.

## El cobro todavía no funciona solo

Esta es la parte que decide si EscalApp es un SaaS o un favor. Hoy el dinero entra a mano.

- [ ] **`COBRANZA_AUTO_ENABLED` no está en el `.env` → el cron de cobro nunca corre.**
  `cobranzaScheduler.js:110` nace apagado a propósito, y nadie lo ha encendido. El arranque imprime
  «Cobro automático DESACTIVADO».
- [ ] **`cobranza.cob_metodo_pago` está vacía: cero tarjetas guardadas.** Aunque se encendiera el
  cron, no hay nada que debitar. Falta el flujo de «guardar medio de pago» (tokenización en Wompi /
  dLocal) y la pantalla donde el inquilino lo registra.
- [ ] **4 de 10 suscripciones tienen `proximo_cobro` en NULL y nunca entran al ciclo.** El SQL de
  `suscripcionesPorCobrar` exige `proximo_cobro IS NOT NULL`. Los negocios 2, 7, 10 y 12 tienen plan
  sin fecha de fin, así que nunca se les genera factura — y dos de ellos están en Plan Avanzado a
  $59.999. Son ~$174.000/mes que no se facturan.
- [ ] **No hay proceso de mora.** La factura 2 (negocio 14) está `pendiente` desde el 16 de
  septiembre por un período que cerró el 24, y no pasó nada: ni recordatorio, ni suspensión, ni
  aviso al super admin. El código lo dice explícitamente: «No suspende por tiempo», la suspensión
  sale solo de reintentos fallidos de tarjeta — que nunca ocurren porque no hay tarjetas.
- [ ] **No hay vista para crear ni editar planes y precios.** `POST/PUT /planes` existe en el API
  pero la consola solo lee el catálogo. Los 14 planes, la matriz `gener_plan_caracteristica` y los
  precios de complementos se mantienen por SQL o migración. Subir un precio hoy es editar la base a
  mano.
- [ ] **Hay 4 planes viejos (`Gratis`, `Emprendedor`, `Profesional`, `Empresarial`) y 8 paquetes de
  facturación que nadie usa.** `Gratis` sigue activo con precio 0 y es asignable. Limpiar el
  catálogo a lo que realmente se vende.
- [ ] **El cliente final del inquilino no puede pagar en línea.** Wompi y dLocal solo cobran
  *nuestra* mensualidad. En reserva, el anticipo de una cita se paga subiendo una foto del
  comprobante que el negocio aprueba a mano (`uploads/reserva/comprobantes`); en restaurante no hay
  pago en línea del pedido. Es el hueco de producto con más valor comercial — y la vía natural a una
  comisión por transacción.

## admin_app_v21 — la consola

Es la app más completa de las tres: 15 vistas, incluidas auditoría, cobranza, estadísticas, bandeja
de WhatsApp y Ficha 360. Lo que falta es menos producto y más cierre.

- [ ] **Vista de planes y precios.** Hoy no existe (ver sección de cobro). Es la pieza que falta para
  que la consola gobierne de verdad la suscripción.
- [ ] **Vista de mora / cartera accionable.** `GET /cobranza/cartera` ya existe y está protegida por
  super admin, pero no hay una pantalla que diga «estos 3 negocios deben, este es el botón para
  avisarles».
- [ ] **No hay onboarding para un inquilino nuevo.** El registro de prueba crea usuario, negocio y
  Plan Básico de 7 días, muestra la cédula como contraseña y suelta al cliente en el panel. Sin
  primeros pasos, sin lista de verificación, sin saber qué configurar primero. Con 7 días de prueba,
  el primer día decide la conversión.
- [ ] **No hay forzado de cambio de contraseña** (detallado en seguridad). Es la otra mitad del mismo
  flujo de alta.
- [ ] **Dos rutas siguen apuntando a un marcador de posición.** `admin-routing.ts:183`
  (`tipos-negocio/:tipoId/roles`) y `app.routes.ts` (`dashboard/negocio/:tipoId`) cargan el dashboard
  con un `TODO` desde hace meses. O se construyen o se borran del enrutador.
- [ ] **Limpieza de datos: el cliente D'Alex está duplicado** como negocio 10 y negocio 16, con
  planes distintos (Avanzado sin fecha / Básico que vence el 9 de octubre) y citas repartidas entre
  los dos. El WhatsApp activo está en el 10. Decidir cuál sobrevive y fusionar.
- [ ] **El negocio 14 está activo con el plan vencido desde el 24 de agosto** y 0 pedidos. O se
  recupera o se cierra, pero no debería seguir en el limbo.
- [ ] **No hay vista de soporte ni de incidencias.** Con clientes reales usando WhatsApp, los
  reportes llegan por mensaje directo y no quedan en ningún lado. Una bandeja mínima de tickets,
  aunque sea una tabla.

## negocio_app · restaurante — el producto que sí se usa

13 vistas (Dashboard, Pedidos, Despacho, Cocina, Mesas, Menú, Clientes, Caja, Inventario, Horarios,
Personal, Reportes, Configuración), 118 rutas de API y 3.097 pedidos en 30 días. El POS, la caja y el
asistente de WhatsApp están sólidos. Los huecos están todos del lado del costo y del cumplimiento.

- [ ] **El inventario no tiene compras ni proveedores.** `inventarioService.js` solo ofrece tres
  cosas: ver el resumen, ajustar a mano y restablecer a cero. No hay entrada de mercancía con costo,
  no hay proveedores, no hay conteo físico, no hay merma registrada como tal. Sin eso **el inventario
  no se valora y no hay costo de ventas**, que es la pregunta que de verdad le interesa a un
  restaurante.
- [ ] **Ningún reporte muestra utilidad ni margen.** Los cinco que hay (ventas por período, productos
  más vendidos, rendimiento de mesas, rendimiento de usuarios, estado de cocina) son todos de
  ingreso. Falta margen por producto, que depende del punto anterior.
- [ ] **Los reportes no separan por caja.** Las varias cajas se desplegaron el 23 de septiembre, pero
  `reporteService.js` no filtra por `id_punto_caja`. Un negocio con dos puntos no puede ver cómo le
  fue a cada uno.
- [ ] **Faltan reportes de domicilios, descuentos y anulaciones.** Tres cosas que mueven plata y hoy
  solo se ven pedido por pedido.
- [ ] **No hay propina.** Ni en el pedido, ni en la cuenta, ni en la caja, ni en el reparto entre
  meseros. En Colombia la propina voluntaria debe ir explícita en la cuenta (Ley 1935 de 2018), y el
  mesero quiere saber cuánto le toca. Es un hueco funcional y legal a la vez.
- [ ] **No hay promociones, combos ni cupones.** Cero rastro en el código. Solo existe el descuento
  manual por pedido. Un restaurante quiere 2x1, happy hour y combos.
- [ ] **No hay reserva de mesa.** El vertical de reserva existe y está construido, pero no está
  conectado a restaurante. Es la integración más obvia y más barata que tienes disponible.
- [ ] **El POS no funciona sin internet.** Sin *service worker* ni PWA en ninguna de las tres apps.
  Un POS que se detiene cuando se cae la conexión es un problema real en Colombia, y lo van a
  reportar en la primera caída.
- [ ] **«Personal» solo administra usuarios.** No hay turnos, ni asistencia, ni control de quién
  abrió y cerró cada día más allá de la caja.

## reserva_app — construido de más, validado de menos

22 vistas y 187 rutas de API, la superficie más grande de las tres apps: agenda, citas, clientes,
servicios, profesionales, horarios, caja, informes, productos, más los perfiles por rubro (mascotas,
recursos, ocupación, estancias, unidades) y un portal público con subdominio propio. Y 83 citas de un
solo cliente duplicado. El problema aquí no es que falte función: es que falta cliente y faltan dos
piezas que ese segmento pide primero.

- [ ] **No hay comisiones por profesional.** Es *la* función que pide una barbería o un salón: cada
  profesional cobra un porcentaje, y a fin de quincena hay que liquidarlo. Lo único que existe es
  `comision_productos_pct` en `reserva_config`, y es para la venta de productos. Los informes dan el
  total por profesional pero no liquidan nada.
- [ ] **El portal público recoge datos personales sin aviso de privacidad.** `/p/:id_negocio` pide
  nombre, teléfono, correo, notas y datos de mascota, y en algunos perfiles consentimientos firmados,
  sin un solo enlace a la política de tratamiento. La carta pública de restaurante sí lo tiene
  (`menu-publico.html:731`). Es el mismo arreglo, copiado.
- [ ] **Los informes no se pueden exportar.** `GET /informes` devuelve totales, serie por día, por
  profesional, por servicio, por estado, por hora y mejores clientes — y no hay forma de bajarlo.
  `clientes/exportar` sí existe; el informe no.
- [ ] **No hay lista de espera.** Cuando no hay cupo, el cliente se va. Es la función que convierte
  un «no hay turno» en una cita.
- [ ] **No hay citas recurrentes.** Cero rastro en el código. El cliente que va cada 15 días tiene
  que reservar cada vez.
- [ ] **El anticipo se cobra con foto de comprobante.** Detallado en la sección de cobro: es trabajo
  manual para el negocio y desconfianza para el cliente.
- [ ] **Los perfiles de alojamiento y estancias tienen 0 filas en producción.** `reserva_estancia`
  está vacía. Hotel, hotel de mascotas, unidades, temporadas, calendarios iCal, *check-in* y
  *check-out*: todo construido, nada validado con un cliente real. Antes de añadirle nada, conseguir
  un cliente de ese rubro o congelarlo.

## Ingeniería — deuda transversal

- [ ] **Jest no está instalado y no está en `devDependencies`.** Hay **114 suites y ~332 pruebas** en
  `admin_ws/__tests__`, con un `jest.config.js` cuidadosamente comentado, y `node_modules` no tiene
  jest. Ahora mismo la suite **no se puede correr** sin que `npx` lo descargue, sin versión fijada.
  Es una línea en `package.json` y es lo que más rendimiento da de toda esta lista.
- [ ] **No hay integración continua.** Ni `.github/workflows`, ni nada. Con dos desarrolladores y
  cuatro repos, cada despliegue depende de que alguien se acuerde de correr las pruebas que, además,
  no corren.
- [ ] **Los frontends apenas tienen pruebas.** 14 especificaciones para 15 vistas en admin, 20 para
  13 en negocio_app, **8 para 22 vistas en reserva_app**. Reserva es la app más grande y la menos
  probada.
- [ ] **Las migraciones son 130 scripts sueltos en `package.json`, sin registro de aplicadas.** Son
  idempotentes, lo cual salva, pero no hay forma de preguntarle a la base qué se corrió y qué no. Es
  la causa del «drift de entorno» que el `CLAUDE.md` ya advierte. Una tabla `schema_migrations` y un
  `migrate` que las corra en orden.
- [ ] **Cuatro ramas y tres árboles de trabajo abandonados:** `empaque-ui`, `feat/adquirir-plan`,
  `feat/complementos` (81 commits atrás), `fix/hora-chile` (15 atrás), más las carpetas `wt_emp2`,
  `wt_empaque`, `admin_ws-complementos` y `_prod_reserva`. El trabajo ya está fusionado; las carpetas
  sueltas son justo el riesgo que anotaste como «cambios pisados por git». Borrarlas.
- [ ] **El `CLAUDE.md` está desactualizado en lo que más importa.** Dice «Rate limit: 200/15min prod»
  cuando está apagado, y no menciona que `AUTHZ_MODO` ni `COBRANZA_AUTO_ENABLED` existen. La
  documentación que contradice al `.env` de producción es peor que no tenerla.
- [ ] **Hay 13 ADR con decisiones marcadas como abiertas o pendientes.** Vale una pasada para cerrar
  las que ya se decidieron de hecho.

## Legal y cumplimiento

- [ ] **Facturación electrónica: solo está la captura de datos fiscales.** Existe la vista, existe
  `gener_negocio_fiscal` con 10 filas, existe un documento de 80+ secciones y el ADR-026 — pero **no
  se emite nada**. Por ley, una cuenta sobre 5 UVT ($261.870 en 2026) exige factura electrónica, y
  cualquier cliente puede exigirla a cualquier monto. Tus propios documentos lo dicen sin rodeos: es
  «la mitad del requisito de entrada» al segmento de restaurantes que hoy no puedes cerrar. Es el
  pendiente más grande de la lista y el de mayor retorno comercial.
- [ ] **Aviso de privacidad en el portal de reserva** (ya listado arriba). Ley 1581 de 2012.
- [ ] **Propina voluntaria explícita en la cuenta** (ya listado arriba). Ley 1935 de 2018.
- [ ] **No hay exportación ni borrado de datos del titular.** Hay una ruta pública
  `/eliminacion-datos` que explica cómo pedirlo — Meta la exige — pero no hay proceso ni botón que lo
  ejecute. Si alguien lo pide, se hace por SQL.
- [ ] **Nosotros tampoco facturamos nuestras propias mensualidades.**
  `docs/obligaciones-escalapp.md` lo tiene documentado; el sistema no lo hace.

## Lo construido que nadie usa

Tres verticales tienen backend completo y **cero frontend**: parqueadero (51 rutas, 3 controladores,
hasta un trabajador y QR), gimnasio (42 rutas, 9 controladores: miembros, membresías, asistencia,
pagos, productos, ventas) y tienda (34 rutas, 7 controladores). Son **127 rutas de API** que nadie
puede usar porque no hay interfaz, y tres inquilinos — PARKIN CR, Mi Gimnasio, Tienda Demo — con plan
activo y nada que abrir.

La landing ya es honesta al respecto (dice explícitamente que Tienda no está en producción) y
`GET /admin/rubros` filtra bien: el registro de prueba solo ofrece rubros de restaurante y reserva.
Eso está bien resuelto. Pero la consola de super admin **sí** permite registrar un cliente en esos
tipos, y en la base siguen activos siete tipos de negocio sin módulo asociado, incluidos
`SUPERMERCADO`, `GESTION DE TALLER AUTOMOTRIZ`, `FONDO DE AHORROS` y `FINANCIERA DE PRESTAMOS`, que
no tienen ni backend.

- [ ] **Decidir, y que la decisión se vea en el código:** o se construye el frontend de uno de los
  tres, o se marcan `estado = 'I'` los tipos sin módulo y se archiva ese código. Mantener 127 rutas
  que nadie llama cuesta en cada refactor, en cada migración y en cada auditoría como esta.
- [ ] **Resolver los tres inquilinos huérfanos** (2, 7, 8): migrarlos, cerrarlos o dejarlos como
  demos explícitas y sin plan.
- [ ] **Perfiles de alojamiento y estancias en reserva** (ya listado): construidos, sin uso.
- [ ] **WebChat de Intelligence:** apagado a propósito en producción porque no está autenticado. Lo
  que falta — clave pública por negocio, orígenes permitidos, límite por sesión — sigue sin hacerse.
  Decidir si se cierra el hueco o se borra la superficie.

## Orden sugerido

Mi lectura: tienes un producto que funciona y se usa, montado sobre una base cuyos tres interruptores
de seguridad y cobro están en la posición permisiva. Eso es lo único que no puede esperar. Después,
facturación electrónica, porque es lo que desbloquea ventas. Lo demás se puede repartir.

| # | Qué | Por qué ahora | Esfuerzo |
| --- | --- | --- | --- |
| 1 | `requireSuperAdmin` en usuarios, roles, planes y negocios | Cualquier token edita al super admin hoy | 2-3 h |
| 2 | Instalar y fijar jest en `devDependencies` | 332 pruebas que no se pueden correr | 10 min |
| 3 | Forzar cambio de contraseña (4 cuentas con la cédula) | Toma de cuenta trivial sin límite de peticiones | medio día |
| 4 | Copia de respaldo fuera del servidor (rclone → R2/B2) | El respaldo está en el disco que protege | 30 min |
| 5 | Cabeceras de seguridad en el `Caddyfile` | Las apps con la sesión no tienen ninguna | 30 min |
| 6 | Causa de `inventario/resumen` → `AUTHZ_MODO=bloqueo` | La medición ya está hecha y limpia | 1 día |
| 7 | Rellenar `WHATSAPP_TOKEN_KEY` | El segundo cliente de WhatsApp no podrá conectar | 15 min |
| 8 | `/health` con `SELECT 1` + monitor externo | Hoy una caída la reporta el cliente | 2 h |
| 9 | Rediseñar el límite de peticiones por usuario | No por IP: Caddy las agrupa todas | 1 día |
| 10 | Cerrar el ciclo de cobro: medio de pago guardado, `proximo_cobro`, mora | ~$174.000/mes sin facturar y cero cobro automático | 1-2 semanas |
| 11 | Facturación electrónica DIAN | Media entrada al segmento que quieres | 4-6 semanas |
| 12 | Compras, proveedores y costo en inventario | Sin eso no hay margen ni costo de ventas | 2-3 semanas |
| 13 | Comisiones por profesional en reserva | Lo primero que pide una barbería | 1 semana |
| 14 | Propina en restaurante | Legal y esperada | 3-4 días |
| 15 | Aviso de privacidad en el portal de reserva | Ley 1581; copia de lo que ya hay en la carta | 2 h |
| 16 | Decidir parqueadero, gimnasio y tienda | 127 rutas que nadie puede llamar | 1 reunión |

Los primeros siete suman menos de tres días de trabajo y cambian el perfil de riesgo por completo. Yo
empezaría por ahí esta semana, y dejaría lo demás para planear con calma.

## Avance — primera tanda, 2026-10-04

Todo en ramas, con pruebas, **sin desplegar**. Nada de esto cambia lo que ve un cliente.

| Hecho | Dónde | Prueba |
| --- | --- | --- |
| Alcance por negocio en `/usuarios/admin/*` y `/roles/admin/*` | `app_core/authz/alcanceAdmin.js` | 17 nuevas |
| `requireSuperAdmin` en planes, roles, alta de negocios y paletas | `routes/index.js` | — |
| Límites de peticiones de vuelta, con números medidos | `app_core/middleware/limites.js` | 12 nuevas |
| La sesión guardada solo se restaura si es del token | `negocio_app` auth.service | 4 nuevas |
| `/health` que toca la base y responde 503 | `app.js` | — |
| `jest` instalado y fijado; `testTimeout` a 30 s | `package.json`, `jest.config.js` | quitó 12 rojos falsos |
| Registro de migraciones aplicadas | `general.gener_migracion` + `scripts/migrar.js` | probado en dev |
| `cuentas_tiquetera` arreglada (rota desde el 23-sep) | el test | 20/20 |

Dos cosas que valen más que su línea en la tabla:

**Encontré la causa de los 1.705 eventos de `authz`.** Las tres apps comparten origen y
`localStorage`, y `admin_app_v21` guarda su token bajo la misma clave `app_token` que `negocio_app`.
Entrar al panel y abrir `/restaurante` dejaba el token de una persona junto a la sesión guardada de
otra, y el encabezado se ponía a consultar el inventario del negocio equivocado cada 60 s. Con eso
corregido, **`AUTHZ_MODO=bloqueo` ya no tiene nada pendiente**: solo falta desplegar y activarlo.

**El registro de migraciones encontró drift el mismo día que se estrenó.** A la base de desarrollo le
faltaba `negocio-info-asistente`, que producción sí tiene. Eso causaba 10 de los 11 fallos de
`reactivacion.test.js`, que llevaban meses atribuidos al «test flaky». Aplicada y registrada: 27/28.

Las pruebas encontraron **dos errores de diseño míos** en el limitador, que una relectura no vio:
contar solo fallos deja barra libre en las rutas que mandan correo (responden 200), y meter la
identificación en la clave del cubo deja que quien prueba cédulas estrene cubo con cada una — el
agujero clásico, que yo mismo había documentado en el comentario y construí igual.

### Segunda tanda — la exposición entre inquilinos, demostrada

Audité los verticales, que en la primera tanda no había tocado. Los servicios de restaurante **no
comprueban la pertenencia**: `pedidoService`, `cuentaService` e `inventarioService` tienen cero
comprobaciones. No es un error de diseño —le toca al middleware— pero significa que toda la
separación entre inquilinos cuelga de `exigirPertenenciaNegocio`, que está en modo observación.

Lo probé con un token real en la base de desarrollo, usuario que pertenece a [2,4,5,6,10]:

| Petición | `observacion` (= PROD hoy) | `bloqueo` |
| --- | --- | --- |
| `GET /reserva/citas?id_negocio=44` | **200** | 403 |
| `GET /reserva/caja/historial?id_negocio=44` | **200** | 403 |
| `GET /restaurante/inventario/resumen?id_negocio=1` | **200** | 403 |
| `GET /restaurante/pedidos/abiertas?id_negocio=1` | **200** | 403 |

Los pedidos abiertos salieron con sus importes. Hoy, en producción, un token de cualquier inquilino
lee las citas y la caja de otro.

Y la mitad que llevaba dos meses frenando la activación: barrí **54 endpoints** de restaurante y
reserva (28 + 26) con el negocio propio del usuario, en modo bloqueo. **Cero rechazos indebidos.** Los
403 que salen son todos de dominio o de rol, ninguno de authz.

También cerré la causa raíz del desajuste de sesiones: `negocio_app` pasa a usar claves `negocio_*`
en vez de `app_*`, con migración silenciosa para que nadie pierda la sesión, y `admin_app_v21` recibe
el guard simétrico.

Hueco que conviene no olvidar: `extraerIdNegocio` **no mira un `:id` suelto**, así que activar
`bloqueo` no cubre las rutas donde el negocio viaja con ese nombre. Hoy se protegen a mano en su
controlador —verificado— pero no hay que creer que el modo bloqueo las cubre.

## Decisiones que siguen abiertas (al 2026-10-05)

Nada de lo de abajo se puede hacer sin tu visto bueno, porque todo toca producción.

1. **Desplegar los 8 commits** de las dos tandas. El único cambio visible para un cliente es que el
   límite de peticiones se enciende.
2. **Poner `AUTHZ_MODO=bloqueo`** en el `.env` del VPS. La evidencia está completa y el barrido salió
   limpio.
3. **Rellenar `WHATSAPP_TOKEN_KEY`**, que hoy está vacía y bloquea al siguiente cliente de WhatsApp.
4. **Aplicar las cabeceras de seguridad de Caddy** (`_despliegue/caddy-cabeceras-seguridad.md`).
   Pregunta abierta: ¿algún inquilino incrustó su carta en su propio sitio? Eso decide
   `X-Frame-Options`.
5. **Respaldo fuera del servidor**: hace falta que crees el bucket (R2 o B2) y me pases las
   credenciales.
6. **Contraseña del PostgreSQL local** (`scram-sha-256` en `pg_hba.conf`), para dejar de depender del
   túnel y saber si hay errores reales escondidos bajo su latencia.

Y una pregunta pendiente sobre reserva: ¿tus clientes de D'Alex ven un login por la mañana y
simplemente no te lo han mencionado, o de verdad llevan días sin escribir la contraseña? Si es lo
segundo, hay algo en el flujo que no he encontrado y prefiero buscarlo antes de tocar nada. De la
respuesta depende si el token deslizante es una función nueva o el arreglo de algo ya existente.
