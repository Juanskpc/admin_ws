/**
 * Lo que salió de la auditoría de la tarde del 2026-10-02 (Zona Burger), con los mensajes reales.
 *
 *   - La Discordia, agotada por un stock en −321, se le dijo a una clienta que «no está en la
 *     carta» → `buscar_producto` devuelve `agotados_ahora`.
 *   - «Siempre me cobran 23 cada ves que pido al barrio el Pilar» terminó como nota del pedido, y
 *     una foto hizo repetir el resumen entero → la confirmación ya no anota precios, contesta
 *     corto a una foto, y al segundo desvío pasa el pedido a una persona en vez de soltarlo.
 *
 * (`pasar_a_persona` se prueba en modelo.test.js y el tiempo sin pedido en
 * pedido_tiempo_estimado.test.js.) Nada de esto toca la base.
 *
 * Correr con:  npx jest __tests__/intelligence/auditoria_2026_10_02.test.js
 */
'use strict';

const confirmacion = require('../../intelligence/engine/confirmacion');
const registry = require('../../intelligence/core/registry');
const adaptador = require('../../intelligence/adapters/restaurante');

const { lineasParaAnotar } = confirmacion;

describe('la confirmación no anota lo que habla de precio', () => {
    test('EL CASO: «siempre me cobran 23…» no es una nota de cocina', () => {
        expect(
            lineasParaAnotar('Siempre me cobran 23 cada ves que pido al barrio el Pilar', { afirma: false })
        ).toEqual([]);
        expect(lineasParaAnotar('Sería 23 el total', { afirma: false })).toEqual([]);
    });

    test('lo que sí es del pedido se sigue anotando', () => {
        expect(lineasParaAnotar('Alameda 2 entrada al barrio común', { afirma: false })).toEqual([
            'Alameda 2 entrada al barrio común',
        ]);
        expect(lineasParaAnotar('Y me puede enviar salsas', { afirma: false })).toEqual([
            'Y me puede enviar salsas',
        ]);
    });
});

describe('la confirmación de un pedido cuando el cliente se desvía', () => {
    // Un registro de mentira con lo único que `resolver` le pregunta a la capacidad.
    const REGISTRO_PEDIDO = {
        obtener: () => ({
            confirmacion: {
                pregunta: async () => '¿Confirmo tu pedido? • 1 × criollita — $15.500',
                anotar: ({ args, texto }) => ({ ...args, nota: texto }),
            },
        }),
    };
    const gateQueNoDebeLlamarse = {
        ejecutar: async () => {
            throw new Error('no se debía ejecutar nada');
        },
    };
    const ctx = (texto, repreguntas = 0) => ({
        texto,
        conversacion: {
            id_negocio: 6,
            variables: {},
            tarea_actual: confirmacion.TAREA,
            tarea_datos: {
                capacidad: 'tomar_pedido',
                args: {},
                preguntado_en: new Date().toISOString(),
                repreguntas,
            },
        },
    });
    const resolver = (texto, repreguntas) =>
        confirmacion.resolver(ctx(texto, repreguntas), {
            gate: gateQueNoDebeLlamarse,
            registry: REGISTRO_PEDIDO,
        });

    test('una foto NO repite el resumen: dice que no la ve y pide el sí o el no', async () => {
        const d = await resolver('[image]', 0);
        const texto = d.respuestas[0].texto;

        expect(texto).toContain('No puedo ver fotos');
        expect(texto).toMatch(/sí o no/);
        expect(texto).not.toContain('criollita');
        expect(d.tarea.datos.repreguntas).toBe(1);
        expect(d.pasos[0].motivo.media).toBe(true);
    });

    test('un texto que no es sí ni no se repregunta CORTO, sin repetir el resumen (2026-10-05)', async () => {
        const d = await resolver('Siempre me cobran 23 cada ves que pido al barrio el Pilar', 0);

        expect(d.pasos[0].decision).toBe('confirmacion_repreguntada');
        // El resumen está justo arriba: repetirlo entero es lo que se lee como un bot atascado.
        expect(d.respuestas[0].texto).not.toContain('criollita');
        expect(d.respuestas[0].texto).toContain('¿Confirmo lo de arriba?');
        expect(d.respuestas[0].opciones).toHaveLength(2);
    });

    test('al segundo desvío el pedido NO se suelta: pasa a una persona', async () => {
        const d = await resolver('[image]', 1);

        expect(d.pasos[0].decision).toBe('confirmacion_a_persona');
        expect(d.estado).toBe('handoff_humano');
        expect(d.resultado).toBe('handoff');
        expect(d.tarea).toBeNull();
        expect(d.respuestas[0]).toContain('Todavía no he enviado tu pedido');
    });

    test('lo que no es un pedido (sin `anotar`) se sigue soltando como antes', async () => {
        const d = await confirmacion.resolver(ctx('¿tienen parqueadero?', 1), {
            gate: gateQueNoDebeLlamarse,
            registry: { obtener: () => ({ confirmacion: { pregunta: async () => '¿Cancelo tu cita?' } }) },
        });
        expect(d.pasos[0].decision).toBe('confirmacion_descartada');
        expect(d.estado).toBeUndefined();
    });
});

describe('buscar_producto distingue «agotado» de «no existe»', () => {
    // La carta de Zona Burger en la tarde del 2026-10-02: la Discordia estaba activa, pero su pan
    // en −321 la sacaba de la búsqueda «vendible». Con `includeDisabled` aparece.
    const VENDIBLES = [
        { id_producto: 1, nombre: 'Dulcinea', descripcion: 'Hamburguesa', precio: 16000, visible: true },
        { id_producto: 2, nombre: 'Pata-crunch', descripcion: 'Hamburguesa', precio: 16000, visible: true },
    ];
    const TODOS = [
        ...VENDIBLES,
        { id_producto: 28, nombre: 'Discordia', descripcion: 'Carne mixta y pollo', precio: 15500, visible: true },
        { id_producto: 99, nombre: 'Discordia secreta', descripcion: 'Oculta', precio: 1, visible: false },
    ];
    const sinTildes = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const coincide = (lista, termino) =>
        lista.filter((p) => sinTildes(p.nombre).includes(sinTildes(termino)) || sinTildes(p.descripcion).includes(sinTildes(termino)));

    let cartaService;
    let original;
    let originalCompleta;
    beforeAll(() => {
        cartaService = require('../../app_restaurante_api/services/cartaService');
        original = cartaService.buscarProductos;
        originalCompleta = cartaService.getCartaPublicaCompleta;
        cartaService.buscarProductos = async (idNegocio, termino, opciones = {}) =>
            coincide(opciones.includeDisabled ? TODOS : VENDIBLES, termino);
        // La tercera pasada (categoría + nombre) lee la carta pública: solo lo vendible.
        cartaService.getCartaPublicaCompleta = async () => [{ nombre: 'HAMBURGUESAS', productos: VENDIBLES }];
        adaptador.registrarCapacidades();
    });
    afterAll(() => {
        cartaService.buscarProductos = original;
        cartaService.getCartaPublicaCompleta = originalCompleta;
        registry._limpiar();
    });
    const buscar = (termino) =>
        registry.obtener('buscar_producto').ejecutar({ idNegocio: 6, args: { termino } });

    test('EL CASO: «discordia» agotada sale en agotados_ahora, sin precio', async () => {
        const r = await buscar('discordia');
        expect(r.productos).toEqual([]);
        expect(r.agotados_ahora).toEqual(['Discordia']);
    });

    test('«hamburguesa discordia»: salen las otras, y la Discordia como agotada', async () => {
        const r = await buscar('hamburguesa discordia');
        expect(r.agotados_ahora).toEqual(['Discordia']);
    });

    test('lo que se encuentra a la venta no trae la lista de agotados', async () => {
        const r = await buscar('dulcinea');
        expect(r.productos.map((p) => p.nombre)).toEqual(['Dulcinea']);
        expect(r.agotados_ahora).toBeUndefined();
    });

    test('lo que de verdad no existe sigue sin aparecer', async () => {
        const r = await buscar('pizza');
        expect(r.productos).toEqual([]);
        expect(r.agotados_ahora).toEqual([]);
    });
});

// ── «Para servir» (Karen Díaz, 2026-10-02 19:16) ────────────────────────────────────────────
// «Para servir veci ya vamos»: en Pasto es comer en el local. El bot preguntó «¿en qué mesa
// están?» y, con «ya estoy en camino», lo convirtió en «para recoger».
describe('«para servir» en el flujo sin modelo', () => {
    const flujo = require('../../intelligence/adapters/restaurante/flujo');
    const { leerEntrega, crearFlujoRestaurante, TAREA_PEDIDO, ENTREGA, OPCION } = flujo;

    test.each([
        ['Para servir veci ya vamos', 'MESA'],
        ['para comer aquí', 'MESA'],
        ['para servir, ya voy', 'MESA'],
        ['entrega_servir', 'MESA'],
        ['paso a recogerlo', 'LLEVAR'],
        ['a domicilio', 'DOMICILIO'],
    ])('%j → %s', (texto, esperado) => {
        expect(leerEntrega(texto)).toBe(esperado);
    });

    const crear = (mesas) =>
        crearFlujoRestaurante({
            contextoNegocio: {
                obtener: async () => ({
                    id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                    tipoNegocio: 'RESTAURANTE', tiempoEstimado: null, domicilioRango: null,
                }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate: {},
            ahora: () => new Date('2026-10-02T19:16:00-05:00'),
            tienePedidoReciente: async () => false,
            catalogo: {
                barrios: async () => ({ habilitado: false, barrios: [] }),
                mesas: async () => mesas,
                resolverBarrio: async () => null,
                resolverMesa: async () => null,
                resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
            },
        });
    const enEntrega = () => ({
        id_conversacion: 'conv-servir', id_negocio: 6, canal: 'whatsapp', id_externo: 'CO.2368972810572497',
        variables: { turnos: 4 }, tarea_actual: TAREA_PEDIDO,
        tarea_datos: { items: [{ id_producto: 29, cantidad: 2 }], nombre: 'Karen Diaz', paso: 'entrega', repreguntas: 0 },
    });
    const decir = (manejar, conversacion, texto) =>
        manejar({ conversacion, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });
    const MESAS = [{ id_mesa: 75, nombre: 'Mesa 7', numero: 7 }];

    test('EL CASO: con mesas, «para servir» va a confirmar SIN preguntar la mesa', async () => {
        const d = await decir(crear(MESAS), enEntrega(), 'Para servir veci ya vamos');

        const solicitada = d.pasos.find((p) => p.decision === 'confirmacion_solicitada');
        expect(solicitada).toBeTruthy();
        expect(solicitada.motivo.argumentos).toMatchObject({ tipo_entrega: 'MESA', cliente_nombre: 'Karen Diaz' });
        expect(solicitada.motivo.argumentos.id_mesa).toBeUndefined();
        const texto = JSON.stringify(d.respuestas);
        expect(texto).not.toMatch(/en qué mesa/i);
    });

    test('la pregunta de entrega ofrece «Para servir aquí» solo si hay mesas', async () => {
        const sinEntrega = () => ({ ...enEntrega(), tarea_datos: { ...enEntrega().tarea_datos } });

        const con = await decir(crear(MESAS), sinEntrega(), 'no sé');
        const opcionesCon = con.respuestas[0].opciones.map((o) => o.id);
        expect(opcionesCon).toContain(OPCION.ENTREGA_SERVIR);

        const sin = await decir(crear([]), sinEntrega(), 'no sé');
        expect(sin.respuestas[0].opciones.map((o) => o.id)).not.toContain(OPCION.ENTREGA_SERVIR);
    });

    test('sin mesas, «para servir» no se toma: se dice y se vuelve a preguntar', async () => {
        const d = await decir(crear([]), enEntrega(), 'para servir');
        expect(d.pasos[0].decision).toBe('pedido_servir_sin_mesas');
        expect(d.tarea.datos.entrega).toBeUndefined();
        expect(ENTREGA.MESA).toBe('MESA');
    });
});

// ── Teléfonos tomados por cortesía (Alejandra Benavidez, 2026-10-02 19:47) ──────────────────
// El bot pidió «Para mandártelo necesito un número de contacto 📱» (sin «?»), la clienta mandó
// «3218245714» y «3174924363», y el filtro de cortesías los calló: al quitar lo que no son letras
// no quedaba nada, y «nada» contaba como cortesía. El pedido nunca se creó.
describe('un número nunca es una cortesía', () => {
    const cortesia = require('../../intelligence/engine/cortesia');
    const PIDIO = 'Para mandártelo necesito un número de contacto, para que el domiciliario te llame al llegar 📱';
    const ctx = (texto) => ({ texto, conversacion: { variables: { turnos: 4, [cortesia.MARCA]: true } } });

    test.each(['3218245714', '3218245714\n3174924363', 'Calle 10 # 4-32', '2'])('%j no es cortesía', (t) => {
        expect(cortesia.leer(t).cortesia).toBe(false);
    });

    test('EL CASO: el teléfono tras «necesito un número» pasa al flujo', async () => {
        const d = await cortesia.decidir(ctx('3218245714'), { hayTarea: false, ultimoDelAsistente: async () => PIDIO });
        expect(d).toBeNull();
    });

    test('tras un mensaje que PIDE algo sin «?», ni un «ok» se calla', async () => {
        const d = await cortesia.decidir(ctx('ok'), { hayTarea: false, ultimoDelAsistente: async () => PIDIO });
        expect(d).toBeNull();
    });

    test('lo de antes sigue igual: «gracias» repetido tras un cierre se calla', async () => {
        const d = await cortesia.decidir(ctx('gracias'), {
            hayTarea: false,
            ultimoDelAsistente: async () => '¡Listo! Tu pedido quedó tomado. El número es ORD-7550.',
        });
        expect(d.pasos[0].decision).toBe('cortesia_sin_respuesta');
    });
});

// ── «salchipapa criollita» solo traía la familiar (2026-10-02 20:23) ────────────────────────
// La segunda pasada exige las dos palabras en nombre o descripción: solo la «familiar» escribe
// «salchipapas». Las criollitas pequeña, mediana y grande lo dicen en la CATEGORÍA, que es lo que
// mira la tercera… que no corría porque la segunda ya había encontrado algo.
describe('buscar_producto junta las pasadas en vez de quedarse con la primera', () => {
    const SALCHIPAPAS = [
        { id_producto: 30, nombre: 'criollita', descripcion: 'Tamaño pequeño. Papa a la francesa, carne desmechada', precio: 15500, visible: true },
        { id_producto: 61, nombre: 'criolla mediana', descripcion: 'Tamaño mediano. Papa a la francesa, carne desmechada', precio: 28000, visible: true },
        { id_producto: 63, nombre: 'criollita GRANDE', descripcion: 'Tamaño grande. Papa a la francesa, carne desmechada', precio: 39000, visible: true },
        { id_producto: 70, nombre: 'familiar', descripcion: 'Tamaño familiar de nuestras salchipapas, en sabor La Criollita', precio: 60000, visible: true },
    ];
    const sinTildes = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    let cartaService;
    let originales;
    beforeAll(() => {
        cartaService = require('../../app_restaurante_api/services/cartaService');
        originales = [cartaService.buscarProductos, cartaService.getCartaPublicaCompleta];
        // La misma semántica que el servicio: la frase entera contra nombre o descripción.
        cartaService.buscarProductos = async (idNegocio, termino) =>
            SALCHIPAPAS.filter((p) => sinTildes(p.nombre).includes(sinTildes(termino)) || sinTildes(p.descripcion).includes(sinTildes(termino)));
        cartaService.getCartaPublicaCompleta = async () => [{ nombre: 'SALCHIPAPAS', productos: SALCHIPAPAS }];
        adaptador.registrarCapacidades();
    });
    afterAll(() => {
        [cartaService.buscarProductos, cartaService.getCartaPublicaCompleta] = originales;
        registry._limpiar();
    });

    test('EL CASO: «salchipapa criollita» trae todas las presentaciones, no solo la familiar', async () => {
        const r = await registry.obtener('buscar_producto').ejecutar({ idNegocio: 6, args: { termino: 'salchipapa criollita' } });
        const nombres = r.productos.map((p) => p.nombre);
        expect(nombres).toEqual(expect.arrayContaining(['criollita', 'criolla mediana', 'criollita GRANDE', 'familiar']));
    });
});

// ── Tercera auditoría de la noche (20:00) ───────────────────────────────────────────────────
describe('pregunta del domicilio con un número dentro', () => {
    const { esPreguntaDeDomicilio } = require('../../intelligence/adapters/restaurante/flujo');
    test.each([
        'Pero es cerca vale 7.000 el domicilio?',
        '¿me cobran 8 mil el domi?',
        'el domicilio es de 7000?',
        'Cuánto vale el domicilio?',
    ])('%j es pregunta del domicilio', (t) => {
        expect(esPreguntaDeDomicilio(t)).toBe(true);
    });
    test.each(['quiero 2 criollitas a domicilio', 'Calle 7 # 10-20, el domicilio a nombre de Ana'])(
        '%j NO lo es',
        (t) => {
            expect(esPreguntaDeDomicilio(t)).toBe(false);
        }
    );
});

describe('preguntas durante la confirmación se contestan y se vuelve a pedir el sí', () => {
    const flujo = require('../../intelligence/adapters/restaurante/flujo');
    const confirmacion = require('../../intelligence/engine/confirmacion');
    const RANGO = { min: 7000, max: 9000, nota: 'Fuera de Pasto, desde $10.000.' };
    const crear = () =>
        flujo.crearFlujoRestaurante({
            contextoNegocio: {
                obtener: async () => ({
                    id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                    tipoNegocio: 'RESTAURANTE', tiempoEstimado: { min: 40, max: 60 }, domicilioRango: RANGO,
                }),
            },
            identidad: { resolver: async () => ({ principal: null }) },
            gate: { ejecutar: async () => { throw new Error('no se debía ejecutar'); } },
            tienePedidoReciente: async () => false,
            catalogo: {
                barrios: async () => ({ habilitado: false, barrios: [] }),
                mesas: async () => [],
                resolverBarrio: async () => null,
                resolverMesa: async () => null,
                resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
            },
        });
    const pendiente = () => ({
        id_conversacion: 'conv-ale', id_negocio: 6, canal: 'whatsapp', id_externo: 'CO.978929221155791',
        variables: { turnos: 6 }, tarea_actual: confirmacion.TAREA,
        tarea_datos: {
            capacidad: 'tomar_pedido', args: { items: [{ id_producto: 63, cantidad: 1 }] },
            preguntado_en: new Date().toISOString(), repreguntas: 0,
        },
    });
    const decir = (texto) =>
        crear()({ conversacion: pendiente(), mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });

    test('EL CASO: «¿vale 7.000 el domicilio?» → el rango, y otra vez el sí', async () => {
        const d = await decir('Pero es cerca vale 7.000 el domicilio?');
        expect(d.pasos[0].decision).toBe('confirmacion_pregunta_contestada');
        expect(d.respuestas[0].texto).toContain('entre $7.000 y $9.000');
        expect(d.respuestas[0].texto).toMatch(/confirmo tu pedido/);
        // El pendiente sigue intacto: no gasta la repregunta.
        expect(d.tarea.nombre).toBe(confirmacion.TAREA);
        expect(d.tarea.datos.repreguntas).toBe(0);
    });

    test('«¿cuánto se demora?» → «desde que se confirman», no «tu pedido»', async () => {
        const d = await decir('cuanto se demora?');
        expect(d.respuestas[0].texto).toContain('desde que se confirman');
        expect(d.respuestas[0].texto).not.toContain('tu pedido es');
    });
});

describe('el estado del pedido no inventa una etapa de cocina', () => {
    const { estadoParaElCliente, tiempoDelPedido } = require('../../intelligence/adapters/restaurante/index');
    const base = { estado: 'ABIERTA', tipo_pedido: 'DOMICILIO', estado_cocina: null, aviso_listo_en: null };

    test('sin etapa (el negocio no usa Cocina): «recibido», sin «en turno para la cocina»', () => {
        const t = estadoParaElCliente(base);
        expect(t).toMatch(/recibido/);
        expect(t).not.toMatch(/turno para la cocina/);
    });

    test('con la pantalla de Cocina, PENDIENTE sí dice «en turno»', () => {
        expect(estadoParaElCliente({ ...base, estado_cocina: 'PENDIENTE' })).toMatch(/en turno para la cocina/);
    });

    test('EL CASO Manuel: 1 h 20 min con estimado de 40–60 → pasado del tiempo', () => {
        const ahora = new Date('2026-10-02T19:41:00-05:00');
        const r = tiempoDelPedido({ fecha_creacion: '2026-10-02T18:21:00-05:00' }, { min: 40, max: 60 }, ahora);
        expect(r).toEqual({ minutos_desde_que_se_pidio: 80, pasado_del_tiempo_estimado: true });
        const a_tiempo = tiempoDelPedido({ fecha_creacion: '2026-10-02T19:11:00-05:00' }, { min: 40, max: 60 }, ahora);
        expect(a_tiempo.pasado_del_tiempo_estimado).toBe(false);
    });
});
