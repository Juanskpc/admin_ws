/**
 * «¿Cuánto vale el domicilio?» — el RANGO que declara cada negocio.
 *
 * ## De dónde sale
 *
 * 2026-10-02: cargar el valor del domicilio barrio por barrio resultó tedioso. Zona Burger lo
 * dice así: en Pasto, entre $7.000 y $9.000; fuera de la ciudad, de $10.000 para arriba. Eso se
 * escribe en la Bandeja (mínimo, máximo y una nota) y el asistente lo contesta sin gastar un
 * modelo, siempre aclarando que el valor exacto lo confirma el restaurante.
 *
 * Sin rango configurado no se inventa ninguno: se cede al modelo, como hasta hoy.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_domicilio_rango.test.js
 */
const flujo = require('../../intelligence/adapters/restaurante/flujo');
const { normalizarDomicilioRango } = require('../../intelligence/core/contextoNegocio');

const {
    esPreguntaDeDomicilio,
    esPreguntaDeTiempo,
    fraseDeDomicilio,
    rangoEnPalabras,
    reclama,
    crearFlujoRestaurante,
    TAREA_PEDIDO,
} = flujo;

const ZONA_BURGER = { min: 7000, max: 9000, nota: 'Fuera de la ciudad, desde $10.000.' };

describe('esPreguntaDeDomicilio', () => {
    test.each([
        '¿Cuánto vale el domicilio?',
        'cuanto cuesta el domicilio',
        'Cuánto sale el domicilio a Torobajo?',
        'cuánto es el domicilio',
        'valor del domicilio?',
        'precio del envío',
        'el domicilio cuánto vale',
        'cuánto me cobran por traerlo?',
        'tiene costo el domicilio?',
    ])('reconoce %j', (texto) => {
        expect(esPreguntaDeDomicilio(texto)).toBe(true);
    });

    test.each([
        'Quiero dos hamburguesas a domicilio',
        'Cuánto vale la criollita?',
        'cuanto es el total',
        'cuánto se demora el domicilio',
        'hola',
        '',
        // Un mensaje largo que menciona el domicilio es un pedido, no esta pregunta.
        'quiero una hamburguesa doble con papas y una gaseosa, cuánto vale el domicilio hasta mi casa en el norte',
    ])('NO reconoce %j', (texto) => {
        expect(esPreguntaDeDomicilio(texto)).toBe(false);
    });

    test('«cuánto se demora el domicilio» sigue siendo de TIEMPO', () => {
        expect(esPreguntaDeTiempo('cuánto se demora el domicilio')).toBe(true);
    });

    test('el enrutador la reclama para el flujo, sin gastar un modelo', () => {
        expect(reclama('cuánto vale el domicilio?')).toBe(true);
    });
});

describe('fraseDeDomicilio', () => {
    test('EL CASO Zona Burger: rango, nota y quién confirma el valor exacto', () => {
        expect(fraseDeDomicilio(ZONA_BURGER)).toBe(
            'El domicilio vale *entre $7.000 y $9.000*, según dónde estés 🛵\n' +
                'Fuera de la ciudad, desde $10.000.\n' +
                'El valor exacto te lo confirma el restaurante al despachar tu pedido 😊'
        );
    });

    test('solo mínimo → «desde»; cero → gratis', () => {
        expect(fraseDeDomicilio({ min: 5000, max: null, nota: null })).toContain('*desde $5.000*');
        expect(fraseDeDomicilio({ min: 0, max: null, nota: null })).toContain('*gratis*');
        expect(rangoEnPalabras({ min: 0, max: 3000 })).toBe('entre $0 y $3.000');
    });

    test('solo la nota también se dice', () => {
        const f = fraseDeDomicilio({ min: null, max: null, nota: 'Depende del barrio, entre 5 y 8 mil.' });
        expect(f).toContain('Depende del barrio');
        expect(f).not.toContain('*');
    });

    test('sin configurar no se inventa un valor', () => {
        expect(fraseDeDomicilio(null)).toBeNull();
        expect(fraseDeDomicilio({ min: null, max: null, nota: '  ' })).toBeNull();
    });
});

describe('normalizarDomicilioRango (lo que se lee de gener_negocio)', () => {
    test('columnas vacías → null', () => {
        expect(normalizarDomicilioRango({ min: null, max: null, nota: null })).toBeNull();
        expect(normalizarDomicilioRango(undefined)).toBeNull();
    });

    test('un máximo igual o menor que el mínimo no es un rango', () => {
        expect(normalizarDomicilioRango({ min: 7000, max: 7000, nota: null })).toEqual({
            min: 7000, max: null, nota: null,
        });
    });

    test('el caso completo', () => {
        expect(normalizarDomicilioRango({ min: 7000, max: 9000, nota: ' Fuera, desde $10.000 ' })).toEqual({
            min: 7000, max: 9000, nota: 'Fuera, desde $10.000',
        });
    });
});

// ── El flujo entero, con dobles ─────────────────────────────────────────────────────────────

function crear(domicilioRango) {
    return crearFlujoRestaurante({
        contextoNegocio: {
            obtener: async () => ({
                id: 6, nombre: 'ZONA BURGER', tratamiento: 'ZONA BURGER', atencion: null,
                tipoNegocio: 'RESTAURANTE', tiempoEstimado: null, domicilioRango,
            }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        ahora: () => new Date('2026-10-01T20:00:00-05:00'),
        catalogo: {
            barrios: async () => ({ habilitado: false, barrios: [] }),
            mesas: async () => [],
            resolverBarrio: async () => null,
            resolverMesa: async () => null,
            resolverExclusiones: async () => ({ validas: [], descartadas: [] }),
        },
    });
}

const sinTarea = () => ({
    id_conversacion: 'conv-1', id_negocio: 6, canal: 'whatsapp', id_externo: '573000000000',
    variables: { turnos: 2, nombre: 'Ana' }, tarea_actual: null, tarea_datos: {},
});
const enPaso = (paso) => ({
    ...sinTarea(),
    tarea_actual: TAREA_PEDIDO,
    tarea_datos: { items: [{ id_producto: 30, cantidad: 1 }], nombre: 'Ana', entrega: 'DOMICILIO', paso, repreguntas: 0 },
});

const decir = (manejar, conversacion, texto) =>
    manejar({ conversacion, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });
const decisiones = (d) => (d.pasos || []).map((p) => p.decision);
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));

describe('el flujo contesta con el rango del negocio', () => {
    test('EL CASO: «¿cuánto vale el domicilio?» → el rango, sin modelo', async () => {
        const d = await decir(crear(ZONA_BURGER), sinTarea(), '¿Cuánto vale el domicilio?');

        expect(decisiones(d)).toContain('valor_domicilio_respondido');
        expect(textos(d)).toEqual([fraseDeDomicilio(ZONA_BURGER)]);
        expect(d.resultado).toBe('resuelto');
        expect(d.nivel).toBe('determinista');
    });

    test('sin rango configurado → no se inventa nada: lo cede al modelo', async () => {
        const d = await decir(crear(null), sinTarea(), 'cuánto vale el domicilio?');

        expect(decisiones(d)).toContain('cedido_al_modelo');
        expect(d.respuestas).toHaveLength(0);
    });

    test('a mitad de un pedido: responde el rango Y retoma la pregunta, sin soltar la tarea', async () => {
        const d = await decir(crear(ZONA_BURGER), enPaso('direccion'), 'cuánto vale el domicilio');

        const [texto] = textos(d);
        expect(texto).toContain('entre $7.000 y $9.000');
        expect(texto.indexOf('$9.000')).toBeLessThan(texto.indexOf('dirección'));
        expect(d.tarea.datos.paso).toBe('direccion');
        expect(d.tarea.datos.direccion).toBeUndefined();
        expect(Number(d.tarea.datos.repreguntas || 0)).toBe(0);
    });
});
