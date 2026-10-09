# Sesión 2026-10-04 / 05 — Zona Burger: auditoría, costo de la IA, carta y diagnóstico

**Estado al cerrar (2026-10-05 ~00:50):** todo lo de este documento está **en producción**.
`admin_ws` en `a5d54a9` (`master`), `admin_app-v21` en `da44757` (`main`); local, GitHub y VPS
coinciden y los árboles están limpios. Para el detalle de cada hallazgo de la auditoría:
[`auditoria-2026-10-04-zona-burger.md`](auditoria-2026-10-04-zona-burger.md).

> En paralelo otra sesión subió «Consumo IA / Terceros» (`4363df2`, `a1394a7`, `ee21292`;
> en el panel `1736903`, `9f82bb7`, `0b08900`). No son de esta sesión, pero viajaron en los mismos
> despliegues: producción los tiene.

> **Continúa en [`sesion-2026-10-05-auditoria-en-vivo-zona-burger.md`](sesion-2026-10-05-auditoria-en-vivo-zona-burger.md)**:
> la auditoría de la primera noche con luna (pendiente 1 de §6), el prompt `sistema.v15` y el costo
> de Meta ya con tarifa.

## 1. Lo que cambió, en el orden en que importa

| Qué | Dónde | Commit |
|---|---|---|
| **El asistente usa `gpt-5.6-luna`** (≈9 veces más barato que terra) | `LLM_MODELO=gpt-5.6-luna` en el `.env` del VPS | — |
| Prompt `sistema.v14` (v12 → v13 «cerrar un pedido» → v14 teléfono y tamaños) | `intelligence/model/prompts/` | `5c2b841`, `bbd5eb0`, `3ff8f8c` |
| Domicilio sin teléfono, o con el teléfono del negocio → `TELEFONO_REQUERIDO` | `adapters/restaurante/index.js` (`tomar_pedido`) | `bbd5eb0`, `3ff8f8c` |
| `buscar_producto` devuelve lo que se nombró, y sin descripciones si son más de 3 | `afinarResultado` | `8f1d896` |
| Carta de Zona Burger renombrada (33 productos + 3 familiares por sabor) | datos de producción | `3ff8f8c` (script) |
| Auditoría del 04: 6 arreglos + 5 de la segunda tanda | ver la auditoría | `45b1c7d`, `5c2b841` |
| **Pausa de emergencia** del asistente, por negocio | Bandeja → «Pausar asistente» | `007f219` / `8b75b61` |
| **El cajero ve WhatsApp** si el plan del negocio incluye `asistente_ia` | `accesoBandejaService` | `d8f5ac5` / `7ad5ffc` |
| **Diagnóstico** de la carta, recomendaciones con IA e **informe** | Bandeja → «Asistente listo» / «Informe» | `dc74abb`, `444624f`, `a5d54a9` / `fe49d4f`…`da44757` |
| Arnés de evaluación para restaurante | `scripts/evaluar.js respuestas_restaurante` | `b948846` |

Migración nueva aplicada en producción: `npm run migrate:negocio-asistente-pausa`
(`gener_negocio.asistente_pausado`, `asistente_pausado_en`). **Falta en la base compartida (5433).**

## 2. El costo de la IA: qué se midió y qué se decidió

`node scripts/auditoria_costo_ia.js [dias]` (solo lectura; en el VPS) cruza el Ledger con la factura
oficial de OpenAI.

- 10 días = **US$1,98**, casi todo Zona Burger; ~US$0,45–0,65 al día con terra → **US$14–22 al mes**.
  El plan Avanzado cuesta $59.999: con un cliente de ese volumen **la IA sola se comía el plan**.
- La factura: 45 % «cache writes» (= la entrada NO cacheada; OpenAI la cobra a ~US$2,50/M y
  `precios.js` la anota a US$2), 35 % lectura de caché (el prompt fijo, que se duplicó en 4 días por
  nuestros propios arreglos), 19 % salida. **El Ledger queda ~10 % por debajo, no 44 %.**
- 1,8 llamadas al modelo por turno; un pedido por chat usa 4,7–5,6 turnos con modelo, uno de la
  carta digital 1,3–2,5.
- **Decisión del dueño: luna en todo.** Con `sistema.v14`, las dos guardias de teléfono y la búsqueda
  afinada, luna dio **100 % en tres rondas** (26 casos reales); terra, 92–96 %.

**⚠️ El costo de la IA no está en [`precios-y-planes.md`](precios-y-planes.md).** Con luna queda en
~US$1,5–2,5 al mes para un cliente como Zona Burger, pero hay que meterlo en la tabla de costos.

**Volver a terra:** borrar `LLM_MODELO` del `.env` del VPS (copia previa: `.env.antes-luna-20261004`)
y `sudo systemctl restart escalapp-api`.

## 3. Cómo se compara un modelo o un prompt (antes de tocar producción)

```bash
# Base LOCAL (5432). Crea/actualiza el restaurante de evaluación con la carta PÚBLICA de Zona Burger.
node scripts/fixtures/dev_zona_burger_eval.js          # imprime el id (1815 en este PC)
FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js respuestas_restaurante \
    --negocio <id> --comparar gpt-5.6-terra,gpt-5.6-luna --detalle
```

- 26 turnos reales anonimizados, con `historial` y `variables` por caso
  (`intelligence/evaluacion/conversaciones/respuestas_restaurante.json`).
- `--detalle` dice qué herramientas usó, qué respondió y **con qué argumentos pidió confirmar** (así
  se vio que luna ponía el teléfono del negocio como el del cliente).
- El modelo no contesta igual dos veces: **mínimo dos rondas**. Una ronda de los dos modelos ≈ US$0,11.
- **Trampa pagada:** si el restaurante de evaluación no tiene domiciliario, mesas, caja abierta o
  nombre del cliente, **todos los modelos fallan los mismos casos** y parece que el modelo es malo.
  El fixture ya los crea; si se añade una regla nueva al dominio, mirar primero el `--detalle`.

## 4. La carta de Zona Burger

Aplicada con `node scripts/aplicar_carta_zona_burger.js --aplicar` (sin `--aplicar` es un ensayo).
Solo tocó `nombre`, `descripcion` (errata de las alitas) y `visible` (la familiar genérica, 73, quedó
«Familiar (sin sabor)» fuera de la carta pública; sigue en el POS con sus 93 ventas). Nuevos:
429 Familiar Criollita, 430 Familiar The House, 431 Familiar Viciosa.

- **Deshacer:** `/home/escalapp/backups/carta_zona_burger_antes_2026-10-04.json` (todas las filas de
  `carta_producto` del negocio 6) y el volcado `db_2026-10-04_2332.dump`.
- **Pendiente del negocio (no se inventó nada):** precio real de «Cigarra 400ml» ($1), qué es
  «concurso» ($65.000), sabores de Postobón, descripciones de costillas dobles / hervidos /
  michelada. «Jugos naturales» no está vacía: 8 productos marcados como no disponibles.
- El entregable para el cliente está en `ADMIN_APP/entregables/zona-burger-ajustes-carta.pdf`
  (fuera de los repos).
- Efecto a vigilar: «una criollita» ahora pregunta el tamaño (antes el nombre era, por casualidad,
  el de la pequeña).

## 5. Diagnóstico del asistente (las tres fases)

Todo vive en ventanas modales de la Bandeja (**nada que crezca va en `.bdj__top`**: la cabecera
tiene alto fijo y no hace scroll — fue el bug que reportó el dueño).

| Fase | Botón | Servicio | Endpoint |
|---|---|---|---|
| 1. Reglas + prueba de humo (sin IA) | «Asistente listo» → *Revisar la carta a fondo* | `diagnosticoAsistenteService` | `GET /admin/intelligence/bandeja/diagnostico` |
| 2. Recomendaciones con IA | *Pedir recomendaciones con IA* | `recomendacionesAsistenteService` | `POST …/diagnostico/recomendaciones` |
| 3. Informe de conversaciones reales | «Informe» | `informeAsistenteService` | `GET …/bandeja/informe?dias=` |

- Las ve el **administrador del negocio y el super admin**. Solo restaurante (fases 1 y 2).
- Fase 2: una llamada por carta (~25 s, **US$0,003–0,004 con luna**); caché de 30 min por huella de
  la carta; el costo queda en `auditoria.audit_evento` (`diagnostico_ia`), no en el Ledger.
  `depurar` descarta productos inventados y precios nuevos. **`gpt-5.6-terra` no sirve aquí**: gasta
  el límite razonando y devuelve vacío.
- Fase 3: SQL de lectura sobre el Ledger; los términos buscados se vuelven a buscar HOY (~12 s con
  120 términos). El gasto en IA solo viaja al super admin.
- Sin decidir: si el diagnóstico va en el plan o se cobra como puesta en marcha.

## 6. Pendientes, por prioridad

1. **Auditar la noche del 2026-10-05** (primera con luna + carta nueva): botón «Informe», y
   `scripts/auditoria_banderas.js 6 "2026-10-05 16:00"` para leer lo que el informe no dice. Comparar
   con el 04: 4,7 turnos con modelo por pedido de chat, 63 conversaciones, 3 `PEDIDO_PERDIDO`.
2. **Probar con sesión real** lo que solo se verificó con tests y capturas: pausar/reanudar, un
   usuario CAJERO (tiene que cerrar sesión y volver a entrar), las tres ventanas del diagnóstico.
3. **Empujar la carta digital** desde el chat (botón «arma tu pedido aquí»): 70 % de los pedidos se
   arman conversando y cuestan 2–3 veces más modelo. Es la palanca que queda.
4. Costo de la IA en `precios-y-planes.md`; corregir `precios.js` (entrada no cacheada de OpenAI ≈
   US$2,50/M).
5. `migrate:negocio-asistente-pausa` en la base compartida.
6. Envío semanal automático del informe (hoy es bajo demanda; el SMTP de producción está roto).
7. «salchilimon» en una palabra no casa con los agotados de «Salchi-limón» (`agotadosQueCoinciden`
   busca con ILIKE, sin la tolerancia de `mismaPalabra`): fue lo más pedido de esa lista.
8. Zona Burger iba en 851 de 1.000 mensajes de WhatsApp (`[whatsapp-cuota]` al arrancar).
9. Avisarle a Juan David: el prompt en uso es `sistema.v14` y el modelo es luna.
10. Fallan en local, **desde antes de esta sesión**: 30 tests de `e2e_agendar`,
    `reinicio_por_inactividad`, `whatsapp_embedded_signup`, `reportes` (deriva de la base local);
    `capacidades_restaurante` (un texto de `agregar_items_pedido`); `ventana` y `canal` fallan a
    veces dentro de la suite completa y pasan solos. En el panel, 4 de `app.spec`,
    `admin.service.spec`, `admin-dashboard.spec`.

## 7. Trampas que costaron tiempo hoy

- **`\b` guardado como U+0008.** El arreglo del saludo del día anterior nunca funcionó: las `\b` de
  sus expresiones eran el carácter de retroceso, invisible. Al escribir expresiones regulares desde
  una herramienta, comprobar con `cat -A` o contar caracteres de control. Lo mismo pasa con
  `\s`, `\d` y `̀` dentro de plantillas de un script generador.
- **Scripts con comillas: archivo, no heredoc.** Varias veces se rompió el script o se perdieron las
  barras invertidas al pasarlo por la terminal.
- **Archivos CRLF.** `flujo.js`, las plantillas y los specs del panel: un `replace` con `\n` no casa;
  quitar `\r`, editar y volver a ponerlo.
- **Trabajo de otra sesión en el mismo árbol.** `git add <carpeta>` metió en un commit rutas que
  requerían un controlador sin subir: producción no habría arrancado. Añadir **archivo por archivo**
  y mirar `git show --stat` antes de subir. Para separar líneas ajenas en un archivo compartido:
  partir de `HEAD` y aplicar solo lo propio (ver el commit `007f219`).
- **Apagar el bot sin botón** (antes de existir la pausa): `UPDATE platform.numero_canal SET
  estado='I'` surte efecto en <60 s, pero saca los mensajes de la Bandeja. Ya no hace falta.
- **Verificar una pantalla sin navegador:** compilar el SCSS del componente con `sass`, armar una
  página estática con los estilos globales del `dist` y sacar capturas con Edge `--headless=new
  --screenshot`. Para móvil, dentro de un `<iframe>` de 390 px: la ventana headless no baja de ~500.
