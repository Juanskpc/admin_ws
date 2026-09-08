/**
 * Domicilio o recoger: el paso que decide si la dirección hace falta.
 *
 * ## De dónde sale
 *
 * Del 2026-09-07, del dueño: «en mi municipio, o al menos nuestra familia, suele hacer pedidos
 * para ir a recoger, para no gastar el valor del domicilio». Hasta ese día el asistente daba por
 * hecho que todo pedido era un domicilio —`tipoPedido: 'DOMICILIO'` estaba escrito a fuego en la
 * capacidad— y le pedía la dirección a todo el mundo, incluido a quien iba a pasar por el local.
 *
 * ## Por qué este paso tiene fichero propio
 *
 * Porque es el único del flujo donde equivocarse **cuesta comida**. Los demás pasos, mal leídos,
 * producen un dato feo: un pedido a nombre de una pregunta, una dirección con «mi cel es»
 * colgando. Éste, mal leído, manda una moto a una dirección que nadie dio, o deja a alguien
 * esperando en el mostrador un pedido que salió en moto hace veinte minutos.
 *
 * Y tiene una trampa idiomática de verdad: **«llevar» significa las dos cosas**. «Para llevar»
 * es lo que se dice en el mostrador y quiere decir que pasa por él; «me lo llevan» quiere decir
 * lo contrario. Por eso la frase se acepta y la palabra suelta no.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_entrega.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const {
    crearFlujoRestaurante,
    leerEntrega,
    huecosDelCliente,
    TAREA_PEDIDO,
    PASO_PEDIDO,
    ENTREGA,
} = flujo;

// ── Leer la respuesta ───────────────────────────────────────────────────────────────────────

describe('leerEntrega', () => {
    test.each([
        'domicilio',
        'a domicilio',
        'Domicilio por favor',
        'me lo mandan',
        'que me lo lleven',
        'envío',
        'delivery',
    ])('%j es domicilio', (texto) => {
        expect(leerEntrega(texto)).toBe(ENTREGA.DOMICILIO);
    });

    test.each([
        'recoger',
        'paso a recogerlo',
        'yo recojo',
        'voy y lo recojo',
        'para llevar',
        'lo retiro yo',
    ])('%j es recoger', (texto) => {
        expect(leerEntrega(texto)).toBe(ENTREGA.RECOGER);
    });

    test('LA TRAMPA: «llevar» a secas no se decide', () => {
        // «Para llevar» = paso por él. «Me lo llevan» = lo contrario. La palabra sola no basta,
        // y adivinar aquí es lo único de este flujo que cuesta comida.
        expect(leerEntrega('llevar')).toBeNull();
        expect(leerEntrega('llevarlo')).toBeNull();
    });

    test('la frase de dos palabras sí decide, y gana a la palabra suelta', () => {
        expect(leerEntrega('para llevar')).toBe(ENTREGA.RECOGER);
    });

    test('las dos familias a la vez tampoco se deciden', () => {
        // No se elige por orden ni por mayoría: se repregunta, que cuesta un mensaje.
        expect(leerEntrega('domicilio o recoger?')).toBeNull();
    });

    test('lo que no dice nada devuelve null', () => {
        expect(leerEntrega('bueno')).toBeNull();
        expect(leerEntrega('')).toBeNull();
        expect(leerEntrega('una hamburguesa')).toBeNull();
    });

    test('se queda con la ÚLTIMA línea de la ráfaga', () => {
        // El debounce junta la ráfaga en un turno. Lo último que dijo la persona es su
        // intención actual: con «alguna» línea, un «domicilio… no, mejor recojo» saldría mal.
        expect(leerEntrega('domicilio\nno espera\nmejor recojo')).toBe(ENTREGA.RECOGER);
    });
});

// ── El paso, dentro del flujo ───────────────────────────────────────────────────────────────

function crear({ telefonoProbado = '573000000000' } = {}) {
    return crearFlujoRestaurante({
        contextoNegocio: {
            obtener: async () => ({
                id: 12,
                nombre: 'Pregonchos',
                tratamiento: 'Pregonchos',
                atencion: null,
                tipoNegocio: 'RESTAURANTE',
            }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: telefonoProbado } }) },
        gate: {},
        ahora: () => new Date('2026-09-07T18:00:00-05:00'),
    });
}

function enEntrega(extra = {}) {
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
            paso: PASO_PEDIDO.ENTREGA,
            ...extra,
        },
    };
}

const decir = (manejar, conversacion, texto) =>
    manejar({ conversacion, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });

const decisiones = (d) => (d.pasos || []).map((p) => p.decision);
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));

describe('el paso de la entrega', () => {
    test('la pregunta dice las dos palabras que valen', async () => {
        const d = await decir(crear(), enEntrega(), 'llevar');

        // Se repregunta, y el mensaje enseña las palabras que el Nivel 1 sabe reconocer: es lo
        // que hace que la siguiente respuesta llegue en una palabra.
        const texto = textos(d)[0];
        expect(texto).toMatch(/\*domicilio\*/);
        expect(texto).toMatch(/\*recoger\*/);
    });

    test('para recoger NO se pide la dirección: se pasa directo a confirmar', async () => {
        const d = await decir(crear(), enEntrega(), 'paso a recogerlo');

        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args.tipo_entrega).toBe(ENTREGA.RECOGER);
        expect(d.tarea.datos.args.direccion).toBeUndefined();
    });

    test('a domicilio sí se pide la dirección antes de confirmar', async () => {
        const d = await decir(crear(), enEntrega(), 'domicilio');

        expect(d.tarea.nombre).toBe(TAREA_PEDIDO);
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(d.tarea.datos.entrega).toBe(ENTREGA.DOMICILIO);
        expect(textos(d)[0]).toMatch(/dirección/i);
    });

    test('lo que no se entiende se repregunta, y NO se elige por defecto', async () => {
        // El fallo caro sería suponer domicilio: una moto saliendo a una dirección que nadie dio.
        const d = await decir(crear(), enEntrega(), 'bueno dale');

        expect(decisiones(d)).toContain('pedido_entrega_no_entendida');
        expect(d.tarea.datos.entrega).toBeUndefined();
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.ENTREGA);
        // Y siempre se ofrece la salida: sin ella, quien no quiera contestar queda atrapado.
        expect(textos(d)[0]).toMatch(/cancelar/i);
    });

    test('cómo lo recibe entra en los argumentos que se van a ejecutar', async () => {
        const d = await decir(crear(), enEntrega(), 'domicilio');
        // Todavía no está en `args` —falta la dirección—, pero sí guardado en la tarea: es lo
        // que hace que la siguiente pregunta sea la correcta y no se pierda al reanudar.
        expect(d.tarea.datos.entrega).toBe(ENTREGA.DOMICILIO);
    });

    test('«cancelar» sigue cancelando desde este paso', async () => {
        const d = await decir(crear(), enEntrega(), 'cancelar');

        expect(d.tarea).toBeNull();
        expect(textos(d)[0]).toMatch(/no te lo apunto/i);
    });

    test('a quien llegó sin número, para recoger se le pide el teléfono con OTRO motivo', async () => {
        // El dato es el mismo; la razón, no. En un domicilio es para que el domiciliario llame
        // desde la puerta; aquí es para poder avisarle cuando esté listo.
        const d = await decir(crear({ telefonoProbado: null }), enEntrega(), 'recoger');

        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.TELEFONO);
        expect(textos(d)[0]).toMatch(/avisarte en cuanto esté listo/i);
        expect(textos(d)[0]).not.toMatch(/domiciliario/i);
        // Y la dirección no aparece por ningún lado.
        expect(huecosDelCliente(d.tarea.datos, { telefonoProbado: null })).not.toContain(
            PASO_PEDIDO.DIRECCION
        );
    });
});

// ── La capacidad: lo que se le pregunta al cliente antes de crear nada ──────────────────────
//
// Se lee del Registry de verdad y no de una copia, porque la pregunta de confirmación es el
// último punto donde el cliente puede cazar que le entendimos al revés. Una copia en el test
// diría que todo está bien el día que la de producción cambie.

describe('la confirmación de tomar_pedido', () => {
    const registry = require('../../intelligence/core/registry');
    const adaptador = require('../../intelligence/adapters/restaurante');

    beforeAll(() => adaptador.registrarCapacidades());
    afterAll(() => registry._limpiar());

    const preguntar = (args) =>
        registry.obtener('tomar_pedido').confirmacion.pregunta({
            args: { items: [{ id_producto: 106, cantidad: 2 }], cliente_nombre: 'Ana', ...args },
        });

    test('para recoger dice que es en el local, y NO habla de ninguna dirección', () => {
        const q = preguntar({ tipo_entrega: 'LLEVAR' });
        expect(q).toMatch(/recogerlo en el local/i);
        expect(q).not.toMatch(/undefined/);
    });

    test('a domicilio dice a dónde va', () => {
        const q = preguntar({ tipo_entrega: 'DOMICILIO', direccion: 'Carrera 3e 19 a' });
        expect(q).toMatch(/llevártelo a Carrera 3e 19 a/i);
    });

    test('la dirección es obligatoria SOLO en domicilio', () => {
        const { parametros } = registry.obtener('tomar_pedido');
        // Declararla obligatoria impediría el pedido para recoger; la regla entre los dos
        // argumentos la comprueba `ejecutar`, que es quien los ve a la vez.
        expect(parametros.direccion.requerido).toBe(false);
        // El tipo de entrega, en cambio, sí: sin valor por defecto, para que nadie suponga
        // un domicilio que nadie pidió.
        expect(parametros.tipo_entrega.requerido).toBe(true);
        expect(parametros.tipo_entrega.valores).toEqual(['DOMICILIO', 'LLEVAR']);
    });
});
