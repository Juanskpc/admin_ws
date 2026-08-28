/**
 * Los datos del cliente, en un solo mensaje.
 *
 * ## De dónde sale
 *
 * Del 2026-08-27, del dueño usándolo: «está pidiendo nombre, en ocasiones teléfono, dirección…
 * ¿hay manera de pedir todo lo necesario en un solo mensaje, excepto el nombre?».
 *
 * Hasta entonces se pedía de uno en uno, y estaba escrito por qué: «un cuestionario de cinco
 * campos es lo que se hace cuando al otro lado hay una persona leyendo a mano». El argumento era
 * bueno y el resultado no: cuatro turnos y cuatro esperas para tres datos que el cliente tiene en
 * la cabeza a la vez.
 *
 * ## Lo difícil no es preguntar, es leer la respuesta
 *
 * Una respuesta suelta trae la dirección, el celular y el método mezclados, y **una dirección
 * está llena de números**. Por eso el intérprete solo reconoce lo inequívoco —un celular
 * colombiano, un método que se nombra— y trata la dirección como lo que sobra. Lo que no
 * entiende, lo vuelve a preguntar; lo que sí, **no se pierde nunca**: hacerle repetir la
 * dirección porque no se entendió el pago sería castigarle por haber contestado.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_un_solo_mensaje.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const {
    crearFlujoRestaurante,
    interpretarDatos,
    leerTelefono,
    huecosDelCliente,
    TAREA_PEDIDO,
    PASO_PEDIDO,
} = flujo;

const METODOS = [
    { id: 19, nombre: 'Físico', datos: null },
    { id: 20, nombre: 'Transferencia', datos: 'Nequi 315 281 2484 a nombre de Pregonchos' },
];
const TODO = [PASO_PEDIDO.TELEFONO, PASO_PEDIDO.DIRECCION, PASO_PEDIDO.PAGO];

// ── Leer un teléfono que convive con una dirección ──────────────────────────────────────────

describe('leerTelefono', () => {
    test.each([
        ['3152812484', '3152812484'],
        ['+57 315 281 2484', '3152812484'],
        ['57 315-281-2484', '3152812484'],
        ['mi cel es 300.123.4567 gracias', '3001234567'],
    ])('saca %j', (texto, esperado) => {
        expect(leerTelefono(texto)).toBe(esperado);
    });

    test('NO confunde los números de una dirección con un teléfono', () => {
        // El caso que obliga a ser conservador: si esto devolviera algo, el domiciliario
        // llamaría a un número inventado, que es peor que no tener número.
        expect(leerTelefono('Calle 45 #12-30 apto 502')).toBeNull();
        expect(leerTelefono('Cra 7 #45-12')).toBeNull();
    });

    test('un fijo de siete dígitos se queda fuera a propósito', () => {
        // Es indistinguible de un número de calle. Se prefiere repreguntar.
        expect(leerTelefono('mi tel es 2456789')).toBeNull();
    });
});

// ── Sacar varias cosas de un mensaje suelto ─────────────────────────────────────────────────

describe('interpretarDatos', () => {
    test('todo en una línea, con relleno alrededor', () => {
        const r = interpretarDatos(
            'Calle 45 #12-30 apto 502, barrio El Prado. Mi cel es 3152812484 y pago con transferencia',
            { faltan: TODO, metodos: METODOS }
        );
        expect(r).toEqual({
            telefono: '3152812484',
            id_metodo_pago: 20,
            metodo_nombre: 'Transferencia',
            // Sin el «Mi cel es y pago con» colgando: eso se guarda en la orden y se imprime.
            direccion: 'Calle 45 #12-30 apto 502, barrio El Prado',
        });
    });

    test('en tres líneas, como lo pide el mensaje', () => {
        const r = interpretarDatos('3001234567\nCra 7 #45-12, casa blanca\nFísico', {
            faltan: TODO,
            metodos: METODOS,
        });
        expect(r.telefono).toBe('3001234567');
        expect(r.direccion).toBe('Cra 7 #45-12, casa blanca');
        expect(r.id_metodo_pago).toBe(19);
    });

    test('con etiquetas delante', () => {
        const r = interpretarDatos(
            'dirección: Av. Boyacá 100 apto 502, tel 3009998877, transferencia',
            { faltan: TODO, metodos: METODOS }
        );
        expect(r.direccion).toBe('Av. Boyacá 100 apto 502');
        expect(r.telefono).toBe('3009998877');
        expect(r.id_metodo_pago).toBe(20);
    });

    test('una palabra de relleno DENTRO de la dirección no se toca', () => {
        // «Contacto» está en la lista de relleno. Solo se limpian los bordes.
        const r = interpretarDatos('vereda El Contacto, casa 3', {
            faltan: [PASO_PEDIDO.DIRECCION],
            metodos: METODOS,
        });
        expect(r.direccion).toBe('vereda El Contacto, casa 3');
    });

    test('lo que no se reconoce simplemente no sale', () => {
        expect(interpretarDatos('jajaja no te digo', { faltan: TODO, metodos: METODOS })).toEqual({});
    });

    test('un método que este negocio no tiene no se inventa', () => {
        const r = interpretarDatos('pago en efectivo', { faltan: TODO, metodos: METODOS });
        expect(r.id_metodo_pago).toBeUndefined();
    });

    test('solo se busca lo que se preguntó', () => {
        // Si el teléfono ya lo probó el canal, un número en la dirección no lo pisa.
        const r = interpretarDatos('Calle 45 #12-30, mi cel 3152812484, transferencia', {
            faltan: [PASO_PEDIDO.DIRECCION],
            metodos: METODOS,
        });
        expect(r.telefono).toBeUndefined();
        expect(r.id_metodo_pago).toBeUndefined();
    });
});

// ── Qué se pregunta, y cuándo ───────────────────────────────────────────────────────────────

describe('huecosDelCliente', () => {
    test('con teléfono probado por el canal, ese hueco no existe', () => {
        const faltan = huecosDelCliente({ metodos: METODOS }, { telefonoProbado: '573000000000' });
        expect(faltan).toEqual([PASO_PEDIDO.DIRECCION, PASO_PEDIDO.PAGO]);
    });

    test('sin teléfono probado se piden los tres', () => {
        expect(huecosDelCliente({ metodos: METODOS }, { telefonoProbado: null })).toEqual(TODO);
    });

    test('sin métodos configurados el pago no se pregunta', () => {
        expect(huecosDelCliente({ metodos: [] }, { telefonoProbado: '57300' })).toEqual([
            PASO_PEDIDO.DIRECCION,
        ]);
    });
});

// ── El flujo, de punta a punta ──────────────────────────────────────────────────────────────

function crear({ metodos = METODOS, telefonoProbado = '573000000000' } = {}) {
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
        leerMetodosPago: async () => metodos,
        identidad: { resolver: async () => ({ principal: { telefono_verificado: telefonoProbado } }) },
        gate: {},
        ahora: () => new Date('2026-08-27T18:00:00-05:00'),
    });
}

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

describe('el flujo pregunta una vez y lee lo que llegue', () => {
    test('tras el nombre pide dirección y pago JUNTOS, sin botones', async () => {
        const conversacion = enPaso(PASO_PEDIDO.NOMBRE);
        delete conversacion.tarea_datos.nombre;

        const d = await decir(crear(), conversacion, 'Nicolás Pantoja');

        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DATOS);
        const texto = textos(d)[0];
        expect(texto).toContain('todo junto');
        expect(texto).toContain('La dirección');
        expect(texto).toContain('Cómo vas a pagar');
        expect(texto).toContain('Nequi 315 281 2484');
        // Un botón al lado de «mándame tu dirección» invita a pulsarlo y dejar el resto sin
        // contestar. Los botones vuelven solo si hay que repreguntar el pago a solas.
        expect(d.respuestas[0].opciones ?? []).toHaveLength(0);
    });

    test('el cliente contesta todo junto y se confirma de una', async () => {
        const d = await decir(
            crear(),
            enPaso(PASO_PEDIDO.DATOS),
            'Calle 45 #12-30, barrio El Prado. Pago con transferencia'
        );

        expect(decisiones(d)).toContain('pedido_datos_recibidos');
        // Ya no falta nada: se pide el sí.
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args.direccion).toBe('Calle 45 #12-30, barrio El Prado');
        expect(d.tarea.datos.args.id_metodo_pago).toBe(20);
    });

    test('contesta a medias: se guarda lo que dio y se pregunta SOLO lo que falta', async () => {
        const d = await decir(crear(), enPaso(PASO_PEDIDO.DATOS), 'Calle 45 #12-30, barrio El Prado');

        // La dirección quedó apuntada…
        expect(d.tarea.datos.direccion).toBe('Calle 45 #12-30, barrio El Prado');
        // …y ahora solo falta el pago, que se pregunta solo y CON sus botones.
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.PAGO);
        expect(textos(d)[0]).toContain('¿Cómo vas a pagar?');
        expect(d.respuestas[0].opciones).toEqual([
            { id: '19', etiqueta: 'Físico' },
            { id: '20', etiqueta: 'Transferencia' },
        ]);
    });

    test('no se entiende nada: se repregunta entero, sin perder el pedido', async () => {
        const conv = enPaso(PASO_PEDIDO.DATOS);
        const d = await decir(crear(), conv, 'jajaja adivina');

        expect(decisiones(d)).toContain('pedido_datos_no_entendidos');
        expect(textos(d)[0]).toContain('no logré sacar los datos');
        // El carrito sigue ahí: perderlo obligaría a armarlo otra vez.
        expect(d.tarea.datos.items).toHaveLength(1);
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DATOS);
    });

    test('una dirección que no lo parece no se cuela por venir mezclada', async () => {
        // El guardarraíl del 2026-08-27 sigue puesto en el camino combinado.
        const d = await decir(crear(), enPaso(PASO_PEDIDO.DATOS), 'jaja Transferencia');

        expect(d.tarea.datos.direccion).toBeUndefined();
        // Pero el método SÍ se guardó: lo que llegó bien no se tira.
        expect(d.tarea.datos.id_metodo_pago).toBe(20);
    });

    test('con un solo hueco se pregunta ese, no una lista de uno', async () => {
        const conversacion = enPaso(PASO_PEDIDO.NOMBRE, { direccion: 'Calle 45 #12-30' });
        delete conversacion.tarea_datos.nombre;

        const d = await decir(crear(), conversacion, 'Nicolás');

        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.PAGO);
        expect(textos(d)[0]).not.toContain('cositas');
    });
});
