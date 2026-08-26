/**
 * Enrutado del flujo determinista por clase de negocio.
 *
 * ## El fallo que estas pruebas existen para que no vuelva
 *
 * El 2026-08-24, con el canal ya apuntando a un restaurante en producción, un cliente escribió
 * «hola» y **no recibió nada**. El motor tenía un solo flujo determinista —el de agendar citas—
 * y su primer paso fue pedir `consultar_servicios`, una capacidad de `reserva`, sobre un negocio
 * que no la tiene ni debe tenerla. `CAPACIDAD_NO_HABILITADA`, turno en error, silencio.
 *
 * No se vio en ningún test porque todos los que había usaban un negocio de citas. Estas pruebas
 * corren sin base de datos a propósito: lo que se comprueba es el enrutado, no el dominio.
 */
'use strict';

const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');
const flujos = require('../../intelligence/engine/flujos');

function conversacion(idNegocio = 7) {
    return {
        id_conversacion: 'conv-1',
        id_negocio: idNegocio,
        canal: 'whatsapp',
        variables: {},
        tarea_actual: null,
        tarea_datos: {},
    };
}

function entrada(texto, idNegocio) {
    return { conversacion: conversacion(idNegocio), mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } };
}

/** Un manejador de mentira que solo dice quién es. */
const flujoQueDice = (quien) => async () => ({
    pasos: [],
    respuestas: [quien],
    variables: {},
    tarea: null,
    resultado: 'resuelto',
    nivel: 'determinista',
});

const negocioDeTipo = (tipo) => async (id) => ({ id, nombre: 'X', tratamiento: 'X', tipoNegocio: tipo });

beforeEach(() => flujos._limpiar());
afterAll(() => flujos._limpiar());

describe('a cada negocio, su flujo', () => {
    it('un restaurante recibe el flujo de restaurante, no el de citas', async () => {
        flujos.registrar({ vertical: 'reserva', tipos: ['RESERVA'], manejar: flujoQueDice('citas') });
        flujos.registrar({ vertical: 'restaurante', tipos: ['RESTAURANTE'], manejar: flujoQueDice('restaurante') });

        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('citas'),
            resolverNegocio: negocioDeTipo('RESTAURANTE'),
        });

        const d = await manejar(entrada('hola'));
        expect(d.respuestas).toEqual(['restaurante']);
    });

    it('un negocio de citas sigue recibiendo el de citas', async () => {
        flujos.registrar({ vertical: 'reserva', tipos: ['RESERVA'], manejar: flujoQueDice('citas') });

        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('por-defecto'),
            resolverNegocio: negocioDeTipo('RESERVA'),
        });

        const d = await manejar(entrada('hola'));
        expect(d.respuestas).toEqual(['citas']);
    });

    it('el tipo se compara sin importar mayúsculas ni espacios', async () => {
        flujos.registrar({ vertical: 'restaurante', tipos: ['restaurante'], manejar: flujoQueDice('restaurante') });

        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('por-defecto'),
            resolverNegocio: negocioDeTipo('  Restaurante  '),
        });

        expect((await manejar(entrada('hola'))).respuestas).toEqual(['restaurante']);
    });
});

describe('cuando no se sabe de qué negocio se trata', () => {
    it('un tipo que nadie declaró cae al flujo por defecto, no revienta', async () => {
        flujos.registrar({ vertical: 'reserva', tipos: ['RESERVA'], manejar: flujoQueDice('citas') });

        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('por-defecto'),
            resolverNegocio: negocioDeTipo('PARQUEADERO'),
        });

        expect((await manejar(entrada('hola'))).respuestas).toEqual(['por-defecto']);
    });

    it('si la base no responde, se atiende igual en vez de perder el turno', async () => {
        // Enrutar es una mejora; que enrutar pueda tumbar una conversación no lo sería.
        flujos.registrar({ vertical: 'restaurante', tipos: ['RESTAURANTE'], manejar: flujoQueDice('restaurante') });

        const manejar = crearManejadorEscalera({
            determinista: flujoQueDice('por-defecto'),
            resolverNegocio: async () => {
                throw new Error('conexión caída');
            },
        });

        expect((await manejar(entrada('hola'))).respuestas).toEqual(['por-defecto']);
    });
});

describe('el registro de flujos', () => {
    it('dos verticales no pueden reclamar el mismo tipo de negocio', async () => {
        // En producción esto se vería como «el bot contesta cosas de otro rubro», que es un
        // fallo carísimo de diagnosticar. Mejor que no arranque.
        flujos.registrar({ vertical: 'reserva', tipos: ['RESTAURANTE'], manejar: flujoQueDice('a') });

        expect(() =>
            flujos.registrar({ vertical: 'restaurante', tipos: ['RESTAURANTE'], manejar: flujoQueDice('b') })
        ).toThrow(/ya lo atiende/);
    });

    it('exige las tres piezas', () => {
        expect(() => flujos.registrar({ vertical: 'x', tipos: ['Y'] })).toThrow();
        expect(() => flujos.registrar({ tipos: ['Y'], manejar: flujoQueDice('a') })).toThrow();
    });
});

describe('el flujo de restaurante', () => {
    const { crearFlujoRestaurante, OPCION, enlaceDelMenu } = require('../../intelligence/adapters/restaurante/flujo');

    /** Lo que devuelve `leerCarta`: lo que cabe en el chat, y cuántos hay en total. */
    const CARTA = {
        productos: [
            { nombre: 'Hamburguesa doble', precio: 22000, es_popular: true },
            { nombre: 'Salchipapa especial', precio: 18000, es_popular: true },
            { nombre: 'Limonada de coco', precio: 8000, es_popular: false },
        ],
        total: 14,
    };

    const negocioFalso = {
        obtener: async (id) => ({ id, nombre: 'Pregonchos', tratamiento: 'Pregonchos', tipoNegocio: 'RESTAURANTE' }),
    };

    /** Las 15:00 en Bogotá. El saludo depende de la hora y una prueba no puede esperar. */
    const LAS_TRES = () => new Date('2026-08-26T20:00:00Z');

    const flujo = crearFlujoRestaurante({
        contextoNegocio: negocioFalso,
        leerCarta: async () => CARTA,
        ahora: LAS_TRES,
    });

    /** Una conversación que ya lleva turnos: no es alguien que acaba de llegar. */
    function enCurso(texto, idNegocio = 12) {
        const e = entrada(texto, idNegocio);
        e.conversacion.variables = { turnos: 4 };
        return e;
    }

    it('el saludo lleva el ENLACE en el texto, no como botón', async () => {
        // Un botón de WhatsApp no abre una URL: devuelve un id al bot. Como opción, «ver el
        // menú» costaba un turno de ida y vuelta para algo que debe ser un toque.
        const d = await flujo(entrada('hola', 12));

        expect(d.respuestas[0].texto).toContain('Pregonchos');
        expect(d.respuestas[0].texto).toContain(enlaceDelMenu(12));
    });

    it('saluda por la hora del día, en la hora del NEGOCIO', async () => {
        // El proceso corre en UTC en el VPS. Calcular esto con `getHours()` daría «buenas
        // noches» a las seis de la tarde en Bogotá, que es justo la clase de detalle que
        // delata a un bot.
        const alas9 = crearFlujoRestaurante({
            contextoNegocio: negocioFalso,
            leerCarta: async () => CARTA,
            ahora: () => new Date('2026-08-26T14:00:00Z'), // 09:00 en Bogotá
        });
        const alas8 = crearFlujoRestaurante({
            contextoNegocio: negocioFalso,
            leerCarta: async () => CARTA,
            ahora: () => new Date('2026-08-27T01:00:00Z'), // 20:00 en Bogotá
        });

        expect((await alas9(entrada('hola', 12))).respuestas[0].texto).toContain('Buenos días');
        expect((await flujo(entrada('hola', 12))).respuestas[0].texto).toContain('Buenas tardes');
        expect((await alas8(entrada('hola', 12))).respuestas[0].texto).toContain('Buenas noches');
    });

    it('el nombre del negocio va en negrita de WhatsApp: un asterisco, no dos', async () => {
        const d = await flujo(entrada('hola', 12));
        expect(d.respuestas[0].texto).toContain('*Pregonchos*');
        expect(d.respuestas[0].texto).not.toContain('**Pregonchos**');
    });

    it('el saludo deja UN botón, para pedir por chat', async () => {
        const d = await flujo(entrada('hola', 12));
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual([OPCION.CHAT]);
    });

    it('esa única opción NO lleva detalle: con detalle el canal pinta una lista', async () => {
        // `channels/whatsapp/adaptador.js` decide botón vs lista con `<= LIMITES.botones &&
        // !conDetalle`. Una lista de una sola entrada obliga a desplegar un menú para pulsar lo
        // único que hay dentro.
        const d = await flujo(entrada('hola', 12));
        expect(d.respuestas[0].opciones[0].detalle).toBeUndefined();
        expect(Object.keys(d.respuestas[0].opciones[0])).toEqual(['id', 'etiqueta']);
    });

    it('«ver el menú» manda el enlace de ESE negocio', async () => {
        const d = await flujo(entrada(OPCION.MENU, 12));
        expect(d.respuestas[0].texto).toContain(enlaceDelMenu(12));
        expect(d.respuestas[0].texto).toContain('/12');
    });

    it('pedir la carta por texto también manda el enlace, sin botones', async () => {
        const d = await flujo(entrada('la carta', 12));
        expect(d.respuestas[0].texto).toContain(enlaceDelMenu(12));
        expect(d.respuestas[0].opciones).toBeUndefined();
    });

    it('«pedir por aquí» enseña PRODUCTOS con su precio', async () => {
        // Lo que el cliente quiere saber es qué hay y cuánto vale. Que lo pinte el flujo y no
        // el modelo es además gratis: es una lectura de tabla, no una conversación.
        const d = await flujo(entrada(OPCION.CHAT, 12));

        expect(d.respuestas[0].texto).toContain('Hamburguesa doble');
        expect(d.respuestas[0].texto).toContain('$22.000');
        expect(d.respuestas[0].texto).toContain('Limonada de coco');
    });

    it('«pedir por aquí» NO le pregunta al cliente por categorías', async () => {
        // La regresión que esta prueba existe para que no vuelva. Hasta el 2026-08-26 este paso
        // pintaba las categorías como botones —«Entradas, Platos, Bebidas»— y le pasaba al
        // cliente el problema de organización del restaurante. Nadie escribe a un restaurante
        // para navegar un índice.
        const d = await flujo(entrada(OPCION.CHAT, 12));

        expect(d.respuestas[0].texto).not.toMatch(/categor/i);
        expect(d.respuestas[0].opciones).toBeUndefined();
    });

    it('si la carta no cabe entera, lo dice en vez de dar a entender que eso es todo', async () => {
        const d = await flujo(entrada(OPCION.CHAT, 12));
        expect(d.respuestas[0].texto).toMatch(/hay más/i);
        expect(d.respuestas[0].texto).toContain(enlaceDelMenu(12));
    });

    it('si cabe entera, no promete un «hay más» que no existe', async () => {
        const cartaCorta = crearFlujoRestaurante({
            contextoNegocio: negocioFalso,
            leerCarta: async () => ({ productos: CARTA.productos, total: 3 }),
            ahora: LAS_TRES,
        });
        const d = await cartaCorta(entrada(OPCION.CHAT, 12));
        expect(d.respuestas[0].texto).not.toMatch(/hay más/i);
    });

    it('«pedir por aquí» NO deja tarea abierta: así el siguiente mensaje lo atiende el modelo', async () => {
        // Es el mecanismo entero. Con una tarea abierta, la política de enrutado devolvería la
        // conversación a este flujo, que no sabe tomar un pedido.
        const d = await flujo(entrada(OPCION.CHAT, 12));
        expect(d.tarea).toBeNull();
    });

    it('sin carta cargada no se queda mudo: pide que le digan qué quieren', async () => {
        const sinCarta = crearFlujoRestaurante({
            contextoNegocio: negocioFalso,
            leerCarta: async () => ({ productos: [], total: 0 }),
            ahora: LAS_TRES,
        });
        const d = await sinCarta(entrada(OPCION.CHAT, 12));
        expect(d.respuestas[0]).toMatch(/qué quieres pedir/i);
    });

    it('si leer la carta falla, tampoco se cae', async () => {
        const rota = crearFlujoRestaurante({
            contextoNegocio: negocioFalso,
            leerCarta: async () => {
                throw new Error('base caída');
            },
            ahora: LAS_TRES,
        });
        const d = await rota(entrada(OPCION.CHAT, 12));
        expect(d.resultado).toBe('resuelto');
        expect(d.respuestas[0]).toMatch(/qué quieres pedir/i);
    });

    it('el saludo tampoco deja tarea: una pregunta suelta no se queda atrapada en el menú', async () => {
        const d = await flujo(entrada('hola', 12));
        expect(d.tarea).toBeNull();
    });

    it('un «sí» a mitad de conversación NO reinicia el saludo', async () => {
        // El fallo, visto en producción el 2026-08-24: la política de enrutado manda al flujo
        // determinista todo lo que sea un «comando conocido», y esa lista incluye «sí», «no»,
        // «ok» y «vale». El cliente contestaba «sí» a una pregunta del modelo y recibía el
        // saludo inicial otra vez, como si el bot se hubiera reiniciado.
        const d = await flujo(enCurso('si'));
        expect(d.respuestas).toEqual([]);
        expect(d.resultado).toBe('sin_respuesta');
    });

    it('quien llega por primera vez SÍ recibe el saludo', async () => {
        // La contraparte del anterior: no vaya a ser que por no re-saludar, no se salude nunca.
        const d = await flujo(entrada('buenas', 12));
        expect(d.respuestas[0].texto).toContain('Pregonchos');
    });

    it('«menú» reabre el saludo aunque la conversación esté en marcha', async () => {
        const d = await flujo(enCurso('menu'));
        expect(d.respuestas[0].texto).toContain('Pregonchos');
    });
});


// ── El pedido que llega del menú digital ────────────────────────────────────────────────

describe('el código compacto del menú digital', () => {
    const codigoPedido = require('../../intelligence/adapters/restaurante/codigoPedido');

    /** Tal como lo compone `carrito.service.ts` en el menú. Es el contrato entre los dos. */
    const MENSAJE_REAL = [
        'Hola, quiero pedir:',
        '',
        '• 2 × Bandeja paisa',
        '• 1 × Limonada de coco',
        '',
        'Total aproximado: $78.000',
        '',
        '#P12-4x2,9x1',
    ].join('\n');

    it('lee el pedido de un mensaje real del menú', async () => {
        expect(codigoPedido.leer(MENSAJE_REAL)).toEqual({
            idNegocio: 12,
            items: [
                { id_producto: 4, cantidad: 2 },
                { id_producto: 9, cantidad: 1 },
            ],
        });
    });

    it('lo encuentra aunque el cliente escriba algo antes de enviar', async () => {
        // Es lo que pasa siempre: la gente añade «buenas tardes» encima del mensaje ya escrito.
        const conPrologo = `Buenas, disculpa la hora\n\n${MENSAJE_REAL}`;
        expect(codigoPedido.leer(conPrologo)?.items).toHaveLength(2);
    });

    it('un mensaje normal no trae pedido', async () => {
        expect(codigoPedido.leer('hola, tienen hamburguesas?')).toBeNull();
        expect(codigoPedido.leer('')).toBeNull();
        expect(codigoPedido.loTrae('quiero pedir algo')).toBe(false);
    });

    it('descarta cantidades de cero o negativas en vez de crearlas', async () => {
        expect(codigoPedido.leer('#P12-4x0')).toBeNull();
    });

    it('suma el mismo producto repetido en vez de duplicar la línea', async () => {
        // El cliente pidió tres, no dos y una.
        expect(codigoPedido.leer('#P12-4x2,4x1')?.items).toEqual([{ id_producto: 4, cantidad: 3 }]);
    });

    it('rechaza un pedido absurdamente largo', async () => {
        const muchos = Array.from({ length: 40 }, (_, i) => `${i + 1}x1`).join(',');
        expect(codigoPedido.leer(`#P12-${muchos}`)).toBeNull();
    });
});

describe('el flujo recibe el pedido del menú', () => {
    const { crearFlujoRestaurante } = require('../../intelligence/adapters/restaurante/flujo');

    const negocioFalso = {
        obtener: async (id) => ({ id, nombre: 'Pregonchos', tratamiento: 'Pregonchos', tipoNegocio: 'RESTAURANTE' }),
    };
    const flujo = crearFlujoRestaurante({
        contextoNegocio: negocioFalso,
        leerCarta: async () => ({ productos: [], total: 0 }),
    });

    const mensaje = 'Hola, quiero pedir:\n\n• 2 × Bandeja paisa\n\n#P12-4x2';

    it('pide la dirección y guarda los productos, SIN crear la orden', async () => {
        // Crear la orden es una mutación que exige el sí del cliente (ADR-010, paso 5), y
        // pulsar «Continuar por WhatsApp» es abrir un chat, no confirmar un pedido. Además
        // falta la dirección, sin la cual no hay domicilio que llevar.
        const d = await flujo(entrada(mensaje, 12));

        expect(d.respuestas[0]).toMatch(/dirección/i);
        expect(d.variables.pedido_pendiente).toEqual([{ id_producto: 4, cantidad: 2 }]);
        expect(d.tarea).toBeNull();
    });

    it('el pedido de OTRO negocio se rechaza con su motivo', async () => {
        // Alguien armó el carrito en la carta de un restaurante y lo mandó al WhatsApp de otro.
        // Sin comprobarlo, el pedido se crearía con ids que aquí son otra cosa, o no existen.
        const d = await flujo(entrada('#P99-4x2', 12));

        expect(d.respuestas[0]).toMatch(/otro negocio/i);
        expect(d.variables.pedido_pendiente).toBeUndefined();
    });

    it('el saludo del mensaje NO se confunde con un «hola» suelto', async () => {
        // El mensaje del menú empieza por «Hola, quiero pedir:». Si el código se leyera después
        // del saludo, el cliente recibiría la bienvenida en vez de su pedido.
        const d = await flujo(entrada(mensaje, 12));
        expect(d.respuestas[0]).not.toMatch(/Te saluda/);
    });
});
