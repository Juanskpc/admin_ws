/**
 * La dirección que no lo parece.
 *
 * ## De dónde sale
 *
 * Del 2026-08-27, probando en producción: el dueño escribió una broma donde iba la dirección y
 * **el pedido se creó con ella**. No había ninguna comprobación, y había un motivo escrito para
 * no tenerla: quien sabe si «Carrera 3e 19 a» lleva a algún sitio es el domiciliario, no una
 * expresión regular.
 *
 * El motivo sigue siendo bueno, así que lo que se añadió **no valida**: repregunta una vez y
 * acepta a la segunda. El guardarraíl avisa; no manda.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_direccion.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const { pareceDireccion, crearFlujoRestaurante, TAREA_PEDIDO } = flujo;

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

// ── El flujo entero, con dobles ─────────────────────────────────────────────────────────────

function crear() {
    return crearFlujoRestaurante({
        contextoNegocio: { obtener: async () => ({ id: 12, nombre: 'Pregonchos', tratamiento: 'Pregonchos', atencion: null, tipoNegocio: 'RESTAURANTE' }) },
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
        expect(decisiones(d)).toContain('pedido_dato_recibido');
        // Ya no falta nada, así que se pide el sí: la dirección viaja en los argumentos.
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args.direccion).toBe('no te lo pienso decir jaja');
    });

    test('una dirección normal pasa a la primera y sin marcas', async () => {
        const d = await decir(crear(), enPaso('direccion'), 'Calle 45 #12-30, apto 302');

        expect(decisiones(d)).not.toContain('pedido_direccion_dudosa');
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args.direccion).toBe('Calle 45 #12-30, apto 302');
    });
});
