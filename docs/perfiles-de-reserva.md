# Perfiles de rubro en `reserva`: un motor, siete formas de trabajar

**Estado:** **implementado (fases 0–5) en local y en `escalapp_dev`, sin desplegar** — ver §11 ·
**Fecha:** 2026-09-17 ·
**Parte de:** [`rubros-de-reserva.md`](rubros-de-reserva.md) (el diagnóstico; esto es el plan) ·
**Relacionado:** [ADR-003](adr/ADR-003-madurez-esquemas.md) · [ADR-005](adr/ADR-005-independencia-verticales.md) ·
[Venta de productos](productos-en-reserva.md) (la función `productos`, 2026-09-28)

> **Lo pedido:** que `reserva_app` se adapte al tipo de negocio elegido al crearlo —salón de belleza,
> mascotas, alojamientos, spa, tatuadores, centros de estética— y que **la barbería siga funcionando
> exactamente como hoy**.
>
> **Decisión que cambia el diagnóstico anterior:** alojamientos **entra** en `reserva`. Lo que sigue
> sin negociarse es cómo: como un **segundo motor** (`ESTANCIA`) al lado del de citas, nunca
> forzando habitaciones dentro de `reglasAgenda.js`. §2.3 explica por qué esa frontera es la que
> protege a la barbería.

---

## 1. La idea en una frase

**El motor es uno y se activa con datos; el perfil del rubro solo decide qué se ve, cómo se llama y
con qué valores arranca.**

Una barbería no «tiene apagado» el tiempo de proceso: sus servicios tienen `proceso_min = 0`, y con
cero el motor calcula exactamente lo mismo que hoy. El perfil de salón no «enciende» nada en el
motor: **muestra el campo** para que la estilista pueda ponerle 45 minutos a la coloración.

Esa distinción es la que hace posible la garantía de §3. Si las particularidades fueran ramas
(`if (rubro === 'SALON')`) repartidas por los servicios, cada rubro nuevo sería un riesgo para los
anteriores. Si son **datos con un valor neutro**, la barbería queda protegida por construcción.

---

## 2. Arquitectura

### 2.1 Tres capas, de lo estable a lo que cambia

| Capa | Qué es | Dónde vive | Quién la cambia |
|---|---|---|---|
| **Modo de reserva** | El motor: `CITA` (hueco intradía con profesional) o `ESTANCIA` (noches sobre unidades) | Código, `app_reserva_api/services/` | Nosotros, rara vez |
| **Perfil de rubro** | Qué modos usa, qué capacidades se muestran, cómo se llaman las cosas, valores de arranque | Registro en código `app_reserva_api/perfiles/` | Nosotros, al abrir un rubro |
| **Configuración del negocio** | Los valores reales: su buffer, su depósito, sus servicios | `reserva_config` + catálogo | El dueño |

`gener_tipo_negocio` gana una columna nullable `perfil_reserva` (`'SALON'`, `'SPA'`…): así cada
rubro de `migrate_rubros_negocio.js` declara su perfil en la misma fila donde ya declara su icono y
su módulo. **`NULL` = perfil `BASE`**, que es la barbería de hoy.

### 2.2 Las capacidades se activan con datos, no con interruptores

| Capacidad | Se activa cuando… | Valor neutro | Con el valor neutro |
|---|---|---|---|
| **Tiempo de proceso** | `reserva_servicio.proceso_min > 0` | `0` | el motor ocupa la cita entera, como hoy |
| **Variantes** | el servicio tiene filas en `reserva_servicio_variante` | ninguna | duración y precio del servicio, como hoy |
| **A cotizar** | `reserva_servicio.a_cotizar = true` | `false` | precio del catálogo, como hoy |
| **Depósito parcial** | `reserva_config.deposito_pct > 0` | `0` | `cobro_adelantado` todo-o-nada, como hoy |
| **Recurso** (cabina, equipo) | `reserva_servicio.id_tipo_recurso` no nulo | `NULL` | no se consulta ningún recurso |
| **Mascota** | `reserva_cita.id_mascota` no nulo | `NULL` | cita como hoy |
| **Ficha** | hay filas en `reserva_ficha` | ninguna | no existe |
| **Consentimiento** | `reserva_servicio.requiere_consentimiento = true` | `false` | nada |
| **Estancia** | el perfil incluye el modo `ESTANCIA` | — | sus rutas responden 403 |

El perfil lista `capacidades: [...]` y eso decide **qué campos pinta el frontend**. El backend no
necesita comprobar el perfil para las ocho primeras: un valor puesto por API en una barbería no
rompe nada, solo hace lo que dice. La novena sí se protege con un middleware `exigirModo('ESTANCIA')`,
porque son rutas enteras.

### 2.3 Por qué `ESTANCIA` es otro motor y no un truco sobre el de citas

`intervalosLaborales()` arma los huecos de **un día** desde `reserva_horario.dia_semana`. Una
estancia de tres noches no cabe en esa forma, y meterla obligaría a que la función que calcula las
horas de la barbería aprendiera de noches, temporadas y check-out. Eso es tocar el corazón del
negocio que ya factura para habilitar uno que todavía no.

Por eso `ESTANCIA` vive en `services/estancia/` con su propia regla, sus propias tablas y sus propias
rutas. **Comparte** lo que de verdad es común —clientes (`persona_negocio`), caja, formas de pago,
vitrina, permisos, usuarios, marca— y **no comparte** el cálculo de disponibilidad. La ruta de citas
nunca importa el módulo de estancias.

> **Actualización (2026-09-20, §11.4):** el cuidado de mascotas se quedó en citas. Un hotel canino
> se da de alta como **Hospedaje**. Lo que sigue es el razonamiento original.

Un beneficio que no se buscaba: el **hotel canino** y la **guardería de día** son estancias (noches o
días sobre cupos), así que el mismo motor sirve a mascotas sin costo extra.

### 2.4 Cómo llega el perfil a la app

`dashboardService` ya arma la sesión con `colores`, `pais` y `moneda` para pintarlos en el primer
render. El perfil viaja igual:

```js
// en cada negocio de la sesión
rubro:  { nombre: 'SALON DE BELLEZA', etiqueta: 'Salón de belleza' },
perfil: { clave: 'SALON', modos: ['CITA'], capacidades: ['proceso', 'variantes', 'ficha'],
          terminos: { profesional: 'Estilista', profesionales: 'Estilistas' } },
```

En el frontend, `auth.service` expone `perfil = computed(...)` con **fallback a `BASE`** cuando la
sesión no lo trae (las sesiones guardadas en `localStorage` antes del despliegue no lo tendrán).

Las vistas propias de un rubro (Mascotas, Unidades, Tarifas, Ocupación, Fichas) se siembran como
`gener_nivel` del módulo `RESERVA` y `getPermisosVistaNegocio` **las quita** si el perfil no las
incluye. Filtrar en el backend y no en el sidebar hace que guard, menú y API digan lo mismo —«ausente
es denegado», la regla que ya rige la sesión. Ojo: `APP_ROUTE_PRIORITY` en `auth.service.ts` tiene
que listar las rutas nuevas, su propio comentario lo advierte.

### 2.5 Términos: un diccionario de cinco palabras, no una traducción

La app ya habla en genérico (`rubros-de-reserva.md` §1.2). Solo se cambia una palabra cuando **la de
siempre es incorrecta** para el oficio, no para darle color. Cinco claves: `profesional`,
`profesionales`, `servicio`, `cita`, `cliente`. Un pipe `termino` y un `computed` en el sidebar.

Se aplica **donde el cliente final o el dueño lo leen primero**: sidebar, títulos de vista, vitrina
pública, confirmaciones y mensajes de WhatsApp. No se persigue cada una de las 435 apariciones de
«profesional» en la app: un botón interno que dice «Profesional» en un spa no le cuesta un cliente a
nadie, y reemplazarlas todas es semanas de trabajo con riesgo de romper plantillas.

### 2.6 El catálogo de arranque es opcional, y se ofrece

Cada perfil trae categorías y servicios típicos. **No** se crean solos al registrar el negocio —datos
que el dueño no pidió son datos que tiene que borrar—: el estado vacío de Servicios ofrece
«Cargar servicios típicos de salón». Un clic, editable después.

Los **valores de configuración** del perfil sí se aplican solos, pero **solo cuando se crea la fila**
de `reserva_config`, que hoy nace perezosamente en `configService.get()` y en
`disponibilidadService.getConfig()`. Consecuencia buscada: **ningún negocio existente cambia de
valores**. Hay que unificar esos dos `create` en uno antes de tocarlos, o el perfil se aplicará en uno
y no en el otro.

---

## 3. La garantía de la barbería

«Que funcione tal cual» se convierte en seis reglas verificables:

1. **El perfil `BASE` es la barbería de hoy**: mismos términos, mismas vistas, ninguna capacidad
   nueva expuesta. `BARBERIA`, `CONSULTORIO`, los negocios con `id_tipo_negocio = BARBERIA` anteriores
   a los rubros, y cualquier rubro sin `perfil_reserva` caen en `BASE`.
2. **Toda columna nueva es nullable o nace en su valor neutro** (tabla §2.2). Ninguna migración
   reescribe filas existentes.
3. **Prueba dorada del motor antes de tocarlo.** Se congela la salida de `calcularSlots`,
   `diasDisponibles` y `verificarReservable` sobre un fixture de barbería (buffers, bloqueos, holds,
   combos) y se exige idéntica después de cada cambio en `reglasAgenda.js`. Se escribe **primero**, en
   `__tests__/reserva/`.
4. **`ESTANCIA` no se importa desde la ruta de citas.** Se comprueba igual que ADR-005 comprueba la IA:
   un grep en CI.
5. **Orden de despliegue**: migración → backend → frontend. El frontend tolera la sesión sin
   `perfil`; el backend tolera un frontend viejo porque todos los campos nuevos son opcionales.
6. **ADR-003 ya aplica**: `reserva` tiene cliente en producción desde el 2026-09-09. Todo lo de este
   plan es aditivo, así que cumple el régimen del Grupo 1 sin pedir excepción.

---

## 4. Lineamientos por tipo de negocio

Cada ficha dice qué es distinto respecto a la barbería. Lo que no se menciona, funciona igual. Los
valores de configuración son **punto de partida**: se validan con el primer cliente real de cada
rubro.

### 4.0 Barbería — perfil `BASE` (la referencia, no cambia)

| | |
|---|---|
| Rubros | Barbería · Consultorio · cualquiera sin perfil |
| Modo | `CITA` |
| Términos | Profesional · Servicio · Cita · Cliente |
| Capacidades nuevas | ninguna |
| Config | anticipación 1 h · buffer 10 min · cancelación 4 h · paso 15 min · sin depósito |
| Roles | Administrador · Recepcionista · Profesional (los de hoy) |

### 4.1 Salón de belleza — perfil `SALON`

| | |
|---|---|
| Rubros | Salón de belleza · Peluquería · Uñas |
| Modo | `CITA` |
| Términos | **Estilista / Estilistas**; el resto igual |
| Capacidades | **tiempo de proceso** · **variantes** (largo de cabello: corto/medio/largo cambia precio y duración) · **ficha** (fórmula de color por clienta) · depósito disponible, apagado |
| Config | anticipación 2 h · buffer 10 · cancelación 12 h · paso 15 · depósito 0 % |
| Vistas extra | ninguna; la ficha se ve dentro del cliente |
| Catálogo de arranque | Cabello · Color · Tratamientos · Uñas · Cejas y pestañas · Maquillaje |
| Acción nueva | `informes_ver_propios` (estilista a comisión ve lo suyo) |

**Lo que decide la venta:** el tiempo de proceso. Tinte = 30 min aplicando + 45 de espera + 30 de
lavado; durante los 45 la estilista atiende a otra persona. Sin esto el sistema le ofrece menos
horas de las que tiene. Se modela con dos números en el servicio: `proceso_desde_min` (cuándo empieza
la espera) y `proceso_min` (cuánto dura). `intervalosOcupados` deja libre ese tramo **del
profesional**; la clienta sigue ocupando su cita entera.

**No hacer:** reservar dos profesionales para un servicio (color + corte con personas distintas). Es
otra dimensión del motor y ningún salón pequeño la exige para empezar.

### 4.2 Spa — perfil `SPA`

| | |
|---|---|
| Rubros | Spa (el actual «Spa y estética») · Masajes |
| Modo | `CITA` |
| Términos | **Terapeuta / Terapeutas** · **Tratamiento** en vez de servicio |
| Capacidades | **recurso** (cabinas) · **depósito** · ficha (contraindicaciones) |
| Config | anticipación 4 h · buffer 15 (preparar cabina) · cancelación 24 h · paso 30 · depósito 30 % |
| Vistas extra | **Recursos** (cabinas y su capacidad) |
| Catálogo de arranque | Masajes · Faciales · Corporales · Circuitos · Rituales |

**Lo que decide la venta:** el depósito; un spa pierde mucho con una inasistencia de 90 minutos.
**La cabina** es la restricción real cuando hay más terapeutas que salas, pero un spa con tantas
cabinas como terapeutas no la necesita: se puede vender antes de tenerla.

**No hacer (todavía):** masajes en pareja (dos terapeutas + una cabina doble a la vez) y bonos de
sesiones. Los dos son reales y los dos son un motor más complejo; entran cuando un cliente los pida.

### 4.3 Centro de estética — perfil `ESTETICA`

| | |
|---|---|
| Rubros | **Centro de estética** (rubro nuevo, separado de spa) |
| Modo | `CITA` |
| Términos | **Especialista / Especialistas** · **Tratamiento** |
| Capacidades | **ficha** · **consentimiento informado** · **recurso** (el equipo de láser es uno y lo comparten todas) · depósito · variantes (zona del cuerpo) |
| Config | anticipación 12 h · buffer 15 · cancelación 24 h · paso 15 · depósito 30 % |
| Vistas extra | **Fichas** · **Recursos** |
| Catálogo de arranque | Valoración (gratuita, 20 min) · Faciales · Depilación láser · Corporales · Aparatología |
| Acciones nuevas | `ficha_ver` · `ficha_editar` — **no** para Recepcionista por defecto |

**Aquí hay obligación legal, no solo producto.** Contraindicaciones, alergias y tratamientos son
**datos sensibles** (salud) según la Ley 1581 de 2012. Eso pide: autorización expresa del titular,
acceso restringido por permiso (por eso `ficha_ver` no se da a Recepcionista), y auditoría —
`reserva_ficha` lleva `trg_audit` desde su migración. Consultar con quien lleve lo legal antes de
vender el rubro; mientras tanto, el copy vende **agenda**, no «historia clínica».

**No hacer:** llamarlo «historia clínica» ni «paciente». Son términos con régimen propio.

### 4.4 Tatuador — perfil `TATUAJE`

| | |
|---|---|
| Rubros | **Tatuajes y perforaciones** (rubro nuevo) |
| Modo | `CITA` |
| Términos | **Artista / Artistas** · **Sesión** en vez de cita |
| Capacidades | **a cotizar** · **depósito** (no reembolsable) · **consentimiento** (mayoría de edad, salud) · ficha (imagen de referencia del diseño) |
| Config | anticipación 24 h · buffer 30 (esterilización) · cancelación 48 h · paso 30 · depósito 30 % |
| Vitrina | **portafolio por artista** (galería de fotos; hoy el profesional tiene una sola `foto_url`) |
| Catálogo de arranque | Valoración / cotización (gratuita) · Tatuaje pequeño · Sesión por horas · Perforación · Retoque |

**Lo que decide la venta:** depósito + a cotizar. El flujo real es: valoración gratis → el artista
fija precio y duración → la sesión se agenda **con seña pagada**. `a_cotizar` hace que el precio y la
duración se fijen en la cita y no en el catálogo (el snapshot de `reserva_cita_servicio` ya existe
para eso). El cliente reserva la valoración en la vitrina; la sesión la agenda el artista.

**Es el rubro más barato de abrir** después de salón: comparte casi todo con él.

### 4.5 Cuidado de mascotas — perfil `MASCOTAS`

| | |
|---|---|
| Rubros | **Peluquería canina / Spa de mascotas** · luego **Hotel y guardería canina** |
| Modo | `CITA` (baño, corte, uñas) · `ESTANCIA` cuando exista (hotel, guardería de día) |
| Términos | **Groomer / Groomers**; cliente sigue siendo cliente (el nombre que importa es el de la mascota) |
| Capacidades | **mascota** (obligatoria en la cita) · **variantes por tamaño** (pequeño/mediano/grande/gigante) · ficha (vacunas, alergias, temperamento) |
| Config | anticipación 2 h · buffer 15 · cancelación 12 h · paso 30 · sin depósito |
| Vistas extra | **Mascotas** (también dentro de la ficha del cliente) |
| Catálogo de arranque | Baño · Baño y corte · Corte de uñas · Limpieza de oídos · Deslanado |

**La entidad nueva es `reserva_mascota`**, colgada de `persona_negocio`: nombre, especie, raza,
tamaño, peso, fecha de nacimiento, temperamento, notas. En el diagnóstico anterior propuse un
`reserva_sujeto` genérico; lo descarto: el otro caso que lo justificaba (el paciente de consultorio)
casi siempre **es** el cliente, y un sujeto genérico con atributos en JSON impide responder «¿cuántos
baños de perro grande hicimos?», que es el informe que el negocio quiere. Columnas concretas.

**El tamaño es a la vez atributo de la mascota y variante del servicio.** Al elegir la mascota, la
cita propone la variante de su tamaño; así el precio sale solo y el recepcionista no lo adivina.

**Estancia para mascotas** (fase 5): el hotel canino es una estancia por noches sobre «cupos»; la
guardería, una estancia por días. Exige carné de vacunas vigente (archivo en la ficha).

### 4.6 Alojamiento — perfil `ALOJAMIENTO`

| | |
|---|---|
| Rubros | **Hotel · Hostal · Cabañas / Glamping · Apartamentos turísticos** (una fila o varias, mismo perfil) |
| Modo | **`ESTANCIA`** únicamente |
| Términos | **Reserva** en vez de cita · **Huésped** en vez de cliente · **Tipo de habitación** en vez de servicio |
| Vistas | **Ocupación** (tablero unidades × días) · **Reservas** · **Unidades** · **Tarifas** · Clientes · Caja · Informes · Usuarios · Configuración. **Sin** Agenda, Servicios, Profesionales ni Horarios |
| Config propia | check-in 15:00 · check-out 12:00 · mínimo 1 noche · anticipo 50 % · cancelación 72 h |
| Roles | Administrador · Recepcionista. «Profesional» no aplica: el perfil lo oculta al asignar roles |
| Acciones nuevas | `estancias_checkin` · `estancias_checkout` · `tarifas_editar` · `depositos_devolver` |

**Modelo mínimo:** `reserva_unidad_tipo` (nombre, capacidad de huéspedes, tarifa base, mínimo de
noches) · `reserva_unidad` (la habitación concreta) · `reserva_tarifa_temporada` (desde, hasta,
precio) · `reserva_estancia` (unidad, `fecha_entrada DATE`, `fecha_salida DATE`, huéspedes, estado,
monto, anticipo, `id_persona_negocio`, `id_mascota` nullable para el hotel canino).

**Fechas `DATE`, no `timestamp`**: una noche no tiene hora ni zona horaria, y así se esquiva todo el
manejo de Bogotá del motor de citas. **El sobrecupo se impide en la base, no en el código**:

```sql
EXCLUDE USING gist (id_unidad WITH =, daterange(fecha_entrada, fecha_salida) WITH &&)
  WHERE (estado IN ('pendiente', 'confirmada', 'en_curso'))
```

Necesita la extensión `btree_gist` (viene con PostgreSQL 17; hay que crearla en local y en el VPS).
Es la misma lección de `reglasAgenda.js` llevada un paso más allá: la regla que no se puede romper
vive en un solo sitio, y ese sitio es la base.

**Lo que decide la venta, y hay que decirlo claro:** la **sincronización con Airbnb y Booking**. Casi
todo alojamiento pequeño ya publica ahí. Sin sincronizar, una cabaña reservada en Airbnb sigue libre
en EscalApp y se vende dos veces. La versión mínima honesta es **importar el calendario iCal** de cada
canal cada 15 minutos y convertirlo en bloqueos de la unidad (y exportar el nuestro). Sin eso, el
rubro solo sirve a quien **no** está en esas plataformas, que es poca gente.

**Obligaciones a verificar antes de vender:** en Colombia los prestadores de alojamiento turístico
tienen deberes de Registro Nacional de Turismo y de registro de huéspedes (Tarjeta de Registro
Hotelero). Hay que confirmar su alcance exacto; no prometer en el copy que EscalApp los cumple por el
negocio.

**Es el rubro más caro de los seis**: vistas nuevas (el tablero de ocupación no se parece a la
agenda), motor nuevo, vitrina con búsqueda por fechas y huéspedes, y la sincronización.

---

## 5. Matriz resumen

| | Barbería | Salón | Spa | Estética | Tatuaje | Mascotas | Alojamiento |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Modo | CITA | CITA | CITA | CITA | CITA | CITA (+EST.) | ESTANCIA |
| Tiempo de proceso | | ● | | | | | |
| Variantes | | ● | | ○ | | ● | |
| A cotizar | | | | | ● | | |
| Depósito parcial | | ○ | ● | ● | ● | | ● |
| Recurso | | | ● | ● | | | |
| Mascota | | | | | | ● | ○ |
| Ficha | | ○ | ○ | ● | ○ | ● | |
| Consentimiento | | | | ● | ● | | |
| Portafolio | | | | | ● | | |
| Sincronización iCal | | | | | | | ● |

● imprescindible para vender · ○ útil, no bloquea

**C1 a C3 del diagnóstico (proceso, depósito, variantes) sirven a cinco de los siete.** Por eso van
primero.

---

## 6. Cambios de datos (todos aditivos)

| Tabla | Cambio | Para |
|---|---|---|
| `general.gener_tipo_negocio` | `+ perfil_reserva VARCHAR(20) NULL` | que cada rubro declare su perfil |
| `reserva.reserva_config` | `+ deposito_pct SMALLINT DEFAULT 0` · `+ deposito_reembolsable BOOLEAN DEFAULT true` | depósito |
| `reserva.reserva_servicio` | `+ proceso_desde_min INT DEFAULT 0` · `+ proceso_min INT DEFAULT 0` · `+ a_cotizar BOOLEAN DEFAULT false` · `+ requiere_consentimiento BOOLEAN DEFAULT false` · `+ id_tipo_recurso INT NULL` | proceso, cotizar, consentimiento, recurso |
| `reserva.reserva_servicio_variante` | **nueva** (servicio, nombre, duración, precio, orden, estado) | variantes |
| `reserva.reserva_cita_servicio` | `+ id_variante INT NULL` | variantes (el snapshot ya existe) |
| `reserva.reserva_cita` | `+ monto_deposito DECIMAL NULL` · `+ id_mascota UUID NULL` · `+ id_recurso INT NULL` | depósito, mascota, recurso |
| `reserva.reserva_pago_cita` | `+ tipo VARCHAR(10) DEFAULT 'pago'` (`'abono'`) | que el depósito sea un pago más y cuadre en caja |
| `reserva.reserva_mascota` | **nueva** · `trg_audit` | mascotas |
| `reserva.reserva_ficha` | **nueva** (cliente, mascota, cita, tipo, contenido, archivo) · `trg_audit` | ficha y consentimiento |
| `reserva.reserva_tipo_recurso` / `reserva_recurso` | **nuevas** | cabinas y equipos |
| `reserva.reserva_unidad_tipo` / `reserva_unidad` / `reserva_tarifa_temporada` / `reserva_estancia` | **nuevas** · `trg_audit` en estancia · `EXCLUDE` | estancia |
| `reserva.reserva_calendario_externo` | **nueva** (unidad, url iCal, última sincronización) | Airbnb / Booking |

Cada migración: una transacción, guardas `information_schema`, idempotente, `migrate:<nombre>` en
`package.json`, y **corrida en el VPS antes del frontend**.

---

## 7. Cambios por capa

**Backend (`admin_ws`)**
- `app_reserva_api/perfiles/` — registro de perfiles (`BASE`, `SALON`, `SPA`, `ESTETICA`, `TATUAJE`,
  `MASCOTAS`, `ALOJAMIENTO`) + `resolverPerfil(idNegocio)`.
- `dashboardService` — `rubro` y `perfil` en la sesión; `getPermisosVistaNegocio` filtra vistas por
  perfil.
- `configService` — un solo punto de creación de `reserva_config`, que aplica los valores del perfil.
- `reglasAgenda` — tiempo de proceso y recurso en `intervalosOcupados` (con la prueba dorada delante).
- `cobroService` / `citaService` — depósito parcial, variantes, a cotizar, mascota.
- `services/estancia/` + rutas `/reserva/estancias`, `/unidades`, `/tarifas` con `exigirModo`.
- `migrate_rubros_negocio.js` — rubros nuevos con su perfil; **sembrados con `id_tipo_modulo = NULL`
  hasta que su fase se despliegue**, porque un rubro con módulo aparece solo en la landing
  (`getRubros()`) y vendería algo que no existe.

**Frontend (`reserva_app`)**
- `auth.service` — `perfil` computed con fallback `BASE`; `APP_ROUTE_PRIORITY` con rutas nuevas.
- Pipe `termino` + sidebar con etiquetas e icono del perfil (hoy Servicios usa `scissors`).
- Campos condicionados por `perfil.capacidades` en Servicios, formulario de cita, Configuración.
- Vistas nuevas: Mascotas, Fichas, Recursos; y para estancia: Ocupación, Reservas, Unidades, Tarifas.
- Vitrina: términos del perfil; portafolio (tatuaje); búsqueda por fechas (alojamiento).

**Asistente (`intelligence`)**
- Arreglar la lista blanca `TIPOS_NEGOCIO` y leer `id_rubro` en `contextoNegocio`
  (`rubros-de-reserva.md` §6).
- El flujo de citas **se apaga** para perfiles sin modo `CITA`: hoy un alojamiento recibiría horas.
- Mascotas: el flujo pregunta por la mascota. Estancia: flujo propio, fase tardía.

**Consola y landing (`admin_app_v21`)** — nada estructural: los rubros ya salen de `getRubros()`.
Solo iconos nuevos en `landing.component.ts` (se registran uno a uno y no fallan al compilar).

---

## 8. Fases

| Fase | Qué | Abre | Orden de magnitud |
|---|---|---|---|
| **0** | Prueba dorada del motor · arreglos del asistente (§6 del diagnóstico) · unificar la creación de `reserva_config` | nada visible; protege lo que hay | 2–3 días |
| **1** | Perfiles: columna, registro, sesión, filtro de vistas, términos, catálogo de arranque | Salón y Spa con su idioma | 1 semana |
| **2** | Tiempo de proceso · variantes · depósito parcial · a cotizar | **Salón completo, Tatuaje** | 2–3 semanas |
| **3** | Mascota · ficha · consentimiento | **Mascotas (grooming), Estética** | 2 semanas |
| **4** | Recursos (cabinas, equipos) | **Spa y Estética completos** | 1–2 semanas |
| **5** | Motor `ESTANCIA` · vistas · vitrina por fechas · iCal | **Alojamiento, Hotel canino** | 5–7 semanas |

Las estimaciones son para una persona a tiempo completo y sirven para comparar fases entre sí, no
como compromiso. Cada fase se despliega sola y deja a la barbería igual.

**Por qué este orden:** las fases 2 y 3 abren cuatro rubros con cambios pequeños sobre el motor que
ya existe. La 5 cuesta lo mismo que todas las anteriores juntas y abre uno y medio. Si el mercado
empuja hacia alojamiento, se puede adelantar —no depende de 2, 3 ni 4—, pero entonces conviene
conseguir primero **un cliente de alojamiento dispuesto a probarlo**, porque es el rubro donde más
fácil es construir lo que nadie usa.

---

## 9. Decisiones pendientes

1. **¿Qué rubro se vende primero?** El plan asume salón (mercado más grande, ya ofrecido). Si hay un
   cliente concreto esperando en otro rubro, ese manda.
2. **¿Un negocio puede usar capacidades de otro perfil?** Una barbería que quiera depósito. El plan
   las deja fijas al perfil en v1; una v2 añadiría «funciones adicionales» en Configuración.
3. **¿Cambiar de rubro después de crear el negocio está permitido?** Técnicamente sí (mismo módulo,
   los datos se conservan, solo cambia lo que se ve). Pero pasar de salón a alojamiento deja citas y
   profesionales huérfanos de vista. Propuesta: permitirlo solo entre perfiles del mismo modo.
4. **Estética: ¿se vende ya como agenda, o se espera a la revisión legal de la ficha?**
5. **Alojamiento: ¿iCal entra en la primera versión?** Mi recomendación es que sí; sin él la fase 5
   no tiene a quién venderse.

---

## 10. Riesgos

- **Romper la barbería.** Mitigado por construcción (§2.2) y por la prueba dorada (§3.3). Si la prueba
  dorada no existe antes de tocar `reglasAgenda.js`, este riesgo no está mitigado: está ignorado.
- **Que el perfil degenere en `if (rubro === …)`.** Regla de revisión: el código de servicios
  pregunta por **capacidades y datos**, nunca por el nombre del perfil. El nombre solo lo lee el
  registro de perfiles.
- **Publicar un rubro antes de tiempo.** Los chips de la landing salen de la base: un rubro con
  módulo es un rubro a la venta. Sembrar con `id_tipo_modulo = NULL` hasta su fase.
- **Datos sensibles en estética y mascotas (vacunas).** Tablas auditadas y permiso propio desde la
  primera migración, no después.
- **Estancia sin sincronización** = sobreventa en el primer fin de semana largo. Es el fallo que un
  alojamiento no perdona.

---

## 11. Implementación (2026-09-17)

Las seis fases se construyeron juntas. Decisiones que se tomaron por el camino y que cambian lo
escrito arriba:

- **§9.2 resuelta: funciones configurables.** Cada perfil tiene funciones **fijas** (lo que define al
  oficio: `estancias` en alojamiento, `mascotas` en mascotas) y **disponibles** que el dueño enciende o
  apaga en *Configuración → Funciones* (`reserva_config.funciones`, JSONB). Un salón que no cobra
  abono lo apaga; una barbería no ve la pestaña porque su perfil no ofrece nada. El registro vive en
  `app_reserva_api/perfiles/definiciones.js`; el backend corta con `exigirFuncion` (403
  `FUNCION_INACTIVA`) y las vistas se filtran por perfil en `exigirVista`.
- **§9.5: iCal entra.** Importación cada 15 min (`RESERVA_ICAL_ENABLED`, `RESERVA_ICAL_CRON`) y
  exportación por token público.
- **Sobreventa imposible por construcción:** restricción `EXCLUDE USING gist`
  (`ex_reserva_estancia_sin_sobrecupo`, requiere `btree_gist`) más advisory lock por unidad.

### 11.1 Portales públicos por perfil

Un solo portal (`/p/:id`) que se presenta según el perfil, en lugar de un portal por rubro: la
estructura (cabecera, catálogo, equipo, mi-cita) sirve a todos y lo que cambia son términos, titular y
qué se reserva.

| Perfil | Portada | Página de reserva |
|---|---|---|
| BASE (barbería) | idéntica a la de antes (sin titular) | igual |
| SALON / SPA / ESTETICA | términos propios, precios «Desde» con variantes | elegir variante recalcula huecos y precio; abono con saldo |
| TATUAJE | «A cotizar» en servicios sin precio; portafolio en la ficha del artista | servicio a cotizar → CTA a WhatsApp, sin agenda |
| MASCOTAS | términos de mascota | pide datos de la mascota; la variante fija el tamaño |
| ALOJAMIENTO | buscador por fechas + tarjetas de habitación, sin catálogo de citas | `/p/:id/estadia/:tipo`: precio noche a noche desde el backend, anticipo, código |

El asistente de WhatsApp de alojamiento (`flujoEstancia.js`) responde con el enlace del portal
(`RESERVA_PORTAL_URL`).

### 11.2 Verificación

- `npx jest __tests__/reserva/{motor_dorado,perfiles,motor_perfiles,estancia_tarifas,estancia_ical}.test.js`
  — sin BD. `motor_dorado` guarda 11 snapshots generados **antes** de tocar el motor: si la barbería
  cambia, falla.
- `node scripts/verificar_perfiles_reserva.js` — recorre los siete perfiles contra la BD dentro de
  una transacción que se revierte (50/50 comprobaciones, nada persiste).
- `dominio.test.js` y `usuarios_profesional.test.js` escriben en la BD (con marcador y limpieza). Por
  el túnel SSH necesitan `--testTimeout=120000`; con el timeout por defecto fallan por latencia.

### 11.3 Orden de despliegue

1. Backup de la BD de producción.
2. En el VPS, en este orden: `npm run migrate:rubros-negocio` → `migrate:reserva-perfiles` →
   `migrate:reserva-estancias` → `migrate:reserva-subniveles`. Todas idempotentes y aditivas; los
   subniveles nuevos se siembran **antes** del frontend (ver «ausente == denegado»).
3. `.env` de producción: `RESERVA_PORTAL_URL` (y opcionalmente `RESERVA_ICAL_*`).
4. Backend (`git pull`, `npm install --omit=dev`, reiniciar `escalapp-api`).
5. Frontends: `reserva_app` y `admin_app_v21` (iconos de los rubros nuevos en la landing).

⚠️ Tras el paso 2 los rubros nuevos quedan **a la venta en la landing** (su `id_tipo_modulo` es
RESERVA). Si alguno no debe ofrecerse todavía, ponerle `id_tipo_modulo = NULL` antes de desplegar.

### 11.4 Recorte del catálogo de oficios (2026-09-20)

El catálogo se quedó en **ocho oficios** para reserva: Barbería, Salón de belleza, Spa, Centro de
estética, Tatuajes y perforaciones, Cuidado de mascotas, Consultorio y Hospedaje. Siete chips que
decían lo mismo con otras palabras no ayudaban a elegir, y cada uno era una fila más que mantener.

- **Retirados**, con su sucesor en `catalogo_rubros.js` → `RETIRADOS`: Peluquería y Uñas → Salón de
  belleza · Masajes → Spa · Guardería de mascotas → Cuidado de mascotas · Hostal, Cabañas y
  Apartamentos turísticos → Hospedaje. La migración **mueve los negocios al sucesor y después**
  apaga la fila (`estado='I'`, `id_tipo_modulo=NULL`). La fila nunca se borra: `id_rubro` la
  referencia. Retirar uno más es quitarlo de `RUBROS` y apuntarlo en `RETIRADOS`.
- **Claves conservadas, etiqueta nueva:** `PELUQUERIA CANINA` → «Cuidado de mascotas» y `HOTEL` →
  «Hospedaje», igual que ya se hizo con `SPA Y ESTETICA` → «Spa». Renombrar la clave habría creado
  una fila nueva y dejado huérfanos a los negocios que la apuntan.
- **Mascotas es solo citas.** Se quitó `estancias` de sus funciones disponibles y el ajuste de rubro
  de la guardería: un hotel canino que cobre por noches se da de alta como **Hospedaje**, que es el
  oficio que tiene ese motor. `unidadesDe()` ya solo siembra cupos para alojamiento.
