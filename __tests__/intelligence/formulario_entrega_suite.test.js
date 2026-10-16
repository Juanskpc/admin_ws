/**
 * Batería del formulario de entrega (WhatsApp Flows) contra los errores que ya se pagaron con el
 * asistente, antes de encenderlo en todos los negocios (`docs/whatsapp-flows.md` §0.2).
 *
 * El formulario no decide nada nuevo —el pedido sigue pasando por las mismas guardias, el «sí» y
 * el Policy Gate—, pero abre caminos nuevos. Aquí se recorren con conversaciones enteras, no solo
 * con funciones sueltas. Las que encontraron un fallo lo dicen con «EL CASO».
 *
 *  1. Guardias que no se pueden saltar (el «sí», «No veci», el cajero, ENTREGA_SIN_DECIR).
 *  2. El formulario a destiempo (resumen esperando, enviado dos veces, sin pedido, pedido tomado).
 *  3. Mezclas (escribió «domicilio» y luego mandó «recoger»; «Para servir» con y sin mesas).
 *  4. Barrio (único, repetido, inexistente, «otro», tildes, negocio sin barrios, por comunas).
 *  5. Cuándo el modelo «pregunta cómo lo recibe» (falsos positivos y negativos).
 *  6. Estados del negocio (cerrado) y lo que no debe esperar a que el cliente siga escribiendo.
 *  7. El canal (respuesta en otro orden, sin token en el texto).
 *  8. Costo: mensajes por pedido con y sin formulario.
 *
 * Correr con:  npx jest __tests__/intelligence/formulario_entrega_suite.test.js
 */
'use strict';

const registry = require('../../intelligence/core/registry');
const adaptadorRestaurante = require('../../intelligence/adapters/restaurante');
const pago = require('../../intelligence/adapters/restaurante/pago');
const flujoRestaurante = require('../../intelligence/adapters/restaurante/flujo');
const formularioEntrega = require('../../intelligence/adapters/restaurante/formularioEntrega');
const confirmacion = require('../../intelligence/engine/confirmacion');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');
const { puedeSeguirEscribiendo } = require('../../intelligence/engine/texto');
const whatsapp = require('../../intelligence/channels/whatsapp/adaptador');
const mesaPublicaService = require('../../app_restaurante_api/services/mesaPublicaService');
const Models = require('../../app_core/models/conection');

beforeAll(() => adaptadorRestaurante.registrarCapacidades());
afterAll(() => registry._limpiar());
afterEach(() => jest.restoreAllMocks());

// ── Utilidades ──────────────────────────────────────────────────────────────────────────

/** El texto que escribe el canal cuando llega un formulario respondido (lo de verdad, no a mano). */
const formulario = (campos) =>
    whatsapp.textoDeMensaje({
        type: 'interactive',
        interactive: {
            type: 'nfm_reply',
            nfm_reply: { name: 'flow', response_json: JSON.stringify({ flow_token: 'entrega:c1', ...campos }) },
        },
    });

const BARRIOS = [
    { id_barrio: 1, nombre: 'San José', zona: 'Comuna 1', valor: 5000 },
    { id_barrio: 2, nombre: 'San José', zona: 'Buesaquillo', valor: 9000 },
    { id_barrio: 3, nombre: 'Las Cuadras', zona: 'Comuna 1', valor: 4000 },
    { id_barrio: 4, nombre: 'Atahualpa', zona: 'Comuna 2', valor: 6000 },
];

/** Una ciudad entera por comunas: más de 25 barrios, que ya no caben en la lista. */
const CIUDAD = Array.from({ length: 40 }, (_, i) => ({
    id_barrio: 100 + i,
    nombre: `Barrio ${i}`,
    zona: `Comuna ${(i % 4) + 1}`,
    valor: 4000 + (i % 4) * 1000,
})).concat([{ id_barrio: 999, nombre: 'Las Cuadras', zona: 'Comuna 1', valor: 4000 }]);

/**
 * El flujo del restaurante con todo inyectado: sin Postgres, con el reloj fijo, el formulario
 * encendido y el negocio abierto. Cada opción se puede cambiar por prueba.
 */
function montar({
    flowId = 'FLOW1',
    barrios = { habilitado: true, barrios: BARRIOS },
    mesas = [],
    estado = 'ABIERTO',
    gate = { ejecutar: jest.fn().mockResolvedValue({ resultado: { numero_orden: 'ORD-900' } }) },
} = {}) {
    jest.spyOn(pago, 'ultimoPedidoVivo').mockResolvedValue(null);
    jest.spyOn(pago, 'textosDePago').mockResolvedValue({ domicilio: 'DOM', local: 'LOCAL' });
    const flujo = flujoRestaurante.crearFlujoRestaurante({
        tienePedidoReciente: async () => false,
        yaSeLeContestoSuPedido: async () => false,
        contextoNegocio: {
            obtener: async () => ({
                id: 12, nombre: 'PREGONCHOS', tratamiento: 'PREGONCHOS', atencion: null,
                tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 },
                domicilioRango: { min: 4000, max: 9000 },
            }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate,
        ahora: () => new Date('2026-10-16T19:30:00-05:00'),
        estadoAtencion: async () => ({ estado }),
        proximaApertura: async () => null,
        leerCarta: async () => ({ enlace: 'https://escalapp.cloud/restaurante/carta/12', productos: [] }),
        catalogo: {
            barrios: async () => barrios,
            mesas: async () => mesas,
            resolverBarrio: async () => null,
            resolverMesa: async () => null,
            resolverExclusiones: async ({ lineas }) => lineas.map(() => ({ validas: [], descartadas: [] })),
            formularioEntrega: async () => flowId,
        },
    });
    return { flujo, gate };
}

/**
 * Una conversación que se va contando: cada turno guarda la tarea que dejó el anterior, y se
 * anotan todas las respuestas del asistente para poder contar mensajes.
 */
function chat(flujo, { canal = 'whatsapp' } = {}) {
    const estado = { tarea: null, humano_ultimo_en: null, enviados: [], decisiones: [] };
    estado.dice = async (texto) => {
        const d = await flujo({
            conversacion: {
                id_conversacion: 'c1', id_negocio: 12, canal, id_externo: '573000000000',
                variables: { turnos: 2, nombre: 'Ana' },
                humano_ultimo_en: estado.humano_ultimo_en,
                tarea_actual: estado.tarea?.nombre ?? null,
                tarea_datos: estado.tarea?.datos ?? null,
            },
            mensajes: [{ contenido: texto }],
            turno: { id_turno: `t${estado.decisiones.length}` },
            texto,
            consumo: { costos: [] },
        });
        // Como el motor: sin `tarea` en la decisión se conserva la que había; `null` la cierra.
        if (d.soltarTarea) estado.tarea = null;
        else if (d.tarea !== undefined) estado.tarea = d.tarea;
        estado.enviados.push(...(d.respuestas || []));
        estado.decisiones.push(d);
        return d;
    };
    return estado;
}

const textoDe = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto)).join('\n');
const opcionesDe = (d) => (d.respuestas || []).flatMap((r) => (typeof r === 'string' ? [] : r.opciones || []));
const decisiones = (d) => (d.pasos || []).map((p) => p.decision);

const DOMICILIO_LAS_CUADRAS = { entrega: 'domicilio', barrio: 'Las Cuadras', direccion: 'Cra 24 # 18-35', indicaciones: '', pago: 'Nequi' };

// ── 1. Guardias que no se pueden saltar ─────────────────────────────────────────────────

describe('1. guardias: el formulario nunca ejecuta nada solo', () => {
    test('carta → formulario completo → resumen; el pedido sale SOLO con el «sí»', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        const d = await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(opcionesDe(d).map((o) => o.id)).toEqual(['si', 'no']);

        await c.dice('si');
        expect(gate.ejecutar).toHaveBeenCalledTimes(1);
        expect(gate.ejecutar.mock.calls[0][0].args).toMatchObject({
            tipo_entrega: 'DOMICILIO', direccion: 'Cra 24 # 18-35', id_barrio: 3, nota: 'Pago: Nequi',
        });
    });

    test('«No veci» al resumen que armó el formulario es un no', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        await c.dice('No veci');
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(c.tarea).toBeNull();
    });

    test('el cajero escribió tras el resumen del formulario → el «sí» no ejecuta', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        c.humano_ultimo_en = new Date(Date.now() + 1000).toISOString();
        const d = await c.dice('si');
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(decisiones(d)).toContain('confirmacion_si_tras_persona');
    });

    describe('ENTREGA_SIN_DECIR con el formulario en el hilo', () => {
        beforeEach(() => jest.spyOn(Models.sequelize, 'query').mockResolvedValue([]));
        const falta = (tipo, hilo, extra = {}) =>
            registry.obtener('tomar_pedido').confirmacion.falta({
                args: { tipo_entrega: tipo, cliente_nombre: 'Ana', items: [{ id_producto: 4, cantidad: 1 }], ...extra },
                hilo,
                cliente: hilo.filter((m) => m.rol === 'cliente').map((m) => m.texto),
                asistente: hilo.filter((m) => m.rol !== 'cliente').map((m) => m.texto),
                idConversacion: 'c1',
                idNegocio: 12,
            });
        const PREGUNTA = { rol: 'asistente', texto: '¿Cómo lo recibes? 🛵 Toca *Completar datos* y déjame ahí tus datos de entrega.' };

        test('el formulario dijo «domicilio» y el modelo puso «para recoger» → se le devuelve', async () => {
            const hilo = [{ rol: 'cliente', texto: 'Una hamburguesa' }, PREGUNTA, { rol: 'cliente', texto: formulario(DOMICILIO_LAS_CUADRAS) }];
            expect((await falta('LLEVAR', hilo))?.codigo).toBe('ENTREGA_SIN_DECIR');
        });

        test('el formulario dijo «recoger» → «para recoger» pasa', async () => {
            const hilo = [{ rol: 'cliente', texto: 'Una hamburguesa' }, PREGUNTA, { rol: 'cliente', texto: formulario({ entrega: 'recoger', pago: 'Efectivo' }) }];
            expect(await falta('LLEVAR', hilo)).toBeNull();
        });

        test('el formulario dijo «para servir» → «para servir» sin mesa pasa', async () => {
            const hilo = [{ rol: 'cliente', texto: 'Una hamburguesa' }, PREGUNTA, { rol: 'cliente', texto: formulario({ entrega: 'servir', pago: 'Efectivo' }) }];
            expect(await falta('MESA', hilo)).toBeNull();
        });
    });

    describe('el modelo pide la entrega y el formulario va pegado', () => {
        beforeEach(() => {
            jest.spyOn(Models.sequelize, 'query').mockResolvedValue([]);
            jest.spyOn(mesaPublicaService, 'listarPublicas').mockResolvedValue([]);
        });
        const llamar = (canal) =>
            registry.obtener('tomar_pedido').confirmacion.falta({
                args: { tipo_entrega: 'LLEVAR', cliente_nombre: 'Ana', items: [{ id_producto: 4, cantidad: 1 }] },
                hilo: [{ rol: 'cliente', texto: 'Una hamburguesa' }],
                cliente: ['Una hamburguesa'],
                asistente: [],
                idConversacion: 'c1',
                idNegocio: 12,
                canal,
            });

        test('por WhatsApp con el formulario encendido: la falta trae el botón', async () => {
            jest.spyOn(formularioEntrega, 'flowIdDe').mockResolvedValue('FLOW1');
            const f = await llamar('whatsapp');
            expect(f.codigo).toBe('ENTREGA_SIN_DECIR');
            expect(f.formulario.formulario.flow_id).toBe('FLOW1');
            expect(f.formulario.formulario.token).toBe('entrega:c1');
        });

        test('apagado, o por WebChat: la falta de siempre, sin botón', async () => {
            jest.spyOn(formularioEntrega, 'flowIdDe').mockResolvedValue(null);
            expect((await llamar('whatsapp')).formulario).toBeUndefined();
            formularioEntrega.flowIdDe.mockResolvedValue('FLOW1');
            expect((await llamar('webchat')).formulario).toBeUndefined();
        });
    });
});

// ── 2. El formulario a destiempo ────────────────────────────────────────────────────────

describe('2. a destiempo: el formulario llega con un resumen esperando el sí', () => {
    const esperando = (args, extra = {}) => ({
        nombre: confirmacion.TAREA,
        datos: { capacidad: 'tomar_pedido', args, preguntado_en: new Date().toISOString(), repreguntas: 0, ...extra },
    });
    const DOMICILIO = {
        items: [{ cantidad: 1, id_producto: 4 }], tipo_entrega: 'DOMICILIO', direccion: 'Cra 24 # 18-35',
        id_barrio: 3, cliente_nombre: 'Ana', cliente_telefono: '3000000000',
    };
    const RECOGER = { items: [{ cantidad: 1, id_producto: 4 }], tipo_entrega: 'LLEVAR', cliente_nombre: 'Ana' };

    test('EL CASO: domicilio esperando y el formulario dice «recoger» → se suelta, nada a la nota', async () => {
        // Antes (2026-10-16): el resumen seguía «para llevártelo a Cra 24», la nota decía
        // «📋 Formulario enviado. Entrega: recoger», y el «sí» siguiente mandaba la moto.
        const { flujo, gate } = montar();
        const c = chat(flujo);
        c.tarea = esperando(DOMICILIO);
        const d = await c.dice(formulario({ entrega: 'recoger', pago: 'Efectivo' }));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.soltarTarea).toBe(true);
        expect(decisiones(d)).toEqual(['confirmacion_formulario_recibido', 'confirmacion_soltada_por_formulario']);
        expect(d.notaParaElModelo).toContain('DESCARTÓ');
        expect(d.notaParaElModelo).toContain('"direccion":"Cra 24 # 18-35"');
        expect(JSON.stringify(d)).not.toContain('"nota":"📋');
    });

    test('EL CASO: «para recoger» esperando y el formulario dice «domicilio» → se suelta', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        c.tarea = esperando(RECOGER);
        const d = await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.soltarTarea).toBe(true);
        expect(d.pasos[0].motivo).toMatchObject({ de: 'LLEVAR', a: 'DOMICILIO' });
    });

    test('domicilio esperando y el formulario cambia la dirección → se suelta', async () => {
        const { flujo } = montar();
        const c = chat(flujo);
        c.tarea = esperando(DOMICILIO);
        const d = await c.dice(formulario({ ...DOMICILIO_LAS_CUADRAS, direccion: 'Calle 18 # 30-10' }));
        expect(d.soltarTarea).toBe(true);
    });

    test('EL CASO: enviado dos veces con lo mismo → el resumen otra vez, con el pago, sin soltar nada', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        c.tarea = esperando(DOMICILIO);
        const d = await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.soltarTarea).toBeUndefined();
        expect(textoDe(d)).toContain('Ya tenía esos datos');
        expect(textoDe(d)).toContain('Anoté que pagas con Nequi');
        expect(c.tarea.datos.args).toEqual({ ...DOMICILIO, nota: 'Pago: Nequi' });

        // Una tercera vez: ni la nota se duplica ni se vuelve a «anotar».
        const otra = await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(textoDe(otra)).not.toContain('Anoté que pagas');
        expect(c.tarea.datos.args.nota).toBe('Pago: Nequi');

        // Y cambiar solo la forma de pago la reemplaza, no la suma.
        await c.dice(formulario({ ...DOMICILIO_LAS_CUADRAS, pago: 'Efectivo' }));
        expect(c.tarea.datos.args.nota).toBe('Pago: Efectivo');

        await c.dice('si');
        expect(gate.ejecutar).toHaveBeenCalledTimes(1);
        expect(gate.ejecutar.mock.calls[0][0].args.tipo_entrega).toBe('DOMICILIO');
    });

    test('«para recoger» esperando y el formulario repite «recoger» → resumen otra vez', async () => {
        const { flujo } = montar();
        const c = chat(flujo);
        c.tarea = esperando(RECOGER);
        const d = await c.dice(formulario({ entrega: 'recoger', pago: 'Efectivo' }));
        expect(decisiones(d)).toContain('confirmacion_formulario_igual');
        expect(c.tarea.datos.args).toMatchObject({ tipo_entrega: 'LLEVAR', nota: 'Pago: Efectivo' });
        expect(c.tarea.datos.args.direccion).toBeUndefined();
    });

    test('con una pregunta del modelo abierta (`pregunta_abierta`) tampoco se cuela nada', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        c.tarea = esperando(DOMICILIO, { pregunta_abierta: true });
        const d = await c.dice(formulario({ entrega: 'recoger', pago: 'Efectivo' }));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(d.soltarTarea).toBe(true);
    });

    test('con el cajero recién escrito, el formulario igual no ejecuta y pone el reloj en hora', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        c.tarea = esperando(DOMICILIO, { preguntado_en: new Date(Date.now() - 60000).toISOString() });
        c.humano_ultimo_en = new Date(Date.now() - 30000).toISOString();
        await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(Date.parse(c.tarea.datos.preguntado_en)).toBeGreaterThan(Date.parse(c.humano_ultimo_en));
    });

    test('lo que espera no es un pedido (anular uno): se pide el sí otra vez, sin anotar', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        c.tarea = { nombre: confirmacion.TAREA, datos: { capacidad: 'cancelar_pedido', args: { numero_orden: 'ORD-5' }, preguntado_en: new Date().toISOString(), repreguntas: 0 } };
        const d = await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(decisiones(d)).toContain('confirmacion_formulario_ignorado');
        expect(c.tarea.datos.args).toEqual({ numero_orden: 'ORD-5' });
    });

    test('la escalera le pasa el formulario y la nota al modelo, ya sin el pendiente', async () => {
        const { flujo } = montar();
        const llm = jest.fn().mockResolvedValue({
            pasos: [], respuestas: ['Listo, lo cambio para recoger.'], variables: {}, resultado: 'resuelto', nivel: 'llm',
        });
        const manejador = crearManejadorEscalera({
            determinista: (ctx) => flujo(ctx),
            llm,
            resolverNegocio: async () => ({ id: 12, nombre: 'PREGONCHOS', tipoNegocio: 'RESTAURANTE' }),
        });
        const texto = formulario({ entrega: 'recoger', pago: 'Efectivo' });
        const d = await manejador({
            conversacion: {
                id_conversacion: 'c1', id_negocio: 12, canal: 'whatsapp', id_externo: '573000000000',
                variables: { turnos: 3 }, humano_ultimo_en: null, ...{ tarea_actual: confirmacion.TAREA },
                tarea_datos: esperando(DOMICILIO).datos,
            },
            mensajes: [{ contenido: texto }],
            turno: { id_turno: 't' },
            texto,
            consumo: { costos: [] },
        });
        expect(llm).toHaveBeenCalledTimes(1);
        const alModelo = llm.mock.calls[0][0];
        expect(alModelo.texto.startsWith(texto)).toBe(true);
        expect(alModelo.texto).toContain('DESCARTÓ');
        expect(alModelo.conversacion.tarea_actual).toBeNull();
        expect(d.tarea).toBeNull();
    });
});

describe('2. a destiempo: sin pedido abierto', () => {
    test('el flujo lo reclama y se lo pasa al modelo con la nota de qué es', async () => {
        const texto = formulario(DOMICILIO_LAS_CUADRAS);
        expect(flujoRestaurante.reclama(texto)).toBe(true);
        const { flujo } = montar();
        const d = await chat(flujo).dice(texto);
        expect(decisiones(d)).toEqual(['formulario_sin_pedido_al_modelo']);
        expect(d.respuestas).toEqual([]);
        expect(d.notaParaElModelo).toContain('«Pago: …»');
        // No se lo come ninguna lectura de la última línea («Pago: Nequi» no es «quiero pagar»).
        expect(decisiones(d)).not.toContain('pago_respondido');
    });

    test('con el pedido ya tomado en este chat, el modelo no puede crear otro (YA_HAY_PEDIDO)', async () => {
        jest.spyOn(Models.sequelize, 'query').mockResolvedValueOnce([{ hay: 1 }]);
        const hilo = [
            { rol: 'cliente', texto: 'Una hamburguesa a domicilio' },
            { rol: 'asistente', texto: '¡Listo! Tu pedido quedó tomado. El número es ORD-900 — guárdalo para consultar cómo va.' },
            { rol: 'cliente', texto: formulario(DOMICILIO_LAS_CUADRAS) },
        ];
        const f = await registry.obtener('tomar_pedido').confirmacion.falta({
            args: { tipo_entrega: 'DOMICILIO', direccion: 'Cra 24 # 18-35', cliente_nombre: 'Ana', items: [{ id_producto: 4, cantidad: 1 }] },
            hilo,
            cliente: hilo.filter((m) => m.rol === 'cliente').map((m) => m.texto),
            asistente: hilo.filter((m) => m.rol !== 'cliente').map((m) => m.texto),
            idConversacion: 'c1',
            idNegocio: 12,
        });
        expect(f?.codigo).toBe('YA_HAY_PEDIDO');
        expect(f.mensaje).toContain('ORD-900');
    });
});

// ── 2b. El formulario con el pedido a medias ────────────────────────────────────────────

describe('2. con el pedido de la carta a medias', () => {
    test('EL CASO: unas indicaciones que terminan en «¿cuánto se demora?» no se contestan como pregunta de tiempo', async () => {
        // La respuesta del formulario puede llegar sin la forma de pago al final: entonces la
        // última línea son las indicaciones, y la pregunta del tiempo se llevaba el turno.
        const { flujo } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        const d = await c.dice(
            formulario({ entrega: 'domicilio', barrio: 'Las Cuadras', direccion: 'Cra 24 # 18-35', indicaciones: '¿cuánto se demora?' })
        );
        expect(decisiones(d)).toContain('pedido_formulario_recibido');
        expect(decisiones(d)).not.toContain('tiempo_estimado_respondido');
        expect(c.tarea.datos.args.direccion).toBe('Cra 24 # 18-35 — ¿cuánto se demora?');
    });

    test('unas indicaciones que dicen «cancelar» no cancelan el pedido', async () => {
        const { flujo } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        const d = await c.dice(formulario({ entrega: 'recoger', indicaciones: 'cancelar' }));
        expect(decisiones(d)).not.toContain('pedido_cancelado');
        expect(c.tarea).not.toBeNull();
    });

    test('enviado dos veces mientras se pregunta el barrio: la nota lleva un solo pago', async () => {
        const { flujo } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        await c.dice(formulario({ ...DOMICILIO_LAS_CUADRAS, barrio: 'san jose' }));
        expect(c.tarea.datos.nota).toBe('Pago: Nequi');
        await c.dice(formulario({ ...DOMICILIO_LAS_CUADRAS, barrio: 'san jose', pago: 'Efectivo' }));
        expect(c.tarea.datos.nota).toBe('Pago: Efectivo');
    });

    test('un formulario sin «Entrega» (o con una que no existe) repregunta, no supone', async () => {
        const { flujo, gate } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        const d = await c.dice(formulario({ entrega: 'teletransporte', pago: 'Nequi' }));
        expect(decisiones(d)).toContain('pedido_formulario_sin_entrega');
        expect(opcionesDe(d)[0].formulario.flow_id).toBe('FLOW1');
        expect(gate.ejecutar).not.toHaveBeenCalled();
    });
});

// ── 3. Mezclas ──────────────────────────────────────────────────────────────────────────

describe('3. mezclas: lo escrito a mano y el formulario', () => {
    test('escribió «domicilio» y su barrio, y luego mandó el formulario con «recoger»: sin dirección ni barrio', async () => {
        const { flujo } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        await c.dice('domicilio');
        await c.dice('Las Cuadras');
        expect(c.tarea.datos.id_barrio).toBe(3);
        const d = await c.dice(formulario({ entrega: 'recoger', pago: 'Efectivo' }));
        const args = c.tarea.datos.args;
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(args.tipo_entrega).toBe('LLEVAR');
        expect(args.direccion).toBeUndefined();
        expect(args.id_barrio).toBeUndefined();
        expect(textoDe(d)).toContain('para recogerlo');
    });

    test('escribió una dirección a mano y el formulario trae otra: manda la del formulario', async () => {
        const { flujo } = montar();
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        await c.dice('domicilio');
        await c.dice('Las Cuadras');
        // Ahora pide la dirección; en vez de escribirla, manda el formulario.
        await c.dice(formulario({ ...DOMICILIO_LAS_CUADRAS, direccion: 'Calle 18 # 30-10' }));
        expect(c.tarea.datos.args).toMatchObject({ tipo_entrega: 'DOMICILIO', direccion: 'Calle 18 # 30-10', id_barrio: 3 });
    });

    test('«Para servir» con mesas libres: queda para servir, sin dirección', async () => {
        const { flujo } = montar({ mesas: [{ id_mesa: 7, numero: '3' }] });
        const c = chat(flujo);
        const d0 = await c.dice('#P12-4x1');
        expect(opcionesDe(d0)[0].formulario.datos.entregas.map((e) => e.id)).toContain('servir');
        await c.dice(formulario({ entrega: 'servir', pago: 'Efectivo' }));
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(c.tarea.datos.args.tipo_entrega).toBe('MESA');
        expect(c.tarea.datos.args.direccion).toBeUndefined();
    });

    test('«Para servir» en un negocio sin mesas (formulario viejo): repregunta, no lo toma', async () => {
        const { flujo, gate } = montar({ mesas: [] });
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        const d = await c.dice(formulario({ entrega: 'servir', pago: 'Efectivo' }));
        expect(decisiones(d)).toContain('pedido_formulario_sin_entrega');
        expect(gate.ejecutar).not.toHaveBeenCalled();
    });
});

// ── 4. Barrio ───────────────────────────────────────────────────────────────────────────

describe('4. el barrio escrito en el formulario', () => {
    const conBarrio = async (barrio, opciones = {}) => {
        const { flujo } = montar(opciones);
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        const d = await c.dice(formulario({ ...DOMICILIO_LAS_CUADRAS, barrio }));
        return { c, d };
    };

    test.each(['Las Cuadras', 'LAS CUADRAS', 'las cuádras', '  las cuadras  '])('único (%p) → elegido sin preguntar', async (barrio) => {
        const { c } = await conBarrio(barrio);
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(c.tarea.datos.args.id_barrio).toBe(3);
        // Con barrios por precio, el barrio no se pega a la dirección: va en su columna.
        expect(c.tarea.datos.args.direccion).toBe('Cra 24 # 18-35');
    });

    test('repetido → numerado; el número elige y sigue con dirección y pago guardados', async () => {
        const { c, d } = await conBarrio('San Jose');
        expect(textoDe(d)).toContain('2. San José (Buesaquillo) — $9.000');
        await c.dice('2');
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(c.tarea.datos.args).toMatchObject({ id_barrio: 2, direccion: 'Cra 24 # 18-35', nota: 'Pago: Nequi' });
    });

    test('inexistente → «no encontré ese barrio», con la dirección ya guardada', async () => {
        const { c, d } = await conBarrio('Narnia');
        expect(textoDe(d)).toContain('no encontré ese barrio');
        expect(c.tarea.datos).toMatchObject({ direccion: 'Cra 24 # 18-35', nota: 'Pago: Nequi' });
        expect(c.tarea.datos.id_barrio).toBeUndefined();
        await c.dice('Atahualpa');
        expect(c.tarea.datos.args.id_barrio).toBe(4);
    });

    test('«otro» → el restaurante confirma el valor, sin barrio inventado', async () => {
        const { c } = await conBarrio('otro');
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(c.tarea.datos.args.id_barrio).toBeUndefined();
    });

    test('negocio sin barrios: el barrio va pegado a la dirección', async () => {
        const { c } = await conBarrio('Las Cuadras', { barrios: { habilitado: false, barrios: [] } });
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
        expect(c.tarea.datos.args.direccion).toBe('Cra 24 # 18-35, Las Cuadras');
        expect(c.tarea.datos.args.id_barrio).toBeUndefined();
    });

    test('ciudad entera por comunas: lo encuentra por nombre; si no, resume por zona', async () => {
        const encontrado = await conBarrio('las cuadras', { barrios: { habilitado: true, barrios: CIUDAD } });
        expect(encontrado.c.tarea.datos.args.id_barrio).toBe(999);
        const perdido = await conBarrio('Narnia', { barrios: { habilitado: true, barrios: CIUDAD } });
        expect(textoDe(perdido.d)).toContain('Esto es lo que vale por zona');
        expect(textoDe(perdido.d)).not.toContain('Barrio 39');
    });
});

// ── 5. ¿El modelo pregunta cómo lo recibe? ───────────────────────────────────────────────

describe('5. cuándo el botón va pegado a lo que escribe el modelo', () => {
    test.each([
        'Sí 😊 *Empanadas (x3)*, de carne con ají, a $9.000. ¿Las quieres para recoger, comer aquí o a domicilio?',
        '¿Te lo llevamos a domicilio o pasas a recogerlo?',
        '¿Es para domicilio o para llevar?',
        '¡Claro! ¿Lo quieres a domicilio, para recoger o para comer aquí?',
        // La frase que la plataforma le sugiere al modelo cuando falta la entrega (`loQueFalta`).
        '¿Cómo lo quieres? 🛵 *A domicilio*: mándame la dirección con el barrio y un teléfono. 🏃 *Para recoger o comer aquí*: con eso me basta.',
        '¿A domicilio o lo recoges?',
        '¿Para servir aquí o a domicilio?',
        // Frases reales del asistente en Zona Burger (2026-10-01 → 10-16).
        'Sí 😊 ¿Buscas domicilio, recoger el pedido o comer en el local?',
        'Diana, ¿lo quieres a domicilio o pasas a recogerlo?',
        '¿Cómo la quieres? 🛵 - *A domicilio*: mándame la dirección con el barrio y un teléfono. - *Para recoger o comer aquí*: dime a nombre de quién.',
    ])('pregunta: %p', (t) => expect(formularioEntrega.preguntaComoLoRecibe(t)).toBe(true));

    test.each([
        // Afirmaciones.
        'El domicilio a Las Cuadras vale $4.000.',
        '¡Listo! Tu pedido quedó tomado. El número es ORD-900. El domicilio llega en 40 a 60 minutos.',
        // EL CASO: el mensaje nombra las dos cosas, pero lo que pregunta es otra.
        'El domicilio a tu barrio vale $4.000. ¿Te lo anoto aquí?',
        'Puedes recogerlo o te lo mandamos a domicilio. ¿Quieres algo más?',
        // Preguntas de otra cosa.
        '¿Cuánto vale el domicilio?',
        '¿A qué dirección te lo llevamos?',
        '¿Confirmo tu pedido a nombre de Ana, para recogerlo en el local?',
        // Medido en producción (Zona Burger, 2026-10-01 → 10-16): la versión del 10-16 se
        // disparaba en ~280 mensajes que no preguntaban la entrega, casi todos este resumen.
        '¿Confirmo tu pedido a nombre de Ana, para llevártelo a Cra 24 # 18-35? • 1 × Criollita — $15.500 *Total: $15.500* _El total es aproximado: no incluye el domicilio._',
        'Sí, tenemos servicio a domicilio y también puedes pedir para recoger. ¿Qué se te antoja?',
    ])('no pregunta cómo lo recibe: %p', (t) => expect(formularioEntrega.preguntaComoLoRecibe(t)).toBe(false));
});

// ── 6. Estados del negocio y la espera ──────────────────────────────────────────────────

describe('6. estados del negocio', () => {
    test('sin pedido abierto y con el local cerrado: se dice el horario, no va al modelo', async () => {
        const { flujo, gate } = montar({ estado: 'fuera_de_horario' });
        const d = await chat(flujo).dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(decisiones(d)).not.toContain('formulario_sin_pedido_al_modelo');
        expect(d.respuestas.length).toBeGreaterThan(0);
    });

    test('con el pedido a medias y el local cerrado, el formulario se lee: el cierre lo frena `tomar_pedido` al confirmar', async () => {
        // Es el diseño de siempre (`fueraDeServicio` no interrumpe un pedido a medias): el Gate
        // ejecuta `tomar_pedido`, que rechaza con el local cerrado. Aquí solo se comprueba que el
        // formulario no lo ejecuta por su cuenta.
        const { flujo, gate } = montar({ estado: 'fuera_de_horario' });
        const c = chat(flujo);
        await c.dice('#P12-4x1');
        await c.dice(formulario(DOMICILIO_LAS_CUADRAS));
        expect(gate.ejecutar).not.toHaveBeenCalled();
        expect(c.tarea.nombre).toBe(confirmacion.TAREA);
    });

    test('EL CASO: un formulario llega entero, no se espera a que «siga escribiendo»', () => {
        // Con `CONVERSACION_DEBOUNCE_TEXTO_MS=7000` en producción, el formulario esperaba 7 s.
        expect(puedeSeguirEscribiendo(formulario(DOMICILIO_LAS_CUADRAS))).toBe(false);
        expect(puedeSeguirEscribiendo('voy a pedir una hamburguesa')).toBe(true);
    });
});

// ── 7. El canal ─────────────────────────────────────────────────────────────────────────

describe('7. el canal', () => {
    test('los campos en otro orden se leen igual', () => {
        const texto = formulario({ pago: 'Nequi', direccion: 'Cra 24', entrega: 'domicilio', barrio: 'Las Cuadras' });
        expect(formularioEntrega.leer(texto)).toEqual({ pago: 'Nequi', direccion: 'Cra 24', entrega: 'domicilio', barrio: 'Las Cuadras' });
    });

    test('una dirección con «:» no se parte', () => {
        const texto = formulario({ entrega: 'domicilio', direccion: 'Torre 2: apto 301', pago: 'Nequi' });
        expect(formularioEntrega.leer(texto).direccion).toBe('Torre 2: apto 301');
    });

    test('el token del formulario no llega al texto que leen el modelo y la Bandeja', () => {
        expect(formulario(DOMICILIO_LAS_CUADRAS)).not.toContain('entrega:c1');
    });

    test('un mensaje que solo imita el encabezado a mitad de texto no es un formulario', () => {
        expect(formularioEntrega.leer('hola\n📋 Formulario enviado\nEntrega: domicilio')).toBeNull();
    });
});

// ── 8. Costo ────────────────────────────────────────────────────────────────────────────

describe('8. costo: mensajes del asistente por pedido', () => {
    test('a domicilio con barrio único: el formulario ahorra dos mensajes frente a escribirlo', async () => {
        const conFormulario = chat(montar().flujo);
        await conFormulario.dice('#P12-4x1');
        await conFormulario.dice(formulario(DOMICILIO_LAS_CUADRAS));
        await conFormulario.dice('si');

        const aMano = chat(montar({ flowId: null }).flujo);
        await aMano.dice('#P12-4x1');
        await aMano.dice('domicilio');
        await aMano.dice('Las Cuadras');
        await aMano.dice('Cra 24 # 18-35');
        await aMano.dice('si');

        expect(conFormulario.enviados).toHaveLength(3);
        expect(aMano.enviados).toHaveLength(5);
    });
});

// Pregonchos, 2026-10-16 (ORD-0085 y ORD-0087): con el formulario atendido por el modelo, el barrio
// acababa en la dirección («Mz 1 cs 24, Corazón de jesus») o en la nota («Barrio: Betania») y el
// domicilio salía en $0, aunque el barrio tiene precio. Ahora el servidor lo encuentra ahí.
describe('4. el barrio dentro de la dirección o la nota (lo que deja el modelo)', () => {
    const { barrioEnTexto } = flujoRestaurante;
    const PASTO = [
        { id_barrio: 90, nombre: 'Betania', valor: 5500, zona: 'Comuna 4' },
        { id_barrio: 327, nombre: 'Corazón De Jesús II', valor: 7500, zona: 'Comuna 10' },
        { id_barrio: 341, nombre: 'Niño Jesús De Praga', valor: 7500, zona: 'Comuna 10' },
        { id_barrio: 342, nombre: 'Praga', valor: 7000, zona: 'Comuna 10' },
        { id_barrio: 372, nombre: 'Corazón De Jesús', valor: 8500, zona: 'Comuna 11' },
        { id_barrio: 1, nombre: 'Avenida Boyacá', valor: 4500, zona: 'Comuna 1' },
        { id_barrio: 20, nombre: 'Avenida Boyacá', valor: 5000, zona: 'Comuna 2' },
        { id_barrio: 200, nombre: 'Torobajo', valor: 6000, zona: 'Comuna 9' },
        { id_barrio: 201, nombre: 'Conjunto Torobajo', valor: 6000, zona: 'Comuna 9' },
    ];
    const id = (t) => barrioEnTexto(t, PASTO)?.id_barrio ?? null;

    it('EL CASO: «Mz 1 cs 24, Corazón de jesus. Indicaciones: …» → Corazón De Jesús (comuna 11), no el II', () => {
        expect(id('Mz 1 cs 24, Corazón de jesus. Indicaciones: Subir al segundo piso por favor')).toBe(372);
    });
    it('EL CASO: «Barrio: Betania» en la nota', () => {
        expect(id('Pago en efectivo. Barrio: Betania')).toBe(90);
    });
    it('«Udenar - Torobajo 205» → Torobajo, no el conjunto', () => {
        expect(id('Udenar - Torobajo 205')).toBe(200);
    });
    it('el nombre largo gana al corto que lleva dentro («Niño Jesús de Praga» no es «Praga»)', () => {
        expect(id('Cra 5, niño jesus de praga')).toBe(341);
    });
    it('el mismo nombre en dos comunas no se elige… salvo que diga la comuna', () => {
        expect(id('Avenida Boyacá # 3-20')).toBeNull();
        expect(id('Avenida Boyacá # 3-20, comuna 2')).toBe(20);
    });
    it('sin barrio reconocible, nada (el cajero lo ajusta)', () => {
        expect(id('Calle 18 # 20-30, casa esquinera')).toBeNull();
        expect(id('')).toBeNull();
        expect(barrioEnTexto('Betania', [])).toBeNull();
    });
    it('solo nombres enteros: «Betanias» o «betaniaa» no cuentan', () => {
        expect(id('Conjunto Betanias casa 4')).toBeNull();
    });
});
