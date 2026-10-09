# Cartera — el libro de caja de EscalApp

> Desde 2026-10-09. Solo super admin. Pantalla: `admin_app-v21` → `/admin/cartera` (menú
> «Cartera»). Migración: `npm run migrate:cartera`.

**Cobranza** responde «¿quién nos paga y quién nos debe?». **Cartera** responde la pregunta de los
dueños: *¿cuánta plata entró, cuánta salió y cuánta se quedó por el camino?* — comisiones de Wompi
y dLocal Go, el 4x1000 de cada salida y las retenciones que nos practican los clientes empresa.

## Qué entra solo y qué se anota

| Entra solo (al abrir la vista) | Se anota a mano |
|---|---|
| Cada mensualidad **pagada** en Cobranza (`cob_factura.estado = 'pagada'`) → ingreso «Mensualidades» en la cuenta de su pasarela | Ingresos de otros negocios: desarrollos, facturación a terceros (JDD), soporte, aportes… |
| Cada **recarga de OpenAI** anotada en Terceros (`gener_recarga_ia`, tipo `RECARGA`) → egreso «IA» en USD a la TRM del día | Todos los gastos: Vultr, Hostinger, Factus, Meta, publicidad, contador, impuestos… |
| Si el origen se deshace (factura anulada, recarga borrada), el movimiento se anula solo | Traslados entre cuentas (Wompi → Bancolombia, dLocal → banco) |

**Por qué la copia se hace al leer y no dentro del pago.** `aplicarPagoAprobado` es el camino más
delicado de cobranza (extiende planes); meterle una escritura en un esquema nuevo haría que un
fallo de la Cartera tumbara un pago. `carteraService.sincronizarAutomaticos` corre al abrir el
resumen o la lista, es idempotente (`id_factura` y `id_recarga` son UNIQUE) y cuesta dos
`NOT EXISTS` cuando no hay nada nuevo.

## Las cifras

```
ingreso        cuenta += monto − comisión − IVA comisión − retención
egreso         cuenta −= monto + comisión + IVA comisión + 4x1000
traslado       origen −= monto + comisión + 4x1000 ;  destino += monto

resultado = ingresos − egresos − comisiones − 4x1000      (lo que ganó la empresa)
caja      = resultado − retenciones                        (lo que de verdad llegó)
```

- **Retenciones** no bajan el resultado: son un anticipo de renta/ICA/IVA que se descuenta al
  declarar. Sí bajan la caja, porque esa plata no llegó. Es lo que hace que «el banco no cuadra».
- **4x1000 (GMF, Art. 871 E.T.)**: 0,4 % de cada débito (monto + cargos) de una cuenta con
  `aplica_gmf`. Solo salidas. Exento por movimiento (traslado entre cuentas propias) o por cuenta
  (la marcada exenta ante el banco: desmarcarla). Se puede teclear el del extracto. La pantalla
  muestra el **50 % deducible en renta** (Art. 115 E.T.).
- **Comisión de pasarela**: si se tecleó al confirmar el pago en Cobranza, manda esa. Si no
  (Wompi no la devuelve por API), se **estima** con `car_tarifa_pasarela` (Wompi 2,65 % + $700 +
  IVA 19 %; dLocal 1,99 % + USD 0,20 sin IVA) y el movimiento queda **«Estimado»** hasta que alguien
  lo edite contra el extracto. Cambiar la tarifa no recalcula lo pasado.
- **Moneda**: `monto` en la moneda original; `monto_cop` con `tasa_cop`. Sin tasa
  (`monto_cop NULL`, p. ej. una factura en CLP) el movimiento se ve pero **no suma**, y el resumen
  lo avisa. Sumar con una tasa inventada es peor.

## Modelo (`cartera.*`)

| Tabla | Qué |
|---|---|
| `car_cuenta` | Bancolombia (4x1000, recibe transferencias), Saldo en Wompi, Saldo en dLocal Go, Efectivo; saldo inicial + fecha |
| `car_categoria` | Catálogo editable. `sistema = true` (Mensualidades, IA) no se desactiva |
| `car_tarifa_pasarela` | La tarifa para estimar comisiones; `retencion_pct` en 0 hasta que lo diga la contadora |
| `car_movimiento` | El libro. Anular = `estado 'E'` + motivo, nunca borrar. Auditado (`trg_audit`) |

De un movimiento automático solo se editan las cifras que no vienen de su origen (comisión real,
retención, 4x1000, tasa, cuenta, fecha, textos). El monto lo fija Cobranza: cambiarlo aquí haría
que las dos pantallas dijeran cosas distintas (409 `MOVIMIENTO_AUTOMATICO`). Anular uno automático
**no** anula el pago en Cobranza.

## API (`/admin/cartera`, todo `requireSuperAdmin`)

`GET catalogos` · `GET resumen?desde&hasta` · `GET movimientos?desde&hasta&tipo&id_cuenta&id_categoria&origen&q&anulados`
· `GET exportar` (CSV `;` con coma decimal y BOM, para Excel en español) · `POST movimientos` ·
`PUT movimientos/:id` · `POST movimientos/:id/anular` · `POST|PUT cuentas` · `POST|PUT categorias` ·
`PUT tarifas/:pasarela`.

Código: `migrations/migrate_cartera.js`, `app_core/dao/carteraDao.js`,
`app_admin_api/services/carteraService.js`, `app_admin_api/controllers/carteraController.js`.
Pruebas: `npx jest __tests__/cartera/` (sin base) · `admin_app-v21`:
`features/cartera/cartera.component.spec.ts`.

## Pendiente / abierto

1. **Producción**: correr `npm run migrate:cartera` en el VPS (tras backup) y desplegar backend +
   admin. En la compartida ya está (2026-10-09).
2. **Fijar el saldo inicial** de cada cuenta con el extracto, o los saldos no cuadran con el banco.
3. **Contadora**: si Wompi/dLocal nos practican retenciones, si la venta a Chile es exportación, y
   si la cuenta de Bancolombia está marcada exenta de 4x1000.
4. Ideas que caben después: gastos recurrentes que se anotan solos cada mes (Vultr, Hostinger),
   adjuntar el PDF del soporte, provisión de impuestos (renta/ICA estimados), MRR desde las
   suscripciones, y traer el costo de Meta de la WABA propia desde Terceros.
