# Despliegue pendiente — barrido del panel admin, planes de la landing y reactivación del bot

> **Estado al cierre del 2026-09-24:** todo construido, probado en dev (BD compartida 5433 + tests
> contra la local 5432) y revisado. **NADA commiteado ni desplegado.** Se retoma para subirlo a
> producción siguiendo el orden de la §3 — el orden importa, no es sugerencia.

Lo anterior de esta misma tanda (alertas, paginación, negocios/usuarios con pestañas e historial,
WhatsApp por negocio, fix de roles, hotfix del ícono de la bandeja) **ya está en producción** desde
el 2026-09-23 (`admin_ws` `1fbe75a`, `admin_app-v21` `089ba01`). Este documento cubre solo lo que
quedó después.

## 1. Qué entra en esta subida

### Planes y cobro
- **Código estable de plan** (`gener_plan.codigo`: `BASICO`, `AVANZADO`, …). Las features dejan de
  depender del NOMBRE del plan: salen de `gener_plan_caracteristica` (`asistente_ia`,
  `facturacion_electronica`) con el mapa por nombre de `features.js` como respaldo. Renombrar un
  plan ya no apaga el asistente de un cliente (hay test que lo demuestra).
- **8 planes nuevos, uno por paquete, como en la landing**: `EMPRENDEDOR_FE_S…XL` (8 usuarios,
  2 cajas, facturación) y `EMPRESARIAL_S…XL` (15 usuarios, 3 cajas, asistente + facturación).
  Básico y Avanzado NO se tocan.
- **Precio por aplicativo** (`cob_precio_plan.id_tipo_modulo`, NULL = por defecto): Reserva cotiza
  sus precios de la landing (Básico $37.999, Avanzado $69.999, y los de facturación/empresarial).
  Sin «precio pactado»: decisión del usuario (no hay cliente real de Reserva en Colombia; el de
  Chile paga en CLP y no cambia porque no hay filas CLP de Reserva).
- **Los planes con facturación se venden desde ya** aunque la emisión (FE-2) no existe — decisión
  del usuario del 2026-09-24. Un cliente que lo compre puede llenar sus datos DIAN pero **aún no
  emitir**. Lista única de lo que se ofrece: `CODIGOS_OFRECIDOS` en `adquirirService`.
- **Límite de usuarios, ahora SÍ se hace cumplir** (`app_core/helpers/cupoUsuarios.js`,
  409 `LIMITE_USUARIOS`): cupo = plan + «Usuario adicional» ASIGNADO (aunque no se cobre). Solo
  frena crear / vincular / reactivar; nunca inactiva a nadie. **Zona Burger (9/4) e Iconic (8/4)
  siguen trabajando igual pero no pueden añadir más** — decisión del usuario, sin cupo de cortesía.

### Asistente / bandeja (ADR-023, Enmienda 2)
- **Reactivación automática del bot** tras X minutos, por negocio
  (`gener_negocio.reactivar_asistente_min`, **0 = nunca, valor de fábrica**: al desplegar nadie
  cambia de comportamiento). Cuenta desde la última intervención humana
  (`intelligence.conversacion.humano_ultimo_en`); evaluación perezosa al entrar un mensaje del
  cliente; si nadie del negocio intervino, no vuelve. Ver `docs/bandeja.md`.
- «Reportar usuario» = bloquear con modal y observación. **Ojo:** los endpoints `/reportar` que
  llamaba el frontend nunca existieron en este backend (ni en ninguna rama) — en producción esa
  opción fallaba en silencio; ahora usa bloquear.
- Nombre del cliente en la lista, inicial/ícono en el avatar, Enter envía, «Esperan respuesta»
  con pulso, campana con las conversaciones que esperan (derivado en la lectura, sin filas nuevas),
  enlace discreto «Gestionar número».

### Panel
- Cabecera estándar de modales (`shared/modal-cabecera`), editar negocio en pestañas con total
  mensual del backend, registrar negocio por pasos (`shared/pasos`), usuarios sin «Inicio plan» e
  historial en botón propio, tipos ligados a su aplicativo (obligatorio), Ficha 360 oculta del menú,
  tipografía de marca (`--font-marca`, clase `.marca`), textos de WhatsApp sin mencionar Meta.

## 2. Antes de subir

1. **Revisión visual en `localhost:4002`** (nadie la ha hecho — las sesiones no abren navegador):
   editar negocio (pestañas, complementos, total), registrar por pasos, usuarios, tipos,
   WhatsApp (reportar, tiempo de reactivación, campana, gestionar número) y `/adquirir` eligiendo
   una barbería y luego una pizzería (los precios deben cambiar).
2. `git status` en `admin_ws` y `admin_app-v21`: todo lo de esta tanda está sin commitear. Revisar
   que no se cuele nada ajeno y commitear en `master` / `main`.
3. Confirmar que producción sigue en `1fbe75a` / `089ba01` (`git log --oneline -1` en el VPS) — si
   el otro dev desplegó algo entretanto, integrarlo primero.

## 3. Orden de despliegue (NO alterar)

```bash
ssh escalapp@45.63.105.95
/home/escalapp/backup.sh                                   # 0. respaldo SIEMPRE primero
cd /var/www/admin_ws && git pull && git log --oneline -1   #    comprobar el commit, no el mensaje
npm install --omit=dev

# 1-4. Migraciones ANTES de reiniciar: el backend nuevo lee columnas que aún no existen.
npm run migrate:intelligence-reactivacion   # gener_negocio.reactivar_asistente_min (DEFAULT 0) + humano_ultimo_en
npm run migrate:planes-codigo               # gener_plan.codigo + asistente_ia en AVANZADO
npm run migrate:cobranza-precio-aplicativo  # cob_precio_plan.id_tipo_modulo + precios de Reserva
npm run migrate:planes-landing              # los 8 planes nuevos (falla claro si faltan 2 o 3)

sudo systemctl restart escalapp-api         # 5. backend
journalctl -u escalapp-api -n 30 --no-pager
```

6. **Después** el frontend del admin (landing incluida): el nuevo manda CÓDIGOS de plan al comprar
   y un backend viejo solo entiende nombres. Build local + `tar`/`scp` como en `CLAUDE.md`; **no**
   renombrar `index.csr.html`. El admin ya no prerenderiza `/admin/**` (Caddy cae a
   `/index.csr.html`).

Todas las migraciones son idempotentes (probadas corriéndolas dos veces). `git pull` puede traer
`package.json` con 4 scripts nuevos: correr `npm install --omit=dev` aunque no haya dependencias
nuevas no hace daño.

## 4. Comprobar en producción

- `https://api.escalapp.cloud/admin/adquirir/catalogo` (o la ruta pública del catálogo): 10 planes;
  con `?rubro=BARBERIA` los precios de Reserva.
- `/admin/mis-negocios` de un negocio en Avanzado sigue trayendo `features: ["asistente_ia"]` —
  **si sale vacío, el asistente de ese cliente se apagó: revertir de inmediato.**
- WhatsApp del restaurante conectado (negocio 12): la bandeja carga a la primera.
- Zona Burger: sus 9 usuarios siguen activos.

## 5. Cómo revertir

- Código: `git checkout 1fbe75a` en el VPS + reiniciar; frontend: el `tar` de respaldo que se haga
  antes de subir (patrón `front_admin_pre-deploy_*.tar.gz` en `/home/escalapp/backups/`).
- Las migraciones son aditivas (columnas nuevas, filas nuevas): el código viejo las ignora, no hace
  falta deshacerlas para volver atrás. Si hubiera que borrar los planes nuevos: por `codigo`,
  siempre que ningún negocio los haya contratado.

## 6. Pendientes que NO entran en esta subida

- **Precios CLP** de los planes nuevos y de Reserva (no se venden en Chile hasta definirlos) y el
  **ciclo anual** — `docs/precios-y-planes.md` §8.
- **Emisión de facturas (FE-2)**: los planes con facturación se venden sin ella.
- «X de Y usuarios» solo en la consola admin; restaurante_app y reserva_app muestran el 409 pero
  no el contador.
- Deuda de tests conocida: la BD local no tiene `rest_punto_caja*` (≈106 tests de restaurante
  fallan en local por eso), `webhook_proceso.test.js` no arranca (`Models.Sequelize.Op` en
  `planHelper`), 4 specs de Vitest del admin rotos desde antes.
- Revisar en producción, solo lectura, si el bug de roles (corregido el 2026-09-23) dejó a algún
  usuario real sin acceso a alguno de sus negocios: `auditoria.audit_dato` de `gener_usuario_rol`.
