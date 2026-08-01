# EscalApp Intelligence — estado y cómo continuar

**Última actualización:** 2026-08-01
**Propósito:** que retomar el trabajo no cueste una sesión de arqueología. Si vuelves a este
proyecto después de semanas, **lee este documento primero** y sigue por donde diga.

> **Documento vivo.** Actualízalo al terminar cada fase. Si contradice al `roadmap.md`, gana
> el roadmap: esto es un resumen operativo, no una fuente de verdad arquitectónica.

---

## 1. Dónde vive el trabajo

| Repo | Rama | Qué contiene |
|---|---|---|
| `admin_ws` | `feature/escalapp_intelligence` | Todo el backend + el corpus de arquitectura en `docs/` |
| `admin_app-v21` | `feature/escalapp_intelligence` | La vista Ficha 360 |

Ambas ramas están **empujadas y sincronizadas**. Ninguna está fusionada a `master`.

---

## 2. Estado por fase

| Fase | Qué | Estado |
|---|---|---|
| **F0** | Identidad: `platform.persona*`, backfill, camino de escritura, Ficha 360 | ✅ **Completa en local** |
| **F1** | Outbox transaccional + relay | ✅ **Completa en local** |
| **F2** | AuthZ multi-inquilino | ✅ **Completa en local** |
| **F3** | Saneamiento de invariantes de `reserva` | ⬜ Sin empezar |
| **F4** | Capability Registry + Policy Gate | ⬜ Sin empezar |
| F5–F10 | Ver [`architecture/roadmap.md`](architecture/roadmap.md) | ⬜ |

### ⚠️ NADA está desplegado en producción

Las tres fases funcionan y están probadas **solo contra la base local**. Producción sigue
exactamente como estaba. Ver §5 para el procedimiento de despliegue.

---

## 3. Cómo volver a tener un entorno que funcione

```bash
cd admin_ws

# 1. Base local (si ya existe, saltar) — detalle en docs/desarrollo-local.md
npm run migrate
node scripts/seed_dev_local.js
psql -U escalapp_dev -h localhost -d escalapp_dev -f scripts/fixtures/dev_segundo_negocio.sql
psql -U escalapp_dev -h localhost -d escalapp_dev -f scripts/fixtures/dev_ordenes_restaurante.sql

# 2. Migraciones de Intelligence, en este orden
npm run migrate:platform-persona
npm run migrate:platform-backfill-restaurante
npm run migrate:platform-outbox

# 3. Comprobar que todo sigue verde
npx jest __tests__/platform/ --runInBand      # 59 tests

# 4. Levantar
npm run dev                                    # backend  :3000
cd ../admin_app-v21 && npm start               # admin app :4002
```

Login: super admin `1000000001` / `Admin123*`. Ficha 360 en `/admin/personas`.

**Si un cambio "no aparece":** comprueba quién tiene el puerto antes de dudar del código.
Matar el proceso de `npm run dev` deja vivo el hijo `node`, que sigue sirviendo código viejo.

```powershell
(Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess | Stop-Process -Force
```

---

## 4. Qué se construyó, en una línea cada cosa

**F0 — Identidad**
- `platform.persona` y `platform.persona_identificador` existen **vacías a propósito**: el
  nivel global no se puebla hasta el Portal del Cliente ([ADR-006](adr/ADR-006-persona.md),
  [ADR-025](adr/ADR-025-identificadores-nivel-global-vacio.md)). No es código muerto.
- `platform.persona_negocio` es la tabla operativa; ahí vive el teléfono, único por
  `(id_negocio, telefono_e164)`.
- `restaurante.pedid_orden.id_persona_negocio` (FK nullable) + backfill + resolución
  **best-effort** al crear la orden: si la identidad falla, la orden se crea con `NULL`.
- Ficha 360 en `admin_app-v21` → `/admin/personas`, solo Super Admin.

**F1 — Outbox**
- `platform.outbox` + `outboxDao.emitir()` (exige transacción) + relay con backoff y dead
  letter.
- **Ninguna vertical emite todavía y el relay arranca inactivo.** Es deliberado: un evento
  se define cuando hay productor *y* consumidor ([ADR-013](adr/ADR-013-catalogo-eventos.md),
  regla 4). El primer consumidor llega en F5.

**F2 — AuthZ**
- `Principal` + middleware de pertenencia montado en las 6 verticales.
- Cerró una fuga real entre inquilinos (ver §6).
- Arranca en `AUTHZ_MODO=observacion`: audita, **no bloquea**.

---

## 5. Pendiente de despliegue (en este orden)

**Lo más urgente es F2**, porque es lo único que arregla algo que está roto en producción
ahora mismo. F0 y F1 son funcionalidad nueva y pueden esperar.

1. **F2 primero, en modo observación.** Desplegar el código con `AUTHZ_MODO=observacion`
   (o sin la variable: es el valor por defecto).
2. **Medir una semana.** Panel Admin → Auditoría → Eventos, módulo `authz`. O bien:
   ```sql
   SELECT * FROM auditoria.audit_evento WHERE modulo = 'authz' ORDER BY fecha DESC;
   ```
   Cada fila es una petición que en modo bloqueo habría sido rechazada. Revisar si alguna es
   tráfico legítimo (rutas que sacan el `id_negocio` de otro sitio) y corregirla.
3. **Activar `AUTHZ_MODO=bloqueo`** solo cuando la medición esté limpia.
4. **Migraciones de F0/F1**, en orden:
   `migrate:platform-persona` → `migrate:platform-backfill-restaurante` → `migrate:platform-outbox`.
   El segundo hace un `ALTER TABLE` sobre `pedid_orden`, que es tabla activa del POS: toma un
   lock breve, **hacerlo fuera de hora punta**.
5. **Desplegar `admin_app-v21`** para que la Ficha 360 sea visible.

Los conteos reales del backfill (≈621 personas, ≈1.056 órdenes) solo se materializan al
ejecutarlo en producción. Lo verificado en local fueron 2 personas sintéticas.

---

## 6. Decisiones abiertas (te tocan a ti, no al código)

1. **¿F3 o F4?** El roadmap pone F3 (invariantes de `reserva`), pero `reserva` tiene **0 filas
   en producción**, así que su valor inmediato es bajo. F4 (Capability Registry) es donde la
   arquitectura empieza a rendir. La decisión está sin tomar.
2. **Confirmar formalmente las 6 decisiones de `architecture/freeze.md` §D.** ADR-006 y
   ADR-024 ya las tratan como aceptadas, pero el acta pide confirmación explícita.
3. **Repetir la medición de teléfonos cuando un segundo negocio tenga volumen.** Hoy el 98%
   de las personas está en un solo negocio, así que el "cero solapamiento entre inquilinos"
   es *ausencia de evidencia*, no evidencia de ausencia. Ver
   [`mediciones/2026-07-31-calidad-telefonos-restaurante.md`](mediciones/2026-07-31-calidad-telefonos-restaurante.md).
4. **La Ficha 360 nunca se vio renderizada.** El build compila y el guard responde, pero la
   extensión de Chrome no estaba conectada. Mírala tú antes de darla por buena.

---

## 7. Cómo se trabaja aquí

El rol no es diseñar arquitectura, es **preservarla** (ver
[`architecture/architecture-principles.md`](architecture/architecture-principles.md)).

**Orden de precedencia** — lo de arriba gana: Principios → ADRs → `freeze.md` → `roadmap.md` →
implementación. Una implementación nunca modifica implícitamente una decisión: primero se
revisa el ADR, después el código.

**Antes de escribir una línea de una fase nueva:** leer sus ADRs, el `roadmap.md` y la sección
correspondiente del `master-plan.md`. Dos veces esto ha destapado contradicciones que solo se
ven al implementar — y una de ellas obligó a escribir ADR-025.

**Los ADR son inmutables.** Si una decisión cambia, se escribe uno nuevo que la reemplaza.

**Test de simplicidad** antes de crear cualquier componente: ¿quién lo usa? ¿qué problema
resuelve? ¿qué pasa si no existe? Si falla alguna, no se crea. Por eso el outbox no lleva
estado por consumidor y la Ficha 360 no agrega verticales vacías.

---

## 8. Trampas ya pagadas (no volver a tropezar)

| Trampa | Detalle |
|---|---|
| **`uuidv7()` no existe en producción** | Es nativo en PostgreSQL 18 (local) pero **no** en el 17.9 de la RDS. Por eso existe `platform.uuid_generate_v7()` en PL/pgSQL. Un `DEFAULT uuidv7()` pasa en local y revienta al desplegar. |
| **Sequelize descarta columnas no declaradas** | Si el modelo no declara el atributo, `create()` lo ignora **sin error**. Al añadir una columna, actualizar también `app_core/models/<schema>.<tabla>.js`. |
| **`QueryTypes.SELECT` + desestructuración** | `const [filas] = await query(sql, {type: SELECT})` devuelve la **primera fila**, no el array. O una cosa o la otra. |
| **Transacciones en tests** | Envolver siempre en `try/finally`. Una aserción fallida dejó una transacción abierta que bloqueó la suite entera con `idle in transaction`. |
| **Best-effort necesita SAVEPOINT** | En Postgres cualquier error aborta la transacción entera. Un `try/catch` a secas atrapa el error pero deja la transacción envenenada y el commit falla igual. |
| **Migrar desde cero ≠ esquema de producción** | Hay ~44 archivos en `migrations/` y solo 26 registrados como `migrate:*`. El esquema local se carga con `pg_dump --schema-only` de producción, nunca corriendo las migraciones. |
| **Procesos zombis en el puerto** | Ver §3. |

---

## 9. Mapa de documentos

| Documento | Para qué |
|---|---|
| `architecture/architecture-principles.md` | La constitución. Máxima precedencia. |
| `adr/README.md` | Índice de los 25 ADRs. Empezar por ADR-001→006. |
| `architecture/freeze.md` | Qué se congeló y por qué. |
| `architecture/roadmap.md` | Plan de construcción, fase a fase. **El estado real de cada fase está anotado ahí.** |
| `architecture/domain-events.md` | Catálogo de eventos (todos `Planificado` todavía). |
| `architecture/glossary.md` | La lengua ubicua. |
| `desarrollo-local.md` | Montar el entorno local desde cero. |
| `mediciones/` | Mediciones sobre datos reales que condicionaron decisiones. |
