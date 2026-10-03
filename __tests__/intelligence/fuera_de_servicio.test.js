/**
 * Con el local cerrado contesta el flujo, no el modelo.
 *
 * ## De dónde sale
 *
 * De producción, 2026-10-02 (Zona Burger, cierra a las 22:50): a las 23:02 llegó «Buenas noches,
 * ¿realizas domicilios?» y lo contestó el modelo con «Sí, hacemos domicilios. ¿Qué te gustaría
 * pedir?», sin mirar el horario. Decisión del dueño: fuera de servicio contesta el flujo —horario
 * y carta—, que además no gasta el modelo.
 *
 * Correr con:  npx jest __tests__/intelligence/fuera_de_servicio.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');
const flujos = require('../../intelligence/engine/flujos');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');

const { crearFlujoRestaurante, fueraDeServicio, TAREA_PEDIDO } = flujo;

// Viernes 2026-10-02, 23:02 en Bogotá: Zona Burger ya cerró.
const A_LAS_23 = new Date('2026-10-02T23:02:00-05:00');
const ABRE_MANANA = async () => ({ dias_adelante: 1, dia_semana: 6, hora: '16:30' });
const estado = (e) => async () => ({ estado: e });

function crear({ atencion = 'fuera_de_horario', hayPedido = false, ahora = A_LAS_23 } = {}) {
    return crearFlujoRestaurante({
        estadoAtencion: estado(atencion),
        proximaApertura: ABRE_MANANA,
        tienePedidoReciente: async () => hayPedido,
        contextoNegocio: {
            obtener: async () => ({
                id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 },
                domicilioRango: { min: 7000, max: 9000, nota: null },
            }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        ahora: () => ahora,
        catalogo: {
            barrios: async () => ({ habilitado: false, barrios: [] }),
            mesas: async () => [],
            resolverBarrio: async () => null,
            resolverMesa: async () => null,
            resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
        },
    });
}

const conversacion = (variables = {}) => ({
    id_conversacion: 'conv-1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
    variables, tarea_actual: null, tarea_datos: {},
});
const decir = (manejar, conv, texto) =>
    manejar({ conversacion: conv, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });
const decisiones = (d) => (d.pasos || []).map((p) => p.decision);
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));

describe('fueraDeServicio: cuándo cuenta como cerrado', () => {
    const opciones = (atencion, hayPedido = false) => ({
        ahora: A_LAS_23,
        estadoAtencion: estado(atencion),
        tienePedidoReciente: async () => hayPedido,
    });

    test.each(['fuera_de_horario', 'aun_no_abre', 'cerrado_sin_horario'])('%s → cerrado', async (e) => {
        expect(await fueraDeServicio(conversacion(), opciones(e))).toBe(e);
    });

    test('abierto → no', async () => {
        expect(await fueraDeServicio(conversacion(), opciones('abierto'))).toBeNull();
    });

    test('con un pedido tomado hace poco → no (su «¿ya salió?» merece respuesta)', async () => {
        expect(await fueraDeServicio(conversacion(), opciones('fuera_de_horario', true))).toBeNull();
    });

    test('con un pedido a medias → no (ese hilo es del flujo)', async () => {
        const conv = { ...conversacion(), tarea_actual: TAREA_PEDIDO };
        expect(await fueraDeServicio(conv, opciones('fuera_de_horario'))).toBeNull();
    });

    test('si no se puede leer el estado → no: se atiende como antes', async () => {
        const falla = { ...opciones('abierto'), estadoAtencion: async () => { throw new Error('sin base'); } };
        expect(await fueraDeServicio(conversacion(), falla)).toBeNull();
    });
});

describe('el flujo contesta con el local cerrado', () => {
    test('EL CASO: «Buenas noches realizas domicilios?» a las 23:02 → horario y carta, sin prometer', async () => {
        const d = await decir(crear(), conversacion(), 'Buenas noches realizas domicilios?');

        expect(decisiones(d)).toContain('fuera_de_servicio');
        const [texto] = textos(d);
        expect(texto).toContain('fuera de nuestro horario de atención');
        expect(texto).toContain('Abrimos mañana a las 4:30 PM');
        expect(texto).toContain('/carta/6');
        expect(texto).not.toMatch(/hacemos domicilios|qué te gustaría pedir/i);
        expect(d.resultado).toBe('resuelto');
        expect(d.nivel).toBe('determinista');
    });

    test('a mitad de la conversación no vuelve a saludar', async () => {
        const d = await decir(crear(), conversacion({ turnos: 3 }), 'tienen salchipapa?');

        const [texto] = textos(d);
        expect(texto).not.toContain('Te saluda');
        expect(texto).toContain('Abrimos mañana a las 4:30 PM');
        expect(d.variables.aviso_cerrado_en).toBe(A_LAS_23.toISOString());
    });

    test('si ya se le avisó hace poco: una línea, sin repetir la carta', async () => {
        const hace10 = new Date(A_LAS_23.getTime() - 10 * 60 * 1000).toISOString();
        const d = await decir(crear(), conversacion({ turnos: 4, aviso_cerrado_en: hace10 }), 'hola??');

        // «hola» es saludo, pero el aviso de cerrado va antes que la bienvenida.
        const [texto] = textos(d);
        expect(texto).toBe(
            'Seguimos fuera de nuestro horario de atención. Abrimos mañana a las 4:30 PM. Apenas abramos te atendemos 🙏'
        );
        expect(d.variables.aviso_cerrado_en).toBe(hace10);
    });

    test('«¿cuánto vale el domicilio?» cerrado → también el aviso, no el precio suelto', async () => {
        const d = await decir(crear(), conversacion({ turnos: 2 }), 'cuanto vale el domicilio');
        expect(decisiones(d)).toContain('fuera_de_servicio');
        expect(decisiones(d)).not.toContain('valor_domicilio_respondido');
    });

    test('con un pedido reciente, «¿cuánto se demora?» sigue contestando el tiempo', async () => {
        const d = await decir(crear({ hayPedido: true }), conversacion({ turnos: 5 }), 'cuanto se demora');
        expect(decisiones(d)).toContain('tiempo_estimado_respondido');
        expect(decisiones(d)).not.toContain('fuera_de_servicio');
    });

    test('abierto, nada cambia: lo que no reconoce se le cede al modelo', async () => {
        const d = await decir(crear({ atencion: 'abierto' }), conversacion({ turnos: 2 }), 'tienen parqueadero?');
        expect(decisiones(d)).toEqual(['cedido_al_modelo']);
    });
});

describe('la escalera no le pasa el turno al modelo si el flujo lo atiende', () => {
    beforeEach(() => flujos._limpiar());
    afterAll(() => flujos._limpiar());

    const negocio = async (id) => ({ id, nombre: 'X', tratamiento: 'X', tipoNegocio: 'RESTAURANTE' });
    const entrada = (texto) => ({
        conversacion: conversacion({ turnos: 2 }),
        mensajes: [{ contenido: texto }],
        texto,
        turno: { id_turno: 't1' },
    });

    function montar(atiende) {
        const llamadasAlModelo = [];
        flujos.registrar({
            vertical: 'restaurante',
            tipos: ['RESTAURANTE'],
            manejar: async () => ({
                pasos: [], respuestas: ['cerrado'], variables: {}, tarea: null,
                resultado: 'resuelto', nivel: 'determinista',
            }),
            atiendeSinModelo: atiende,
        });
        const manejar = crearManejadorEscalera({
            resolverNegocio: negocio,
            llm: async (ctx) => {
                llamadasAlModelo.push(ctx.texto);
                return { pasos: [], respuestas: ['del modelo'], variables: {}, resultado: 'resuelto', nivel: 'llm' };
            },
        });
        return { manejar, llamadasAlModelo };
    }

    test('fuera de servicio: contesta el flujo y el modelo no se llama', async () => {
        const { manejar, llamadasAlModelo } = montar(async () => true);
        const d = await manejar(entrada('Buenas noches realizas domicilios?'));

        expect(d.respuestas).toEqual(['cerrado']);
        expect(llamadasAlModelo).toEqual([]);
        expect(d.pasos.map((p) => p.decision)).toContain('flujo_sin_modelo');
    });

    test('abierto: la pregunta libre sigue yendo al modelo', async () => {
        const { manejar, llamadasAlModelo } = montar(async () => false);
        const d = await manejar(entrada('Buenas noches realizas domicilios?'));

        expect(d.respuestas).toEqual(['del modelo']);
        expect(llamadasAlModelo).toHaveLength(1);
    });

    test('si la pregunta revienta, el turno sigue como siempre (al modelo)', async () => {
        const { manejar, llamadasAlModelo } = montar(async () => { throw new Error('sin base'); });
        const d = await manejar(entrada('Buenas noches realizas domicilios?'));

        expect(d.respuestas).toEqual(['del modelo']);
        expect(llamadasAlModelo).toHaveLength(1);
    });
});
