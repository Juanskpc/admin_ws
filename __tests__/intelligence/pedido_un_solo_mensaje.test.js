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
 * bueno y el resultado no: un turno y una espera por cada dato que el cliente tiene en la cabeza
 * a la vez.
 *
 * ## Lo difícil no es preguntar, es leer la respuesta
 *
 * Una respuesta suelta trae el celular y la dirección mezclados, y **una dirección está llena de
 * números**. Por eso el intérprete solo reconoce lo inequívoco —un celular colombiano— y trata la
 * dirección como lo que sobra. Lo que no entiende, lo vuelve a preguntar; lo que sí, **no se
 * pierde nunca**: hacerle repetir la dirección porque no se entendió el teléfono sería
 * castigarle por haber contestado.
 *
 * > El paso del método de pago se retiró el 2026-08-27 por decisión del dueño. Ver
 * > `docs/asistente-restaurante.md`.
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

const TODO = [PASO_PEDIDO.TELEFONO, PASO_PEDIDO.DIRECCION];

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
        const r = interpretarDatos('Calle 45 #12-30 apto 502, barrio El Prado. Mi cel es 3152812484', {
            faltan: TODO,
        });
        expect(r).toEqual({
            telefono: '3152812484',
            // Sin el «Mi cel es» colgando: eso se guarda en la orden y se imprime en la comanda.
            direccion: 'Calle 45 #12-30 apto 502, barrio El Prado',
        });
    });

    test('en dos líneas, como lo pide el mensaje', () => {
        const r = interpretarDatos('3001234567\nCra 7 #45-12, casa blanca', { faltan: TODO });
        expect(r.telefono).toBe('3001234567');
        expect(r.direccion).toBe('Cra 7 #45-12, casa blanca');
    });

    test('con etiquetas delante', () => {
        const r = interpretarDatos('dirección: Av. Boyacá 100 apto 502, tel 3009998877', {
            faltan: TODO,
        });
        expect(r.direccion).toBe('Av. Boyacá 100 apto 502');
        expect(r.telefono).toBe('3009998877');
    });

    test('LA REGRESIÓN: una letra suelta detrás de un número es parte de la dirección', () => {
        // «Carrera 3e 19 a» es el ejemplo canónico del proyecto. La primera versión de la
        // limpieza se comió la «a» y devolvía «Carrera 3e 19»: otra casa. Lo cazó un test viejo.
        const r = interpretarDatos('Carrera 3e 19 a', { faltan: [PASO_PEDIDO.DIRECCION] });
        expect(r.direccion).toBe('Carrera 3e 19 a');
    });

    test('una palabra de relleno DENTRO de la dirección no se toca', () => {
        // «Contacto» está en la lista de relleno. Solo se limpian los bordes.
        const r = interpretarDatos('vereda El Contacto, casa 3', { faltan: [PASO_PEDIDO.DIRECCION] });
        expect(r.direccion).toBe('vereda El Contacto, casa 3');
    });

    test('lo que no se reconoce simplemente no sale', () => {
        expect(interpretarDatos('jajaja no te digo', { faltan: TODO })).toEqual({});
    });

    test('solo se busca lo que se preguntó', () => {
        // Si el teléfono ya lo probó el canal, un número suelto en el texto no lo pisa.
        const r = interpretarDatos('Calle 45 #12-30, mi cel 3152812484', {
            faltan: [PASO_PEDIDO.DIRECCION],
        });
        expect(r.telefono).toBeUndefined();
    });
});

// ── Qué se pregunta, y cuándo ───────────────────────────────────────────────────────────────

describe('huecosDelCliente', () => {
    test('con teléfono probado por el canal, ese hueco no existe', () => {
        expect(huecosDelCliente({}, { telefonoProbado: '573000000000' })).toEqual([
            PASO_PEDIDO.DIRECCION,
        ]);
    });

    test('sin teléfono probado se piden los dos', () => {
        expect(huecosDelCliente({}, { telefonoProbado: null })).toEqual(TODO);
    });

    test('con todo puesto no queda ninguno', () => {
        expect(huecosDelCliente({ direccion: 'Calle 1' }, { telefonoProbado: '57300' })).toEqual([]);
    });
});

// ── El flujo, de punta a punta ──────────────────────────────────────────────────────────────

function crear({ telefonoProbado = null } = {}) {
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
    test('a quien llegó sin número, tras el nombre le pide teléfono y dirección JUNTOS', async () => {
        const conversacion = enPaso(PASO_PEDIDO.NOMBRE);
        delete conversacion.tarea_datos.nombre;

        const d = await decir(crear(), conversacion, 'Nicolás Pantoja');

        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DATOS);
        const texto = textos(d)[0];
        expect(texto).toContain('todo junto');
        expect(texto).toContain('número de contacto');
        expect(texto).toContain('La dirección');
    });

    test('contesta todo junto y se confirma de una', async () => {
        const d = await decir(
            crear(),
            enPaso(PASO_PEDIDO.DATOS),
            'Calle 45 #12-30, barrio El Prado. Mi cel 3152812484'
        );

        expect(decisiones(d)).toContain('pedido_datos_recibidos');
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args.direccion).toBe('Calle 45 #12-30, barrio El Prado');
        expect(d.tarea.datos.args.cliente_telefono).toBe('3152812484');
    });

    test('contesta a medias: se guarda lo que dio y se pregunta SOLO lo que falta', async () => {
        const d = await decir(crear(), enPaso(PASO_PEDIDO.DATOS), 'mi celular es 3152812484');

        // El teléfono quedó apuntado…
        expect(d.tarea.datos.telefono).toBe('3152812484');
        // …y ahora solo falta la dirección, que se pregunta sola.
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(textos(d)[0]).toMatch(/dirección/i);
    });

    test('no se entiende nada: se repregunta entero, sin perder el pedido', async () => {
        const d = await decir(crear(), enPaso(PASO_PEDIDO.DATOS), 'jajaja adivina');

        expect(decisiones(d)).toContain('pedido_datos_no_entendidos');
        expect(textos(d)[0]).toContain('no logré sacar los datos');
        // El carrito sigue ahí: perderlo obligaría a armarlo otra vez.
        expect(d.tarea.datos.items).toHaveLength(1);
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DATOS);
    });

    test('con el número ya probado, el único hueco es la dirección y se pregunta sola', async () => {
        const conversacion = enPaso(PASO_PEDIDO.NOMBRE);
        delete conversacion.tarea_datos.nombre;

        const d = await decir(crear({ telefonoProbado: '573000000000' }), conversacion, 'Nicolás');

        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(textos(d)[0]).not.toContain('todo junto');
    });
});
