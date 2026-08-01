# Calidad de los teléfonos en `restaurante` — prerequisito de F0

**Fecha:** 2026-07-31
**Origen:** `restaurante.pedid_orden` en producción (RDS), ventana 2026-03-10 → 2026-07-31.
**Método:** `scripts/medir_calidad_telefonos.js`, transacción de solo lectura, únicamente
agregados. No se descargó ningún teléfono, nombre ni dirección.
**Motivo:** roadmap §6 — *"medir la calidad de los teléfonos en `restaurante` (única fuente
real del backfill; si es basura, la Ficha 360 nace coja)"*.

## Veredicto

**El dato no es basura: la Ficha 360 es viable.** 94.8% de los teléfonos capturados son
móviles colombianos válidos y el 95.3% tuvo actividad en los últimos 90 días.

Pero el volumen es pequeño y está concentrado: **621 personas potenciales, de las cuales 609
(98%) pertenecen a un solo negocio.** F0 es ejecutable; lo que no valida es la
multi-tenencia del modelo de persona.

## Dónde vive el dato

En `restaurante` **no existe una entidad cliente**. El único teléfono de cliente final es
`pedid_orden.contacto_telefono`, capturado al tomar la orden, y solo en pedidos a domicilio.

| Tipo de pedido | Órdenes | Con teléfono | % |
|---|---:|---:|---:|
| LLEVAR | 1.890 | 0 | 0.0 |
| MESA | 1.294 | 0 | 0.0 |
| DOMICILIO | 1.123 | 1.114 | **99.2** |

El "25.9% de las órdenes tiene teléfono" del agregado global es engañoso: en el único flujo
donde se espera un teléfono, la cobertura es del 99.2%.

## Calidad del valor capturado

Sobre las 1.114 órdenes con teléfono, tras normalizar (quitar no-dígitos, prefijo `57`, troncal `0`):

| Clase | Órdenes | % |
|---|---:|---:|
| Móvil válido (10 díg., empieza en 3) | 1.056 | **94.8** |
| Muy corto (< 7 díg.) | 36 | 3.2 |
| Otro inválido | 17 | 1.5 |
| Basura (dígito repetido) | 4 | 0.4 |
| Fijo legacy 7 díg. | 1 | 0.1 |

## Población resultante

- **621 móviles distintos** — el tamaño real del backfill de `persona_identificador`.
- 1.70 órdenes por teléfono.

**Recurrencia:**

| Órdenes acumuladas | Teléfonos | % |
|---|---:|---:|
| 1 | 432 | 69.6 |
| 2–3 | 136 | 21.9 |
| 4–10 | 50 | 8.1 |
| 11+ | 3 | 0.5 |

**Vigencia:** 592 (95.3%) con última orden en los últimos 90 días; 29 (4.7%) entre 90 días y
un año. Ninguno más antiguo.

**Estabilidad del nombre** (relevante para `persona_negocio.nombre_mostrado`):

| | Teléfonos | % |
|---|---:|---:|
| Un nombre consistente | 495 | 79.7 |
| 2 nombres distintos | 80 | 12.9 |
| 3+ nombres distintos | 46 | 7.4 |

Ningún móvil quedó sin nombre.

## Concentración por negocio

| `id_negocio` | Órdenes | Móviles distintos |
|---|---:|---:|
| 6 | 4.141 | 609 |
| 3 | 149 | 12 |
| 1 | 17 | 0 |

## Cruce entre negocios

**El 100% de los 621 móviles aparece en exactamente un negocio. Cero solapamiento.**

Este resultado **confirma** la decisión congelada en `freeze.md` §B.5 — modelar
`platform.persona` desde el día uno y **no poblarlo** hasta que exista el Portal del Cliente.
Con cero solapamiento observado, poblar hoy el nodo global sería especulación.

> **Cuidado con sobreinterpretarlo.** Con el 98% de los móviles en un solo negocio, la muestra
> es estructuralmente incapaz de mostrar solapamiento en cualquier dirección. Esto es
> *ausencia de evidencia*, no evidencia de ausencia. **Repetir esta medición cuando un
> segundo negocio tenga volumen real** antes de sacar cualquier conclusión sobre si las
> personas se cruzan entre inquilinos.

## Premisa del roadmap: verificada

El roadmap justifica "backfill solo de `restaurante`" en que las demás verticales no tienen
datos. Es correcto:

| Origen | Filas | Con teléfono |
|---|---:|---:|
| `restaurante.pedid_orden` | 4.307 | 1.122 |
| `gym.gym_miembro` | 1 | 1 |
| `parqueadero.parq_abonado` | 1 | 1 |
| `reserva.reserva_cita` | 0 | 0 |
| `tienda.tienda_cliente` | 0 | 0 |

## Consecuencias para F0

1. **El backfill es trivial: ~621 filas.** No necesita lotes, ni job asíncrono, ni
   particionado. Debe ser una migración simple y directa. Cualquier maquinaria por encima de
   eso no pasa el test de simplicidad.

2. **Hace falta una regla de elección de nombre.** El 20.3% de los móviles tiene 2 o más
   nombres distintos entre sus órdenes, porque el nombre vive en la orden y no en una entidad
   cliente. Propuesta: `nombre_mostrado` = el nombre de la **orden más reciente** (refleja la
   intención más fresca), no el más frecuente. Es detalle de implementación, no toca ningún ADR.

3. **La Ficha 360 solo es rica para ~30% de la población.** 432 de 621 personas tienen una
   sola orden: para ellas la "vista 360" es una línea. La demo debería apoyarse en los 53
   teléfonos con 4+ órdenes.

4. **Punto abierto de alcance — el backfill se degrada solo.** `pedid_orden` seguirá
   escribiendo teléfonos como texto suelto. Si F0 entrega únicamente la carga inicial, la
   Ficha 360 queda congelada en la foto del 31 de julio y envejece con cada pedido nuevo.
   Para que el entregable siga vivo, F0 tiene que incluir también **el camino de escritura**:
   que una orden nueva resuelva o cree su `persona_negocio`. El roadmap describe F0 solo como
   "backfill"; esto hay que decidirlo explícitamente antes de empezar.

## Reproducir

```bash
node scripts/medir_calidad_telefonos.js --env .env.produccion.bak   # producción (lectura)
node scripts/medir_calidad_telefonos.js                            # local
```
