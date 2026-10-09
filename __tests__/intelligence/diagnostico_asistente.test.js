/**
 * Diagnóstico a fondo de la carta para el asistente (2026-10-05).
 *
 * La carta de prueba es la de Zona Burger ANTES de corregirla: lo que el diagnóstico tiene que
 * encontrar solo es lo que costó tres auditorías a mano.
 *
 * Correr con:  npx jest __tests__/intelligence/diagnostico_asistente.test.js
 */
'use strict';

const { analizarCarta, pruebaDeHumo, singular } = require('../../app_admin_api/services/diagnosticoAsistenteService');

const p = (nombre, precio, descripcion = '', extra = {}) => ({ nombre, precio, descripcion, visible: true, disponible: true, ...extra });
const CARTA = [
    {
        nombre: 'SALCHIPAPAS', visible: true,
        productos: [
            p('viciosa', 15500, 'Tamaño pequeño. Papas a la francesa'),
            p('viciosa mediana', 28000, 'Tamaño mediano'),
            p('viciosa GRANDE', 39000, 'Tamaño grande'),
            p('familiar', 60000, 'Tamaño familiar, en sabor La Criollita, The House o La Viciosa.'),
            p('concurso', 65000),
        ],
    },
    {
        nombre: 'GASEOSAS', visible: true,
        productos: [p('cuatro', 5000), p('Cigarra 400ml', 1), p('Postobón 1.5 ml', 10000), p('Agua', 4000)],
    },
    { nombre: 'HERVIDOS', visible: true, productos: [p('mora', 5000)] },
    { nombre: 'JUGOS NATURALES', visible: true, productos: [p('mora', 6000, '', { disponible: false })] },
    { nombre: 'EMPAQUES', visible: false, productos: [p('pequeño', 500)] },
];
const hallazgo = (clave) => analizarCarta(CARTA).find((h) => h.clave === clave);

describe('analizarCarta — lo que se ve mirando la carta', () => {
    test('un precio de $1 es crítico', () => {
        expect(hallazgo('carta_precios').estado).toBe('falta');
        expect(hallazgo('carta_precios').detalles).toEqual(['«Cigarra 400ml» vale $1']);
    });
    test('«1.5 ml» es una unidad mal escrita', () => {
        expect(hallazgo('carta_unidades').detalles).toEqual(['«Postobón 1.5 ml»']);
    });
    test('el tamaño pequeño que no dice que es pequeño, con sus hermanos', () => {
        const d = hallazgo('carta_tamanos').detalles;
        expect(d).toHaveLength(1);
        expect(d[0]).toContain('«viciosa» no dice su tamaño');
        expect(d[0]).toContain('viciosa mediana');
    });
    test('varios sabores en la descripción de un solo producto', () => {
        expect(hallazgo('carta_sabores').detalles[0]).toContain('«familiar»');
    });
    test('nombres que no dicen qué son; «Agua» se explica sola', () => {
        const d = hallazgo('carta_nombres').detalles.join(' ');
        expect(d).toContain('«cuatro»');
        expect(d).toContain('«mora» (en HERVIDOS)');
        expect(d).not.toContain('Agua');
    });
    test('dos productos con el mismo nombre en categorías distintas', () => {
        expect(hallazgo('carta_duplicados').detalles[0]).toBe('«mora» está en HERVIDOS y JUGOS NATURALES');
    });
    test('sin descripción: no se le pide a una bebida embotellada', () => {
        const d = hallazgo('carta_descripciones').detalles.join(' ');
        expect(d).toContain('«concurso»');
        expect(d).not.toContain('Postobón');
        expect(d).not.toContain('cuatro');
    });
    test('una categoría con todo no disponible', () => {
        expect(hallazgo('carta_categorias').detalles).toEqual(['«JUGOS NATURALES»: sus 1 productos están marcados como no disponibles']);
    });
    test('lo oculto (EMPAQUES) no se revisa', () => {
        expect(JSON.stringify(analizarCarta(CARTA))).not.toContain('pequeño');
    });
    test('una carta limpia no tiene hallazgos', () => {
        const limpia = [{ nombre: 'HAMBURGUESAS', visible: true, productos: [p('Hamburguesa clásica', 15000, 'Carne, queso y vegetales')] }];
        expect(analizarCarta(limpia)).toEqual([]);
    });
});

describe('pruebaDeHumo — se le pregunta al buscador como pregunta un cliente', () => {
    test('«CARNES» se pide «carne»', () => expect(singular('CARNES')).toBe('carne'));

    test('un buscador que solo encuentra por nombre exacto falla «viciosa pequeña» y «gaseosa personal»', async () => {
        const todos = CARTA.flatMap((c) => c.productos);
        const buscar = async (termino) => ({ productos: todos.filter((x) => x.nombre.toLowerCase() === termino) });
        const r = await pruebaDeHumo(CARTA, buscar);
        const texto = r.fallidas.join('\n');
        expect(r.pruebas).toBeGreaterThan(8);
        expect(texto).toContain('«viciosa pequeña»');
        expect(texto).toContain('«gaseosa personal»');
        expect(texto).not.toContain('«viciosa mediana»'); // su nombre exacto sí lo encuentra
    });

    test('con un buscador que lo encuentra todo no hay fallos; y no prueba lo no disponible', async () => {
        const vistos = [];
        const buscar = async (termino) => {
            vistos.push(termino);
            return { productos: CARTA.flatMap((c) => c.productos) };
        };
        const r = await pruebaDeHumo(CARTA, buscar);
        expect(r.fallidas).toEqual([]);
        expect(vistos).not.toContain('jugo naturale'); // toda la categoría está no disponible
    });

    test('un buscador que revienta cuenta como «no encontró», no tumba el diagnóstico', async () => {
        const r = await pruebaDeHumo(CARTA, async () => { throw new Error('caída'); });
        expect(r.fallidas.length).toBe(r.pruebas);
    });
});
