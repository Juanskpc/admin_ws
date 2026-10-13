/**
 * F0 de las promociones masivas: a quién se le puede escribir y cómo se sale.
 *
 * ## El modelo que esto protege
 *
 * **Al cliente final no se le pregunta nada** (decisión del dueño, 2026-10-12). La audiencia son
 * los clientes que ya están en la base del negocio, y se les escribe salvo que se hayan dado de
 * baja. Así que lo único que puede fallar de forma caro es **la salida**, y es lo que se prueba
 * aquí:
 *
 *   1. Que la palabra que se le enseña al cliente para no recibir publicidad **no le cierre el
 *      canal por el que pide la comida**. Es la diferencia entre la baja blanda y `optout.js`, y
 *      la trampa más fácil de este módulo: si «no promos» acabara bloqueando la conversación, el
 *      cliente se enteraría la próxima vez que tuviera hambre.
 *   2. Que un `STOP` **sí** saque de la audiencia. Era un agujero real hasta el 2026-10-12: la
 *      conversación quedaba bloqueada y la ficha seguía contactable, así que una campaña —que
 *      mira fichas, no conversaciones— le habría escrito igual.
 *   3. Que la baja quede **con la prueba** de con qué palabras se pidió. No hay que poder
 *      demostrar que autorizó; hay que poder demostrar que cuando dijo «no» se le hizo caso.
 *   4. Que **el flujo de un pedido no cambie ni un carácter**. Es la prueba de regresión de la
 *      decisión de no preguntar: hubo una versión que pegaba la pregunta a la confirmación, y esto
 *      es lo que impide que vuelva sin que nadie lo note.
 *
 * Corre **sin Postgres**: la audiencia se inyecta en la escalera y el Gate en la confirmación. El
 * módulo de verdad contra la base queda cubierto por F1, cuando haya vista que lo use.
 *
 *   npx jest __tests__/promociones/audiencia.test.js
 */
'use strict';

const bajaPromociones = require('../../intelligence/engine/bajaPromociones');
const optout = require('../../intelligence/engine/optout');
const confirmacion = require('../../intelligence/engine/confirmacion');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');

const NEGOCIO = 6;
const TELEFONO = '+573001112233';

// ── Dobles ──────────────────────────────────────────────────────────────────────────────

/** La audiencia, que aquí solo apunta lo que le piden. */
function audienciaFalsa() {
    const escrito = { excluidos: [] };
    return {
        escrito,
        async excluirPorTelefono(datos) {
            escrito.excluidos.push(datos);
            return { excluido: true };
        },
    };
}

const conversacion = (extra = {}) => ({
    id_conversacion: 'c1',
    id_negocio: NEGOCIO,
    canal: 'whatsapp',
    id_externo: '573001112233',
    estado: 'activa',
    variables: { turnos: 3 },
    tarea_actual: null,
    tarea_datos: null,
    ...extra,
});

const entrada = (texto, conv = conversacion()) => ({
    conversacion: conv,
    idNegocio: NEGOCIO,
    mensajes: [{ contenido: texto }],
    turno: { id_turno: 't1' },
    texto,
    principal: { telefono_verificado: TELEFONO },
    consumo: { costos: [] },
});

/** La escalera con los dos peldaños anulados: aquí solo interesa lo que pasa ANTES de ellos. */
function hacerEscalera(audiencia) {
    const visto = { determinista: 0, llm: 0 };
    const manejador = crearManejadorEscalera({
        audiencia,
        resolverNegocio: async () => ({ tratamiento: 'Zona Burger', atencion: null }),
        determinista: async () => {
            visto.determinista += 1;
            return {
                pasos: [],
                respuestas: ['lo que diría el flujo'],
                variables: {},
                resultado: 'resuelto',
                nivel: 'determinista',
            };
        },
        llm: async () => {
            visto.llm += 1;
            return { pasos: [], respuestas: ['lo que diría el modelo'], resultado: 'resuelto', nivel: 'llm' };
        },
    });
    return { manejador, visto };
}

// ── Las palabras ────────────────────────────────────────────────────────────────────────

describe('las palabras de la baja de publicidad', () => {
    test.each([
        'no promos',
        'No Promociones',
        'no quiero promociones',
        'sin promos',
        'no publicidad',
        'stop promos',
    ])('«%s» pide la baja', (texto) => {
        expect(bajaPromociones.bajaPedida(texto)).toBe(true);
    });

    test('«promociones» a secas NO la pide: es lo que escribe quien las QUIERE ver', () => {
        expect(bajaPromociones.bajaPedida('promociones')).toBe(false);
        expect(bajaPromociones.bajaPedida('¿tienen promociones?')).toBe(false);
    });

    test('se lee la última línea de la ráfaga, como el resto del motor', () => {
        expect(bajaPromociones.bajaPedida('gracias\nno promos')).toBe(true);
    });

    test('no se solapa con la baja DURA: son dos listas y dos efectos distintos', () => {
        for (const palabra of bajaPromociones.PALABRAS_BAJA) {
            expect(optout.pedida(palabra)).toBe(false);
        }
        for (const palabra of optout.PALABRAS) {
            expect(bajaPromociones.bajaPedida(palabra)).toBe(false);
        }
    });
});

// ── La baja blanda, en la escalera ──────────────────────────────────────────────────────

describe('cuando el cliente pide la baja de publicidad', () => {
    test('lo saca de la audiencia y NO bloquea la conversación', async () => {
        const audiencia = audienciaFalsa();
        const { manejador, visto } = hacerEscalera(audiencia);

        const d = await manejador(entrada('no promos'));

        expect(audiencia.escrito.excluidos).toHaveLength(1);
        expect(audiencia.escrito.excluidos[0]).toMatchObject({ idNegocio: NEGOCIO, telefono: TELEFONO });
        // LO IMPORTANTE: el canal sigue vivo. Si esto se rompe, el cliente pierde el WhatsApp por
        // el que pide, y se entera cuando tenga hambre.
        expect(d.estado).toBeUndefined();
        expect(d.estado).not.toBe(optout.ESTADO_BLOQUEADA);
        // Se le contesta (al revés que la baja dura, que calla): tiene que saber que se registró,
        // porque la duda de si se registró es justo lo que lleva a bloquear el número.
        expect(d.respuestas).toHaveLength(1);
        expect(String(d.respuestas[0])).toMatch(/no te mandamos más promociones/i);
        // Y no se paga ni flujo ni modelo por esto.
        expect(visto.determinista).toBe(0);
        expect(visto.llm).toBe(0);
    });

    test('guarda la prueba: el texto con el que la pidió y el turno donde quedó', async () => {
        const audiencia = audienciaFalsa();
        const { manejador } = hacerEscalera(audiencia);

        await manejador(entrada('no quiero publicidad'));

        expect(audiencia.escrito.excluidos[0].prueba).toMatchObject({
            texto: 'no quiero publicidad',
            canal: 'whatsapp',
            wamid: 't1',
        });
    });

    test('deja rastro en el Ledger de por qué se decidió', async () => {
        const { manejador } = hacerEscalera(audienciaFalsa());

        const d = await manejador(entrada('no promos'));

        expect((d.pasos || []).some((p) => p.decision === 'promos_baja')).toBe(true);
    });
});

describe('cuando el cliente pide la baja DURA (STOP/BAJA)', () => {
    test('bloquea, se calla Y lo saca también de la audiencia', async () => {
        const audiencia = audienciaFalsa();
        const { manejador } = hacerEscalera(audiencia);

        const d = await manejador(entrada('BAJA'));

        expect(d.estado).toBe(optout.ESTADO_BLOQUEADA);
        expect(d.respuestas).toHaveLength(0);
        // El agujero que esto cierra: sin esta línea la ficha seguiría contactable.
        expect(audiencia.escrito.excluidos).toHaveLength(1);
    });
});

describe('un mensaje normal', () => {
    test('no toca la audiencia y sigue su camino', async () => {
        const audiencia = audienciaFalsa();
        const { manejador, visto } = hacerEscalera(audiencia);

        await manejador(entrada('quiero una hamburguesa sin cebolla'));

        expect(audiencia.escrito.excluidos).toHaveLength(0);
        expect(visto.determinista + visto.llm).toBe(1);
    });
});

// ── La regresión que de verdad importa ──────────────────────────────────────────────────

describe('el flujo de un pedido', () => {
    /**
     * Pinta la decisión de NO preguntar nunca.
     *
     * Hubo una versión —el 2026-10-12, viva unas horas— en la que la confirmación del pedido
     * llevaba pegada la pregunta «¿quieres recibir promociones?». Se eliminó porque nadie pregunta
     * eso y porque alarga el único mensaje que el cliente sí quería leer. Esta prueba es lo que
     * impide que vuelva sin que nadie lo note: si alguien añade una línea a la confirmación,
     * falla aquí.
     */
    test('la confirmación dice EXACTAMENTE lo del `hecho` de la capacidad, sin una letra más', async () => {
        const ctx = {
            idNegocio: NEGOCIO,
            texto: 'sí',
            turno: { id_turno: 't9' },
            invocaciones: [],
            principal: { telefono_verificado: TELEFONO },
            conversacion: conversacion({
                variables: { turnos: 4 },
                tarea_actual: confirmacion.TAREA,
                tarea_datos: {
                    capacidad: 'tomar_pedido',
                    args: { items: [] },
                    preguntado_en: new Date().toISOString(),
                },
            }),
        };

        const decision = await confirmacion.resolver(ctx, {
            gate: { async ejecutar() { return { resultado: { numero_orden: 42 } }; } },
            registry: {
                obtener: () => ({
                    confirmacion: { hecho: () => '¡Listo! Tu pedido quedó tomado. El número es 42.' },
                }),
            },
        });

        expect(decision.respuestas).toHaveLength(1);
        expect(String(decision.respuestas[0])).toBe('¡Listo! Tu pedido quedó tomado. El número es 42.');
        expect(String(decision.respuestas[0])).not.toMatch(/promo/i);
        // Y no se queda ninguna variable de sesión sobre promociones.
        expect(Object.keys(decision.variables || {}).some((k) => /promo/i.test(k))).toBe(false);
    });
});
