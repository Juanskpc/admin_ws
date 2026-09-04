# ADR-026 — Facturación electrónica: integrar un proveedor tecnológico, no construir el emisor

## Estado

**Propuesto** (2026-09-01)

> Pasa a `Aceptado` cuando se confirme la decisión. Lo que queda abierto es **cuál** proveedor
> (ver [`facturacion-electronica.md`](../facturacion-electronica.md) §8), no si se construye o se
> integra: eso es lo que decide este ADR.

## Contexto

La facturación electrónica no entra por la hoja de ruta técnica sino **por la venta**. Los
restaurantes con flujo de caja mayor que el de las comidas rápidas —el segmento que hace viable el
negocio— piden dos cosas antes de firmar: WhatsApp con pedidos automáticos (hecho, F8) y
facturación electrónica. Es la mitad del requisito de entrada a un segmento que hoy no se puede
cerrar.

Hay además una obligación legal ya vencida. La Resolución DIAN 000165 de 2023 y la 000008 de 2024
convirtieron el tiquete POS en **documento equivalente electrónico**, con fechas que van de mayo a
noviembre de **2024** según el tipo de contribuyente. El POS que EscalApp imprime hoy no se
transmite a la DIAN: el cliente lo está resolviendo con otro software en paralelo, o no lo está
resolviendo.

El sistema tampoco tiene hoy con qué construir un documento fiscal: `general.gener_negocio` solo
guarda `nit`, `restaurante.pedid_orden` lleva un `impuesto` agregado sin discriminar por línea,
`carta_producto` solo tiene `precio`, y ninguna vertical captura al adquiriente. Ese trabajo hay
que hacerlo con cualquier alternativa que se elija; **no es lo que este ADR decide**.

Lo que decide este ADR es quién genera, firma y transmite el documento a la DIAN.

## Alternativas consideradas

**A. Habilitarnos como proveedor tecnológico (PT) ante la DIAN.** Sería la opción con más control y
la única que permitiría transmitir por cuenta de los inquilinos como servicio propio. **Descartada
por imposible, no por costosa:** la DIAN exige patrimonio contable ≥ **20.000 UVT**
($1.047.480.000 con la UVT de 2026) y propiedad, planta y equipo ≥ **10.000 UVT** ($523.740.000) en
Colombia, más certificación ISO 27001. EscalApp es la empresa de un solo desarrollador, con
matrícula mercantil a nombre personal. No hay ruta desde aquí hasta allá.

**B. Construir el emisor como «software adquirido» que cada cliente habilita con su NIT.** Es legal
y no exige patrimonio: el desarrollador no necesita ser PT, cada negocio se habilita con su propio
certificado (Concepto DIAN 1169/013246 de 2025). Sería la opción de mayor margen unitario.
**Descartada por el costo total de propiedad, no por dificultad puntual.** Implica construir y
mantener XML UBL 2.1, firma XAdES-EPES, cálculo de CUFE/CUDE, cliente de los servicios de la DIAN,
representación gráfica con QR, numeración, modo contingencia, notas crédito y débito — estimado en
**400–600 horas la primera versión**. Y sobre todo implica: (a) **una habilitación por cada
inquilino**, con su set de pruebas, cada vez que entra un cliente; (b) **mantenimiento perpetuo con
plazos que pone la DIAN**, no nosotros: cada versión del anexo técnico es trabajo forzoso con
fecha. Es un producto entero, en un mercado donde ya compiten empresas dedicadas, y no es el
producto en el que competimos.

**C. Emitir a mano por el servicio gratuito de la DIAN.** Descartada de inmediato: no se integra
con nada. Convertiría el POS en un teclado doble y anularía la razón de tener un POS.

**D. Integrar la API de un proveedor tecnológico ya habilitado.** Lo que se decide.

## Decisión

**Se integra la API de un proveedor tecnológico habilitado por la DIAN, detrás de un puerto con
adaptadores intercambiables, con el proveedor configurable por negocio.**

Consecuencias de diseño que forman parte de la decisión:

- **Puerto + adaptadores**, con la misma forma que `intelligence/model/puerto.js` y
  `intelligence/model/adaptadores/`. El proveedor se cambia por configuración, no editando el
  servicio de emisión. Un adaptador es sustituible; una integración esparcida por cinco verticales
  no lo es.
- **Esquema `facturacion` propio.** Los documentos fiscales son un contexto con reglas de
  conservación (mínimo 5 años), inmutabilidad y respaldo distintas del resto de la plataforma.
  Convenciones de [ADR-024](ADR-024-persistencia.md) para esquemas nuevos: PK UUIDv7 vía
  `platform.uuid_generate_v7()`, `timestamptz` en UTC, `id_negocio` entero.
- **Las verticales no dependen de `facturacion`.** Ninguna FK desde una tabla de vertical hacia el
  esquema fiscal; el producto guarda un `codigo_impuesto` de texto validado por la aplicación. Si
  la facturación se apaga o se cae, **la venta se cierra igual** ([ADR-005](ADR-005-independencia-verticales.md),
  el test del apagón).
- **La emisión es un intento síncrono con caída a cola.** La factura de venta necesita validación
  previa de la DIAN antes de entregarse, pero el mesero no puede esperar: se intenta en línea con
  timeout corto y, si falla, el documento queda `EN_COLA` y un worker reintenta. La venta nunca se
  bloquea por la DIAN.
- **El outbox no emite; distribuye.** [ADR-012](ADR-012-outbox.md) se usa para lo que ocurre
  *después* de la aceptación (`documento.fiscal.aceptado.v1` → entrega por WhatsApp y
  notificaciones), no para la emisión, que necesita respuesta inmediata. El evento nace con
  consumidor real, como exige la regla 4 de [ADR-013](ADR-013-catalogo-eventos.md).
- **Nace apagada, y se enciende por partes.** Hay clientes que no la quieren y clientes que ni
  siquiera están obligados. `modo_facturacion` (`NINGUNO` por defecto) vive en el negocio y **lo
  declara el cliente**, con rastro de quién y cuándo; la puerta comercial es una feature más en la
  costura de [ADR-021](ADR-021-features.md). Con `NINGUNO` el esquema `facturacion` ni se toca y el
  comportamiento es el de hoy. **Quién está obligado lo dice la ley, no nosotros:** registramos lo
  que el cliente declara, no lo deducimos.
- **Tres invariantes:** un documento aceptado no se edita ni se borra (se corrige con nota crédito);
  una venta se factura una sola vez (`UNIQUE (id_negocio, origen_tipo, origen_id, tipo)`); el
  consecutivo no se reutiliza jamás.

## Consecuencias positivas

- El cumplimiento normativo —la parte que caduca y cambia sola— queda **comprado, no mantenido**.
  Cuando la DIAN publique un anexo nuevo, el trabajo es del proveedor.
- Desbloquea el segmento de restaurantes que hoy no se puede cerrar, que es el motivo de todo esto.
- El costo es operativo y proporcional al uso, no una inversión hundida de meses.
- El puerto deja la puerta abierta: cambiar de proveedor, o soportar dos a la vez porque un cliente
  ya tiene contrato con uno, es un adaptador nuevo.
- El trabajo que sí es nuestro —modelo fiscal, impuestos por línea, captura del adquiriente— es
  exactamente el mismo con cualquier proveedor, así que **se puede empezar antes de elegirlo**.
- La entrega de la factura **por WhatsApp** sale casi gratis del canal que ya existe (F8). Para la
  competencia es un proyecto; para nosotros, un consumidor de evento.

## Consecuencias negativas

- **Dependencia de un tercero en una ruta crítica del negocio del cliente.** Si el proveedor se
  cae, el cliente no factura. Se mitiga con la cola de reintentos y con que el puerto permita
  cambiar de proveedor, pero no se elimina.
- **Costo recurrente que muerde el margen.** A ~$20.000 COP/mes por inquilino se come el 71% del
  plan Básico ($27.999). Obliga a negociar bolsa multiempresa a nivel EscalApp o a vender la
  facturación como complemento con cupo. **Es la consecuencia más incómoda y no tiene solución
  técnica.**
- **La habilitación de cada cliente ante la DIAN sigue siendo un trámite externo** con plazos que
  no controlamos — el mismo patrón que la verificación de negocio de Meta en F8-C, que ya costó
  semanas una vez.
- Se elige así **por ser un equipo de una persona**, no por superioridad técnica. Una empresa con
  patrimonio y un equipo dedicado podría convertir la alternativa B en producto vendible y en
  ventaja competitiva. Nosotros no.

## Impacto futuro

Si algún día EscalApp tiene volumen suficiente, la alternativa B deja de ser absurda: con cientos de
inquilinos, el costo por documento del proveedor puede superar el de mantener el emisor. Esa
reevaluación se hace **con la factura del proveedor en la mano**, no antes, y sería un ADR nuevo que
reemplace a este.

El esquema `facturacion` y las tres invariantes están diseñados para sobrevivir a ese cambio: son
independientes de quién transmite. Lo que cambiaría es un adaptador.

## Fecha

2026-09-01

## Referencias

- [`facturacion-electronica.md`](../facturacion-electronica.md) — el documento operativo completo:
  explicación en llano de POS vs. factura, calendario DIAN, modelo de datos, flujo, proveedores,
  fases y trampas
- [ADR-002](ADR-002-multitenancy.md) — esquemas por dominio + `id_negocio`
- [ADR-005](ADR-005-independencia-verticales.md) — independencia de las verticales (el test del apagón)
- [ADR-012](ADR-012-outbox.md) · [ADR-013](ADR-013-catalogo-eventos.md) — outbox y catálogo de eventos
- [ADR-024](ADR-024-persistencia.md) — convenciones de persistencia para esquemas nuevos
- [`obligaciones-escalapp.md`](../obligaciones-escalapp.md) — las obligaciones que nos tocan a
  nosotros: facturar las mensualidades, IVA sobre el SaaS, datos personales, responsabilidad frente
  al cliente
- [ADR-021](ADR-021-features.md) — features / entitlements (la costura del opt-in)
- [ADR-006](ADR-006-persona.md) · [ADR-025](ADR-025-identificadores-nivel-global-vacio.md) — dónde viven los datos del comprador
- `BACKLOG_DETALLADO.md` — ESC-067 a ESC-071
- Normativa citada en `facturacion-electronica.md` §11
