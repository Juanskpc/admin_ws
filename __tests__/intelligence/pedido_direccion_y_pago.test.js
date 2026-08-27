/**
 * El pedido: la dirección que no lo parece, y a dónde se paga.
 *
 * ## De dónde salen los dos
 *
 * Del 2026-08-27, probando en producción:
 *
 *   1. El dueño escribió una broma donde iba la dirección y **el pedido se creó con ella**. No
 *      había ninguna comprobación, y había un motivo escrito para no tenerla: quien sabe si
 *      «Carrera 3e 19 a» lleva a algún sitio es el domiciliario, no una expresión regular. El
 *      motivo sigue siendo bueno, así que lo que se añadió **no valida**: repregunta una vez y
 *      acepta a la segunda. El guardarraíl avisa; no manda.
 *   2. El asistente saltó el paso del pago en seis pedidos seguidos. Correctamente —el negocio
 *      tenía cero métodos configurados— y de forma pésima: un domicilio en el que nadie dice
 *      cómo se paga es una discusión en la puerta. Ahora hay métodos por defecto, y cada uno
 *      puede llevar a dónde se paga.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_direccion_y_pago.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const { pareceDireccion, textoDelPago, crearFlujoRestaurante, TAREA_PEDIDO } = flujo;

// ── La heurística de la dirección ───────────────────────────────────────────────────────────

describe('pareceDireccion', () => {
    // Direcciones reales, incluidas las que NO siguen la nomenclatura. Rechazar una de éstas
    // sería peor que aceptar una broma: deja a alguien sin poder pedir.
    test.each([
        'Calle 45 #12-30',
        'Cra 3e 19 a',
        'Av. Boyacá 100 apto 502',
        'Diagonal 22 sur, torre 4',
        'el conjunto de siempre, casa blanca',
        'Km 3 vía La Calera',
        'Barrio El Prado, casa esquinera',
    ])('acepta %j', (texto) => {
        expect(pareceDireccion(texto)).toBe(true);
    });

    test.each([
        'jajaja',
        'ok',
        '😂',
        'no te lo pienso decir jaja',
        '   ',
        'aaa',
    ])('duda de %j', (texto) => {
        expect(pareceDireccion(texto)).toBe(false);
    });
});

// ── El texto del pago ───────────────────────────────────────────────────────────────────────

describe('textoDelPago', () => {
    test('pega los datos al nombre de cada método', () => {
        const t = textoDelPago([
            { id: 1, nombre: 'Efectivo', datos: null },
            { id: 2, nombre: 'Transferencia', datos: 'Nequi 315 281 2484' },
        ]);
        expect(t).toContain('*Efectivo*');
        expect(t).toContain('*Transferencia* — Nequi 315 281 2484');
    });

    test('un método sin datos no arrastra un guión suelto', () => {
        expect(textoDelPago([{ id: 1, nombre: 'Efectivo', datos: null }])).toBe(
            '¿Cómo vas a pagar? 💵'
        );
    });

    test('sin métodos no inventa nada', () => {
        expect(textoDelPago([])).toBe('¿Cómo vas a pagar? 💵');
    });
});

// ── El flujo entero, con dobles ─────────────────────────────────────────────────────────────

const METODOS = [
    { id: 19, nombre: 'Físico', datos: null },
    { id: 20, nombre: 'Transferencia', datos: 'Nequi 315 281 2484 a nombre de Pregonchos' },
];

function crear({ metodos = METODOS } = {}) {
    return crearFlujoRestaurante({
        contextoNegocio: { obtener: async () => ({ id: 12, nombre: 'Pregonchos', tratamiento: 'Pregonchos', atencion: null, tipoNegocio: 'RESTAURANTE' }) },
        leerMetodosPago: async () => metodos,
        // El teléfono ya viene probado por el canal, así que ese paso se salta.
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        ahora: () => new Date('2026-08-27T18:00:00-05:00'),
    });
}

/** Una conversación con el pedido a medias, esperando el dato que se diga. */
function enPaso(paso, extra = {}) {
    return {
        id_conversacion: 'conv-1',
        id_negocio: 12,
        canal: 'whatsapp',
        id_externo: '573000000000',
        variables: { turnos: 3, nombre: 'Nicolás' },
        tarea_actual: TAREA_PEDIDO,
        tarea_datos: {
            items: [{ id_producto: 106, cantidad: 1 }],
            metodos: METODOS,
            nombre: 'Nicolás',
            paso,
            ...extra,
        },
    };
}

const decir = (manejar, conversacion, texto) =>
    manejar({ conversacion, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });

const decisiones = (d) => (d.pasos || []).map((p) => p.decision);
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));

describe('la dirección, dentro del flujo', () => {
    test('una broma hace que se repregunte, y NO se apunta', async () => {
        const d = await decir(crear(), enPaso('direccion'), 'no te lo pienso decir jaja');

        expect(decisiones(d)).toContain('pedido_direccion_dudosa');
        expect(textos(d)[0]).toContain('no me quedó clara la dirección');
        // Se ofrece la salida, como en el resto del flujo.
        expect(textos(d)[0]).toContain('cancelar');
        // Nada apuntado, y la tarea sigue abierta con la marca puesta.
        expect(d.tarea.datos.direccion).toBeUndefined();
        expect(d.tarea.datos.direccion_dudosa).toBe(true);
    });

    test('si insiste, se acepta — y queda anotado que entró forzada', async () => {
        const d = await decir(
            crear(),
            enPaso('direccion', { direccion_dudosa: true }),
            'no te lo pienso decir jaja'
        );

        expect(decisiones(d)).not.toContain('pedido_direccion_dudosa');
        // Ya no falta nada salvo el pago, así que avanza.
        expect(decisiones(d)).toContain('pedido_dato_recibido');
        expect(d.tarea.datos.direccion).toBe('no te lo pienso decir jaja');
        expect(d.tarea.datos.direccion_forzada).toBe(true);
        expect(d.tarea.datos.direccion_dudosa).toBeUndefined();
    });

    test('una dirección normal pasa a la primera y sin marcas', async () => {
        const d = await decir(crear(), enPaso('direccion'), 'Calle 45 #12-30, apto 302');

        expect(decisiones(d)).not.toContain('pedido_direccion_dudosa');
        expect(d.tarea.datos.direccion).toBe('Calle 45 #12-30, apto 302');
        expect(d.tarea.datos.direccion_forzada).toBeUndefined();
    });
});

describe('el pago, dentro del flujo', () => {
    test('tras la dirección pregunta cómo paga, con los datos de cada cuenta', async () => {
        const d = await decir(crear(), enPaso('direccion'), 'Calle 45 #12-30');

        expect(d.tarea.datos.paso).toBe('pago');
        const texto = textos(d)[0];
        expect(texto).toContain('¿Cómo vas a pagar?');
        expect(texto).toContain('*Transferencia* — Nequi 315 281 2484 a nombre de Pregonchos');
        // Y las opciones estructuradas siguen yendo aparte, para que cada canal las pinte.
        expect(d.respuestas[0].opciones).toEqual([
            { id: '19', etiqueta: 'Físico' },
            { id: '20', etiqueta: 'Transferencia' },
        ]);
    });

    test('sin métodos configurados el paso se salta, como antes', async () => {
        // Es el comportamiento que dejó seis pedidos sin preguntar el 2026-08-27. Sigue siendo
        // el correcto cuando de verdad no hay ninguno: lo que cambió es que la migración
        // siembra Efectivo y Transferencia para que ese caso deje de darse.
        const conversacion = enPaso('direccion');
        conversacion.tarea_datos.metodos = [];

        const d = await decir(crear({ metodos: [] }), conversacion, 'Calle 45 #12-30');

        // Sin pago que preguntar ya no falta nada, así que salta directo a pedir el sí.
        // Es exactamente la secuencia que se vio en el Ledger seis veces seguidas.
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.capacidad).toBe('tomar_pedido');
        expect(d.tarea.datos.args.id_metodo_pago).toBeUndefined();
        expect(decisiones(d)).toContain('pedido_dato_recibido');
    });
});
