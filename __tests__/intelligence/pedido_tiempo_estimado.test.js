/**
 * «¿Cuánto se demora?» — el tiempo que declara cada negocio.
 *
 * ## De dónde sale
 *
 * De producción, 2026-10-01 (Zona Burger): es de las preguntas que más se repetían, y el bot
 * contestaba «no tengo el tiempo estimado, confírmalo con el negocio». Ahora cada local escribe
 * su estimado (p. ej. 40 a 60 minutos) en la configuración de la Bandeja, y el bot dice primero el
 * tiempo y luego la promesa amable: si sale antes, se avisa.
 *
 * Sin tiempo configurado no se inventa ninguno: se cede al modelo, como hasta hoy.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_tiempo_estimado.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const { esPreguntaDeTiempo, fraseDeTiempo, reclama, crearFlujoRestaurante, TAREA_PEDIDO } = flujo;

describe('esPreguntaDeTiempo', () => {
    test.each([
        'Cuánto se demora?',
        '¿Cuánto se demora el pedido?',
        'cuanto demora',
        'Cuánto tiempo tarda?',
        'cuanto tiempo se demoran en llegar',
        'Que tanto se demora',
        'en cuanto llega',
        '¿En cuánto tiempo está listo?',
        'tiempo de entrega?',
        'Hola, cuánto se demora el domicilio',
        'Cuanto demoran',
    ])('reconoce %j', (texto) => {
        expect(esPreguntaDeTiempo(texto)).toBe(true);
    });

    test.each([
        'Quiero una salchipapa criolla',
        'hola buenas noches',
        'sí',
        'Cuánto vale la criollita?',
        'cuanto es el total',
        // Un mensaje largo con «demora» dentro es un pedido o una queja, no esta pregunta.
        'si se demora mucho cancelo pero quiero dos salchipapas criollas y una gaseosa para llevar por favor',
        '',
    ])('NO reconoce %j', (texto) => {
        expect(esPreguntaDeTiempo(texto)).toBe(false);
    });

    test('lo que escribe en la última línea manda (mensaje con varias líneas)', () => {
        expect(esPreguntaDeTiempo('Buenas noches\ncuánto se demora')).toBe(true);
    });

    test('el enrutador la reclama para el flujo, sin gastar un modelo', () => {
        expect(reclama('cuánto se demora?')).toBe(true);
        expect(reclama('quiero una hamburguesa')).toBe(false);
    });
});

describe('fraseDeTiempo', () => {
    test('un rango: el dato primero y la promesa después', () => {
        expect(fraseDeTiempo({ min: 40, max: 60 })).toBe(
            'El tiempo estimado de tu pedido es de *40 a 60 minutos* ⏱️. Si está listo antes, te avisaremos 😊'
        );
    });

    test('un solo valor: «unos X minutos»', () => {
        expect(fraseDeTiempo({ min: 45, max: null })).toContain('de unos *45 minutos*');
        // Un rango degenerado (min = max) se dice como un solo valor.
        expect(fraseDeTiempo({ min: 30, max: 30 })).toContain('de unos *30 minutos*');
    });

    test('sin configurar (o basura) no se inventa un tiempo', () => {
        expect(fraseDeTiempo(null)).toBeNull();
        expect(fraseDeTiempo(undefined)).toBeNull();
        expect(fraseDeTiempo({ min: 0, max: 10 })).toBeNull();
        expect(fraseDeTiempo({ min: 'mucho' })).toBeNull();
    });
});

// ── El flujo entero, con dobles ─────────────────────────────────────────────────────────────

function crear(tiempoEstimado, { hayPedido = true } = {}) {
    return crearFlujoRestaurante({
        tienePedidoReciente: async () => hayPedido,
        contextoNegocio: {
            obtener: async () => ({
                id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                tipoNegocio: 'RESTAURANTE', tiempoEstimado,
            }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        ahora: () => new Date('2026-10-01T20:00:00-05:00'),
        catalogo: {
            barrios: async () => ({ habilitado: false, barrios: [] }),
            mesas: async () => [],
            resolverBarrio: async () => null,
            resolverMesa: async () => null,
            resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
        },
    });
}

const sinTarea = () => ({
    id_conversacion: 'conv-1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
    variables: { turnos: 2, nombre: 'Ana' }, tarea_actual: null, tarea_datos: {},
});
const enPaso = (paso) => ({
    ...sinTarea(),
    tarea_actual: TAREA_PEDIDO,
    tarea_datos: { items: [{ id_producto: 30, cantidad: 1 }], nombre: 'Ana', entrega: 'DOMICILIO', paso, repreguntas: 0 },
});

const decir = (manejar, conversacion, texto) =>
    manejar({ conversacion, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });
const decisiones = (d) => (d.pasos || []).map((p) => p.decision);
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));

describe('el flujo contesta con el tiempo del negocio', () => {
    test('EL CASO: «¿cuánto se demora?» → el tiempo del local y la promesa de avisar', async () => {
        const d = await decir(crear({ min: 40, max: 60 }), sinTarea(), 'Cuánto se demora?');

        expect(decisiones(d)).toContain('tiempo_estimado_respondido');
        expect(textos(d)).toEqual([
            'El tiempo estimado de tu pedido es de *40 a 60 minutos* ⏱️. Si está listo antes, te avisaremos 😊',
        ]);
        expect(d.resultado).toBe('resuelto');
        expect(d.nivel).toBe('determinista');
    });

    // Zona Burger, 2026-10-02: «¿en cuánto está?» sin ningún pedido tomado se contestó «el tiempo
    // de TU pedido es de 40 a 60 minutos», y la clienta se fue a pagar un pedido inexistente.
    test('SIN pedido en el chat: no dice «tu pedido» y avisa de que todavía no hay ninguno', async () => {
        const d = await decir(crear({ min: 40, max: 60 }, { hayPedido: false }), sinTarea(), 'en cuánto está?');

        const [texto] = textos(d);
        expect(texto).not.toContain('tu pedido es');
        expect(texto).toContain('*40 a 60 minutos*');
        expect(texto).toContain('Todavía no tengo ningún pedido tuyo');
        expect(d.pasos.find((p) => p.decision === 'tiempo_estimado_respondido').motivo.hay_pedido).toBe(false);
    });

    test('sin tiempo configurado → no se inventa nada: lo cede al modelo', async () => {
        const d = await decir(crear(null), sinTarea(), 'cuánto se demora?');

        expect(decisiones(d)).toContain('cedido_al_modelo');
        expect(d.respuestas).toHaveLength(0);
    });

    test('a mitad de un pedido: responde el tiempo Y retoma la pregunta, sin soltar la tarea', async () => {
        const conv = enPaso('direccion');
        const d = await decir(crear({ min: 30, max: null }), conv, 'cuánto se demora');

        const [texto] = textos(d);
        // Aún no hay pedido: el tiempo se dice «desde que se confirma», no «tu pedido».
        expect(texto).toContain('unos *30 minutos*');
        expect(texto).toContain('desde que se confirman');
        expect(texto).not.toContain('tu pedido es');
        // La pregunta que estaba pendiente sigue ahí, después de la respuesta.
        expect(texto.indexOf('minutos')).toBeLessThan(texto.indexOf('dirección'));
        // La tarea sigue abierta en el mismo paso y NO se cuenta como una respuesta equivocada.
        expect(d.tarea.datos.paso).toBe('direccion');
        expect(d.tarea.datos.direccion).toBeUndefined();
        expect(Number(d.tarea.datos.repreguntas || 0)).toBe(0);
    });

    test('a mitad de un pedido y sin tiempo configurado: sigue como siempre (no se rompe)', async () => {
        const d = await decir(crear(null), enPaso('direccion'), 'cuánto se demora');

        // Hoy un texto así dentro del pedido se trata como respuesta al paso: no es cosa de esta
        // función cambiarlo. Lo único que se exige es que no conteste con un tiempo inventado.
        expect(textos(d).join(' ')).not.toMatch(/tiempo estimado/i);
    });
});
