# ADR-005 — Independencia de las verticales (el test del apagón)

## Estado

Aceptado

## Contexto

EscalApp Intelligence es una **capacidad opcional**, no el producto. Las verticales existían antes
que la IA, funcionan sin ella, y muchos negocios nunca la contratarán. El mayor riesgo estratégico
del proyecto es que, al construir la IA, las verticales terminen dependiendo de ella — que un día
"reservar una cita" requiera que el subsistema de IA esté vivo. Eso invertiría la relación correcta
y ataría la supervivencia del producto a una apuesta.

Este es el principio que más fácilmente se viola sin darse cuenta, porque cada integración pequeña
("que al crear la cita se dispare un WhatsApp") tienta a que la vertical *llame* a la IA.

## Alternativas consideradas

**Las verticales invocan a Intelligence cuando quieren algo del asistente.** Es el camino natural e
intuitivo. Descartada: convierte a la IA en dependencia dura del dominio. Si la IA se cae o se
apaga, la vertical se cae con ella. Además acopla el código de la vertical a un contrato con forma
de IA.

**La IA como middleware obligatorio** por el que pasan las operaciones. Descartada por lo mismo,
agravado: un fallo de la IA bloquearía operaciones de negocio.

**Inversión estricta de la dependencia: la IA consume; las verticales no saben que existe.**
Elegida.

## Decisión

**EscalApp Intelligence nunca es una dependencia obligatoria de una vertical.** La flecha de
dependencia apunta **siempre** Intelligence → Vertical, nunca al revés. En concreto:

1. **Una vertical nunca llama a Intelligence.** Si quiere que algo ocurra (una confirmación por
   WhatsApp), **emite un evento de dominio al outbox** de `platform` y se olvida. Intelligence se
   suscribe y decide. La vertical no sabe que hay un asistente.
2. **El outbox vive en `platform`, no en `intelligence`** ([ADR-012](ADR-012-outbox.md)): así emitir
   un evento no obliga a escribir en el esquema de la IA.
3. **`id_persona_negocio` es siempre nullable en las verticales** ([ADR-006](ADR-006-persona.md)):
   una cita o un pedido se crean perfectamente sin persona y sin IA.

El acoplamiento con el dominio (saber qué es una cita) vive en los **adaptadores** de Intelligence
([ADR-009](ADR-009-capability-adapter.md)), nunca en el núcleo ni en la vertical.

## Consecuencias positivas

- Si apagamos Intelligence entera, las seis verticales siguen funcionando igual. Si la apuesta por
  la IA sale mal, **no perdemos EscalApp**.
- Las verticales se despliegan y evolucionan sin coordinarse con la IA.
- El principio es **verificable de verdad**, no un buen deseo (ver abajo).

## Consecuencias negativas

- La comunicación vertical → IA es indirecta (vía eventos), lo que añade una indirección frente a
  una llamada directa. Es exactamente el precio del desacople, y se paga con gusto.
- Exige disciplina y verificación continua para que ninguna "pequeña excepción" se cuele.

## Impacto futuro

Este principio gobierna toda integración presente y futura entre una vertical y el cerebro
conversacional, y toda vertical nueva. Se protege con dos comprobaciones automáticas en CI:

- **Grep de dependencia:** cero imports y cero llamadas HTTP desde el código de una vertical hacia
  `intelligence`.
- **El test del apagón:** apagar el módulo Intelligence en un entorno de pruebas y correr la suite
  de las verticales. Debe pasar sin un solo endpoint roto. Si algo falla, hay una violación.

## Fecha

2026-07-14

## Referencias

- `architecture/revision-01.md` (punto 10, el principio fundamental), `architecture/freeze.md`
- [ADR-004](ADR-004-platform-intelligence.md), [ADR-009](ADR-009-capability-adapter.md), [ADR-012](ADR-012-outbox.md)
