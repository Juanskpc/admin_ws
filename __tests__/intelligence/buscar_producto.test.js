/**
 * Buscar en la carta lo que el bot acaba de ofrecer.
 *
 * ## De dónde sale
 *
 * De producción, el 2026-08-27, y el cliente lo cazó al vuelo:
 *
 * ```
 * 21:55:42  BOT      Para desayuno tenemos *empanadas de carne (x3)* por $9.000…
 * 21:56:11  CLIENTE  perfecto, las empanadas y el jugo está bien
 * 21:57:55  BOT      No encuentro las empanadas de carne en la carta ahora mismo.
 * 21:58:24  CLIENTE  por qué no lo encuentras? si me lo acabas de dar como opcion...
 * ```
 *
 * El producto 103 se llama **`Empanadas (x3)`** y su descripción dice **`De carne, con ají`**. El
 * modelo lo ofreció fusionando los dos campos —«empanadas de carne (x3)», que para un humano es
 * la forma natural de decirlo— y al buscar esa frase no apareció: `buscarProductos` compara la
 * **frase entera** contra el nombre y contra la descripción, cada uno por su lado, y esa frase no
 * está completa en ninguno de los dos.
 *
 * Es un fallo con dos caras y las dos se arreglaron: el prompt (`sistema.v7`) le dice al modelo
 * que no pegue la descripción al nombre, y **esto** hace que aunque lo haga, se encuentre igual.
 * De las dos, ésta es la que no depende de que el modelo obedezca.
 *
 * Correr con:  npx jest __tests__/intelligence/buscar_producto.test.js
 */
const registry = require('../../intelligence/core/registry');
const adaptador = require('../../intelligence/adapters/restaurante');

/** La carta real de pregonchos, tal como está en producción. */
const CARTA = [
    { id_producto: 103, nombre: 'Empanadas (x3)', descripcion: '(demo) De carne, con ají', precio: 9000, visible: true },
    { id_producto: 105, nombre: 'Sopa del día', descripcion: '(demo) Preguntar por la del día', precio: 11000, visible: true },
    { id_producto: 106, nombre: 'Bandeja paisa', descripcion: '(demo) Completa, con chicharrón', precio: 34000, visible: true },
    { id_producto: 110, nombre: 'Plato del personal', descripcion: '(demo) No se muestra en la carta', precio: 20000, visible: false },
    { id_producto: 112, nombre: 'Jugo natural', descripcion: '(demo) En agua o en leche', precio: 7000, visible: true },
];

const sinTildes = (t) =>
    String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * El doble de `cartaService.buscarProductos`, con **su** semántica exacta: la frase entera
 * contra el nombre, o la frase entera contra la descripción. Copiarla importa — si el doble
 * fuera más listo que el servicio real, esta suite probaría un mundo que no existe.
 */
function buscarComoElServicio(idNegocio, termino) {
    const t = sinTildes(termino);
    if (!t) return [];
    return CARTA.filter(
        (p) => sinTildes(p.nombre).includes(t) || sinTildes(p.descripcion).includes(t)
    );
}

let cartaService;
let originalBuscar;

beforeAll(() => {
    cartaService = require('../../app_restaurante_api/services/cartaService');
    originalBuscar = cartaService.buscarProductos;
    cartaService.buscarProductos = async (idNegocio, termino) =>
        buscarComoElServicio(idNegocio, termino);
    adaptador.registrarCapacidades();
});

afterAll(() => {
    cartaService.buscarProductos = originalBuscar;
    registry._limpiar();
});

const buscar = async (termino) => {
    const capacidad = registry.obtener('buscar_producto');
    return capacidad.ejecutar({ idNegocio: 12, args: { termino } });
};

const nombres = (r) => r.productos.map((p) => p.nombre);

describe('buscar_producto', () => {
    test('EL CASO: el nombre partido entre nombre y descripción ahora aparece', async () => {
        // «empanadas» está en el nombre; «de carne» solo en la descripción. La frase entera no
        // está en ninguno de los dos, y ahí es donde el servicio se rendía.
        expect(await buscarComoElServicio(12, 'empanadas de carne')).toHaveLength(0);

        const r = await buscar('empanadas de carne');
        expect(nombres(r)).toEqual(['Empanadas (x3)']);
    });

    test('y con el «(x3)» pegado, que es como lo dijo el modelo', async () => {
        const r = await buscar('empanadas de carne (x3)');
        expect(nombres(r)).toEqual(['Empanadas (x3)']);
    });

    test('lo que ya funcionaba sigue funcionando, y con una sola consulta', async () => {
        let consultas = 0;
        const anterior = cartaService.buscarProductos;
        cartaService.buscarProductos = async (n, t) => {
            consultas++;
            return buscarComoElServicio(n, t);
        };

        const r = await buscar('bandeja');

        expect(nombres(r)).toEqual(['Bandeja paisa']);
        // La segunda pasada solo corre si la primera no trajo nada.
        expect(consultas).toBe(1);
        cartaService.buscarProductos = anterior;
    });

    test('busca también por lo que dice la descripción', async () => {
        const r = await buscar('jugo en agua');
        expect(nombres(r)).toEqual(['Jugo natural']);
    });

    test('lo que de verdad no existe sigue sin existir', async () => {
        // La segunda pasada ensancha la búsqueda; no la convierte en adivinanza. Que el bot
        // diga «no lo tengo» cuando no lo tiene es la mitad de por qué se le puede creer.
        expect(nombres(await buscar('sushi de atún'))).toEqual([]);
        expect(nombres(await buscar('hamburguesa doble'))).toEqual([]);
    });

    test('exige TODAS las palabras, no cualquiera de ellas', async () => {
        // «bandeja» sola casaría con la paisa. Con «bandeja de sushi» no debe casar nada:
        // devolver la paisa aquí sería peor que no devolver nada.
        expect(nombres(await buscar('bandeja de sushi'))).toEqual([]);
    });

    test('lo que el negocio esconde no sale ni por la segunda pasada', async () => {
        // `visible: false` es lo que el negocio no quiere enseñar. La segunda pasada no puede
        // ser la puerta de atrás por la que se cuela — fue un agujero real el 2026-08-26.
        expect(nombres(await buscar('plato del personal'))).toEqual([]);
        expect(nombres(await buscar('personal no se muestra'))).toEqual([]);
    });
});
