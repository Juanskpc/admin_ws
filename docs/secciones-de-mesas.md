# Secciones de las mesas («Piso 1», «Terraza»…)

> **Estado (2026-09-25):** construido y probado en local (backend Jest 1360/1360 en verde; frontend Vitest
> 215/215). **NADA desplegado todavía.**

## Qué es y por qué

La primera versión (`migrate_mesa_seccion.js`, ya en producción) guardaba la sección como **texto libre**
en cada mesa. Era lo mismo que escribirla a mano cada vez: «Piso 1» diez veces, un «piso1» por error de dedo
y aparecía una sección nueva. Ahora la sección es una **entidad**: se **crea una vez** y las mesas se le
**asignan**.

## Modelo

- `restaurante.rest_mesa_seccion` (`id_seccion`, `id_negocio`, `nombre` ≤ 60, `orden`, `estado`,
  `fecha_creacion`). Nombre **único por negocio sin distinguir mayúsculas** (índice sobre `LOWER(nombre)`).
- `rest_mesa.id_seccion` (FK, `NULL` = sin sección, `ON DELETE SET NULL`: borrar una sección **no** borra
  sus mesas).
- La columna de texto `rest_mesa.seccion` **se conserva** pero ya no se usa: el código anterior todavía la
  lee y quitarla haría imposible volver atrás. Se puede borrar en otra tanda, con la certeza de no volver.

## Migración — `npm run migrate:restaurante-mesa-secciones`

Idempotente (`IF NOT EXISTS` + `information_schema`). Además **migra los datos**: por cada texto distinto
(sin distinguir mayúsculas ni espacios de más) crea una sección y liga las mesas. Probada en local con
«piso 1» / « Piso   1 » (→ UNA sola sección), «Patio» en dos negocios (→ dos secciones, una por negocio) y
una mesa sin texto (→ sin sección).

## API (`/restaurante`, todo acotado por `id_negocio`)

| Método y ruta | Qué hace |
|---|---|
| `GET /mesas/secciones?id_negocio=` | Las secciones en su orden, con `total_mesas` |
| `POST /mesas/secciones` | Crear `{id_negocio, nombre}` (409 `NOMBRE_DUPLICADO`) |
| `PUT /mesas/secciones/:id` | Renombrar |
| `DELETE /mesas/secciones/:id?id_negocio=` | Borrar; devuelve `mesas_sin_seccion` |
| `PUT /mesas/secciones/orden` | El orden nuevo: `{id_negocio, ids: [TODAS]}` |
| `PUT /mesas/secciones/:id/mesas` | Fija qué mesas tiene: `{id_negocio, ids_mesas}` |
| `POST/PUT /mesas` | Aceptan `id_seccion` (`null` al editar = quitarla; sin la clave = no tocarla) |

- **Aislamiento entre negocios:** una sección ajena no se ve, no se renombra, no se borra y no se puede
  escribir en una mesa (`SECCION_INVALIDA` 422); asignar mesas ajenas da `MESAS_INVALIDAS`.
- **Asignar es COMPLETO:** las de la lista entran (aunque estuvieran en otra sección) y las que ya no van
  quedan libres — lo que se marca en pantalla, no una suma.
- **Reordenar exige TODAS** las secciones del negocio: dos pantallas que reordenan a la vez no se pisan sin
  enterarse (gana la última lista completa).
- El tablero (`/mesas/dashboard`) y `/mesas` traen `id_seccion`, `seccion` (nombre) y `seccion_orden`.
- Cada cambio emite el aviso de tiempo real `mesas`: otros equipos releen la lista solos.

## Pantalla (`restaurante_app`, Mesas)

- **Botón «Secciones»** (junto a «Editar mesas»): crear, renombrar, ordenar (subir/bajar), eliminar y
  **«Mesas»** por sección (marcar cuáles van en ella). Requiere el permiso `mesas_administracion`.
- **Formulario de la mesa:** un selector con las secciones que ya existen (sin escribir texto libre); si aún
  no hay ninguna, ofrece crearlas.
- **Salón:** las mesas van agrupadas con título; con el filtro «Todas» también se ven las secciones vacías
  («Sin mesas todavía»), para que una recién creada no desaparezca.

## Despliegue (orden — NO alterar)

```bash
ssh escalapp@45.63.105.95
/home/escalapp/backup.sh                                   # 0. respaldo SIEMPRE primero
cd /var/www/admin_ws && git pull && git log --oneline -1   #    comprobar el commit, no el mensaje
npm install --omit=dev
npm run migrate:restaurante-mesa-secciones                 # 1. ANTES de reiniciar: el backend nuevo lee
                                                           #    `id_seccion` y el join en cada consulta de mesas
sudo systemctl restart escalapp-api                        # 2. backend
```

3. **Después** el frontend de restaurante (build local + `tar`/`scp`, `cp index.csr.html index.html`).

**Ventana de compatibilidad:** entre el paso 2 y el 3 el frontend viejo sigue mostrando las mesas agrupadas
(el tablero sigue trayendo `seccion` como nombre), pero al editar una mesa mandaría `seccion` (texto) y el
servidor lo ignora: no se guarda la sección hasta subir el frontend nuevo. Sin errores.

## Revertir

Código: `git checkout` del commit anterior + reiniciar; frontend: el `tar` de respaldo. La migración es
**aditiva**: el código anterior ignora la tabla y `id_seccion`, y sigue leyendo la columna de texto.

## Tests

- Backend: `npx jest __tests__/restaurante/mesa_seccion.test.js` (crear/duplicados/aislamiento/asignar/
  ordenar/borrar/lectura).
- Frontend: `mesa-secciones.spec.ts` (agrupar, orden, secciones vacías).
