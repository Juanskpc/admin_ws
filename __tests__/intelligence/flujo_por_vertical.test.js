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

    const flujo = crearFlujoRestaurante({
        contextoNegocio: { obtener: async (id) => ({ id, nombre: 'Pregonchos', tratamiento: 'Pregonchos', tipoNegocio: 'RESTAURANTE' }) },
    });

    it('el saludo lleva el ENLACE en el texto, no como botón', async () => {
        // Un botón de WhatsApp no abre una URL: devuelve un id al bot. Como opción, «ver el
        // menú» costaba un turno de ida y vuelta para algo que debe ser un toque.
        const d = await flujo(entrada('hola', 12));

        expect(d.respuestas[0].texto).toContain('Pregonchos');
        expect(d.respuestas[0].texto).toContain(enlaceDelMenu(12));
    });

    it('el saludo deja UN botón, para pedir por chat', async () => {
        const d = await flujo(entrada('hola', 12));
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual([OPCION.CHAT]);
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

    it('«pedir por aquí» NO deja tarea abierta: así el siguiente mensaje lo atiende el modelo', async () => {
        // Es el mecanismo entero. Con una tarea abierta, la política de enrutado devolvería la
        // conversación a este flujo, que no sabe tomar un pedido.
        const d = await flujo(entrada(OPCION.CHAT, 12));
        expect(d.tarea).toBeNull();
        expect(d.respuestas[0]).toMatch(/qué quieres pedir/i);
    });

    it('el saludo tampoco deja tarea: una pregunta suelta no se queda atrapada en el menú', async () => {
        const d = await flujo(entrada('hola', 12));
        expect(d.tarea).toBeNull();
    });
});
