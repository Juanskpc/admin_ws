# Despliegue — Mesas, Despacho, Pedidos, Caja y carta digital (2026-09-25)

> **Estado: DESPLEGADO** (2026-09-25, tarde). Este documento nació como la guía de la subida pendiente; todo
> lo que describe ya está en producción. La versión definitiva de las **secciones de mesas** (entidad, no
> texto libre) está en `secciones-de-mesas.md`, y el resumen completo de la sesión —despliegues, decisiones,
> trampas y pendientes— en `sesion-2026-09-25-restaurante-y-carta.md`. **Ojo:** la migración
> `migrate:restaurante-mesa-seccion` de aquí (texto libre) quedó **reemplazada** por
> `migrate:restaurante-mesa-secciones`; la columna de texto se conserva pero ya no se usa.

## Qué entra

**Backend (`admin_ws`)** — una sola cosa con lógica: las **secciones de las mesas**.
- Migración `npm run migrate:restaurante-mesa-seccion` → `restaurante.rest_mesa.seccion VARCHAR(60) NULL`.
  Idempotente (comprueba `information_schema`); probada dos veces en la base local.
- `rest_mesa` (modelo), `mesaService` (`crearMesa`, `actualizarMesa`, `getMesas`, `getMesasDashboard`),
  `mesaController` y validadores de `routes/index.js`. Editar SIN mandar `seccion` no la toca; mandarla
  vacía la deja en NULL.
- Test: `npx jest __tests__/restaurante/mesa_seccion.test.js` (4/4).
- **Ingredientes quitados (sin cebolla)** en Despacho y Mesas: `getOrdenesDespacho` (`pedidoService`) y
  `getMesasDashboard` (`mesaService`) ahora traen las exclusiones de cada línea (`exclusiones` en
  Despacho; `sin: [nombres]` en Mesas). La orden YA se guardaba bien —Cocina y Caja las leían—, pero
  Despacho y Mesas las perdían: el tiquete, la tarjeta y «Editar pedido» veían un pedido normal.
  Sin migración. Test: `npx jest __tests__/restaurante/exclusiones_despacho_mesas.test.js` (2/2).
- Solo comentario/documentación: `flujo.js` y `docs/asistente-restaurante.md` (la nota especial de la
  carta es opcional en TODOS los tipos de pedido; el bot ya la aceptaba).

**Frontend `restaurante_app`**
- Mesas: tarjetas por sección, «Editar mesas», sin «Actualizar», filtros en una fila, «Cambiar tamaño»,
  cancelar pedido (tarjeta y modal), modal con un solo scroll y pie fijo, colores ligados al color del
  negocio (`_theme.scss`, color relativo OKLCH con respaldo).
- Despacho: chip «Cancelados» y «Cancelar» en lugar de «Eliminar».
- Pedidos: alineación del selector de tipo, sin «pedido pendiente», botones en formato título, pie
  (nota + totales + botones), ingredientes en pedidos cargados, categorías en móvil.
- Caja: hora 12 h, filas de una línea, margen móvil, sin título repetido.
- Carta digital: «Procesando», selector sin scroll, nota en todos los tipos, pie del pedido compacto.

## Orden (NO alterar)

```bash
ssh escalapp@45.63.105.95
/home/escalapp/backup.sh                                   # 0. respaldo SIEMPRE primero
cd /var/www/admin_ws && git pull && git log --oneline -1   #    comprobar el commit, no el mensaje
npm install --omit=dev
npm run migrate:restaurante-mesa-seccion                   # 1. ANTES de reiniciar: el backend nuevo
                                                           #    lee la columna `seccion` en cada consulta
sudo systemctl restart escalapp-api                        # 2. backend
journalctl -u escalapp-api -n 30 --no-pager
```

3. **Después** el frontend de restaurante (build local + `tar`/`scp`, `cp index.csr.html index.html`).
   Un frontend nuevo contra un backend viejo sigue funcionando (solo no guarda la sección), pero un
   backend nuevo SIN la migración rompe las mesas: por eso la migración va primero.

## Comprobar en producción

- Mesas carga y las tarjetas se ven (si el tablero sale vacío o con error, faltó la migración).
- Crear una mesa con sección «Prueba» → sale agrupada con su título; editarla sin tocar la sección no
  la borra; borrar la mesa de prueba.
- Cancelar un pedido de mesa desde la tarjeta: el pedido desaparece de Despacho/Caja y la mesa queda
  libre (o «ocupada» si ya se había cobrado parte de la cuenta).

## Revertir

Código: `git checkout d805d5c` en el VPS + reiniciar; frontend: el `tar` de respaldo
`front_restaurante_pre-deploy_*.tar.gz`. La migración es aditiva: el código viejo ignora la columna.

## Trampas conocidas de esta tanda

- **Cancelar el pedido de una mesa** cancela la orden y luego pone la mesa en «libre» (o «ocupada» si ya
  había pagos). Son dos llamadas: si la segunda falla el pedido queda cancelado con la mesa «por
  cobrar»; el frontend lo avisa y basta liberar la mesa a mano.
- **Editar ingredientes de un pedido cargado** quita la línea vieja y agrega la nueva; el stock de la
  línea quitada NO se devuelve (decisión previa de `quitarItemsOrden`), así que la nueva vuelve a
  descontar.
- **Colores de las mesas:** con una marca gris/negra (sin croma) los tres estados salen con el tono
  mínimo forzado y pueden verse poco «de la casa»; revisar con las paletas reales.
- Navegadores sin color relativo (Chrome < 119, Safari < 16.4, Firefox < 128) usan el respaldo: los dos
  colores de la paleta y una mezcla.
