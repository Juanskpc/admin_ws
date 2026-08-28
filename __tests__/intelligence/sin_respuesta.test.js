/**
 * El turno que no contesta nada — el fallo caro de este sistema.
 *
 * ## De dónde sale
 *
 * Del 2026-08-27. El dueño puso a trabajar al modelo con una conversación larga y **tres turnos
 * murieron en silencio**: #58 (11 302 ms, el turno más lento jamás registrado), #60 y #61. En el
 * Ledger se ve la cadena entera:
 *
 * ```
 * #58 s3 | error | NIVEL4_FALLO | "(args.items || []).reduce is not a function"
 * #58 s4 | regla | cedido_al_modelo | {}          ← y ahí se acabó
 * ```
 *
 * Dos fallos apilados, y ninguno era una excepción sin atrapar:
 *
 *   1. **La pregunta de confirmación reventó.** `tomar_pedido.pregunta` hace `.reduce` sobre
 *      `args.items`, y corre sobre los argumentos **crudos del modelo**, antes de que nadie los
 *      valide. El modelo mandó la lista serializada —cosa conocida desde el 26, y para la que el
 *      *validador* ya estaba preparado— y la redacción del mensaje se cayó.
 *   2. **El paracaídas no tenía tela.** Al fallar el Nivel 4 se baja al flujo determinista; el
 *      flujo no reconoció el mensaje y llamó a `delegar()`, que se llama a sí mismo
 *      «cedido_al_modelo» y devuelve **cero mensajes**. Nadie recogía esa cesión, y el modelo era
 *      justo lo que acababa de fallar.
 *
 * ## Lo que se prueba aquí
 *
 * Que **ningún camino pueda acabar sin una palabra**. Cada test rompe algo a propósito: la
 * pregunta lanza, el modelo lanza, el modelo calla, el flujo cede, no hay modelo. En todos, el
 * cliente sale con algo.
 *
 * Correr con:  npx jest __tests__/intelligence/sin_respuesta.test.js
 */
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');
const confirmacion = require('../../intelligence/engine/confirmacion');
const { comoLista } = require('../../intelligence/core/argumentos');

// ── La normalización que faltaba en un sitio ────────────────────────────────────────────────

describe('comoLista', () => {
    test('desenvuelve una lista serializada, que es lo que manda el modelo a veces', () => {
        expect(comoLista('[{"id_producto":106,"cantidad":2}]')).toEqual([
            { id_producto: 106, cantidad: 2 },
        ]);
    });

    test('un array se devuelve tal cual', () => {
        expect(comoLista([{ cantidad: 1 }])).toEqual([{ cantidad: 1 }]);
    });

    test('lo que no es una lista se devuelve sin tocar, para que quien valide lo rechace', () => {
        // El código compacto del carrito copiado tal cual. No es una lista, y fingir que sí
        // lo es sería peor que rechazarlo.
        expect(comoLista('106x1,109x1')).toBe('106x1,109x1');
    });
});

// ── La pregunta de confirmación no puede tumbar el turno ────────────────────────────────────

describe('textoDePregunta', () => {
    const registryQueLanza = {
        obtener: () => ({
            confirmacion: {
                pregunta: () => {
                    throw new TypeError('(args.items || []).reduce is not a function');
                },
            },
        }),
    };

    test('una pregunta que revienta NO propaga: se degrada la redacción, no la garantía', () => {
        const texto = confirmacion.textoDePregunta(
            'tomar_pedido',
            { items: '[{"id_producto":106,"cantidad":1}]' },
            { registry: registryQueLanza }
        );
        // Se sigue preguntando. Que se pregunte es ADR-010; cómo se redacte, no.
        expect(texto).toBe('¿Confirmo que lo hago?');
    });

    test('la de tomar_pedido ya no revienta con la lista serializada', () => {
        // El manifiesto real, no un doble: es la línea exacta que falló en producción.
        require('../../intelligence/adapters/restaurante').registrarCapacidades();
        const registry = require('../../intelligence/core/registry');

        const texto = confirmacion.textoDePregunta(
            'tomar_pedido',
            {
                items: '[{"id_producto":106,"cantidad":2},{"id_producto":109,"cantidad":1}]',
                cliente_nombre: 'Nicolás',
                direccion: 'Calle 45 #12-30',
            },
            { registry }
        );

        expect(texto).toContain('3 productos');
        expect(texto).toContain('Nicolás');
        expect(texto).toContain('Calle 45 #12-30');
    });
});

// ── Ningún camino puede acabar en silencio ──────────────────────────────────────────────────

const conversacion = () => ({
    id_conversacion: 'conv-1',
    id_negocio: 7,
    canal: 'whatsapp',
    id_externo: '573000000000',
    variables: {},
    tarea_actual: null,
    tarea_datos: {},
});

const entrada = (texto = 'algo que nadie sabe contestar') => ({
    conversacion: conversacion(),
    mensajes: [{ contenido: texto }],
    texto,
    turno: { id_turno: 't1' },
});

/** El `delegar()` del flujo de restaurante, tal cual: cede, y no dice nada. */
const flujoQueCede = async () => ({
    pasos: [{ tipo: 'regla', decision: 'cedido_al_modelo', motivo: {} }],
    respuestas: [],
    tarea: null,
    resultado: 'sin_respuesta',
    nivel: 'determinista',
});

const decisiones = (d) => (d.pasos || []).map((p) => p.decision);
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));

describe('la cesión al modelo, por fin recogida', () => {
    test('el Nivel 1 cede y el modelo contesta', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            llm: async () => ({ respuestas: ['te cuento…'], resultado: 'resuelto', nivel: 'llm' }),
            resolverNegocio: async () => null,
        });

        // «hola» es comando conocido: la tabla lo manda al Nivel 1, que es donde nace la
        // cesión. Con un texto libre la ruta ya sería LLM y no habría nada que ceder.
        const d = await manejar(entrada('hola'));

        expect(textos(d)).toEqual(['te cuento…']);
        expect(decisiones(d)).toContain('cesion_recogida');
    });

    test('el Nivel 1 cede y el modelo TAMBIÉN falla: sale el handoff, nunca el silencio', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            llm: async () => {
                throw new Error('proveedor caído');
            },
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('hola'));

        expect(textos(d)).toHaveLength(1);
        expect(textos(d)[0]).toMatch(/mensaje|contestan/i);
        expect(d.resultado).toBe('handoff');
    });

    test('el modelo contesta con la boca cerrada: también sale el handoff', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            llm: async () => ({ respuestas: [], resultado: 'resuelto' }),
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('hola'));

        expect(textos(d)).toHaveLength(1);
        expect(d.resultado).toBe('handoff');
    });

    test('un Nivel 4 MUDO por la ruta libre tampoco deja al cliente sin nada', async () => {
        // No lanza: devuelve una decisión válida y vacía. Para quien escribió es lo mismo.
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            llm: async () => ({ respuestas: [], resultado: 'resuelto', nivel: 'llm' }),
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('¿qué me recomiendas para el frío?'));

        expect(decisiones(d)).toContain('nivel4_mudo');
        expect(textos(d)).toHaveLength(1);
        expect(d.resultado).toBe('handoff');
    });

    test('sin Nivel 4 montado tampoco se calla', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('hola'));

        expect(textos(d)).toHaveLength(1);
        expect(d.resultado).toBe('handoff');
    });
});

describe('el respaldo del Nivel 4 caído', () => {
    test('EL CASO DE PRODUCCIÓN: el modelo revienta y el flujo cede — ya no hay silencio', async () => {
        // Reproduce #58 y #61 del 2026-08-27, tal cual: la ruta era LLM, el manejador de
        // Nivel 4 lanzó al redactar la confirmación, se bajó al flujo, y el flujo cedió.
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            llm: async () => {
                throw new TypeError('(args.items || []).reduce is not a function');
            },
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('¿qué me recomiendas para el frío?'));

        expect(decisiones(d)).toContain('NIVEL4_FALLO');
        expect(textos(d)).toHaveLength(1);
        expect(d.resultado).toBe('handoff');
    });

    test('si el respaldo SÍ tiene algo que decir, se respeta y no se pisa con el handoff', async () => {
        const manejar = crearManejadorEscalera({
            determinista: async () => ({
                respuestas: ['te dejo el menú'],
                resultado: 'resuelto',
                nivel: 'determinista',
            }),
            llm: async () => {
                throw new Error('proveedor caído');
            },
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('¿qué me recomiendas?'));

        expect(textos(d)).toEqual(['te dejo el menú']);
        expect(d.resultado).not.toBe('handoff');
    });
});

describe('lo que NO debe cambiar', () => {
    test('un turno que el Nivel 1 resuelve no sube al modelo (ADR-018)', async () => {
        let subio = false;
        const manejar = crearManejadorEscalera({
            determinista: async () => ({
                respuestas: ['resuelto aquí, gratis'],
                resultado: 'resuelto',
                nivel: 'determinista',
            }),
            llm: async () => {
                subio = true;
                return { respuestas: ['no debería'] };
            },
            resolverNegocio: async () => null,
        });

        // «hola» es comando conocido: ruta determinista, y ahí se queda.
        const d = await manejar(entrada('hola'));

        expect(subio).toBe(false);
        expect(textos(d)).toEqual(['resuelto aquí, gratis']);
        expect(decisiones(d)).not.toContain('cesion_recogida');
    });

    test('la baja sigue mandando sobre todo: no se cede ni se hace handoff', async () => {
        const manejar = crearManejadorEscalera({
            determinista: flujoQueCede,
            llm: async () => ({ respuestas: ['no debería'] }),
            resolverNegocio: async () => null,
        });

        const d = await manejar(entrada('STOP'));

        expect(decisiones(d)).not.toContain('cesion_recogida');
    });
});
