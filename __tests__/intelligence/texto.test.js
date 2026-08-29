/**
 * `engine/texto.js` — el reconocedor de comandos, y por qué importa que sea aburrido.
 *
 * Aquí no se entiende lenguaje: se reconocen palabras exactas. Todo lo que no case va al modelo,
 * que sí entiende. Esa frontera es el ahorro entero de ADR-018 —un saludo no debería costar una
 * llamada al modelo— pero también es donde se esconde un fallo que no parece un fallo:
 *
 * **Cuando falta una palabra, nada se rompe.** El modelo contesta algo plausible y el bot parece
 * funcionar peor sin que nadie sepa por qué. Es lo que pasó con «buenos días» hasta el
 * 2026-08-29: no estaba en la lista, caía al modelo, y el modelo saludaba **sin el enlace del
 * menú**, que es lo único que ese mensaje tenía que conseguir. Se leyó como «el bot responde de
 * la manera antigua».
 *
 * No hace falta base de datos: es lógica pura.
 */
'use strict';

const { COMANDO, esComando, ultimaLinea, normalizar } = require('../../intelligence/engine/texto');

describe('saludos', () => {
    // La lista de la que salió el fallo: así saluda la gente de verdad.
    test.each([
        'hola',
        'Hola',
        '¡Hola!',
        'buenos días',
        'Buenos dias',
        'buen día',
        'buenas',
        'buenas tardes',
        'buenas noches',
        'hey',
        'menu',
        'menú',
    ])('«%s» reabre la bienvenida', (texto) => {
        expect(esComando(texto, COMANDO.MENU)).toBe(true);
    });

    // Y la otra mitad, que es igual de importante: un saludo CON una pregunta detrás no es un
    // comando. Reiniciar ahí le borraría el hilo a alguien que está preguntando algo.
    test.each([
        'buenos días, ¿están abiertos?',
        'hola quiero pedir una hamburguesa',
        'quiero una hamburguesa',
        'a qué hora cierran',
    ])('«%s» NO reabre la bienvenida: lo contesta el modelo', (texto) => {
        expect(esComando(texto, COMANDO.MENU)).toBe(false);
    });
});

describe('los signos que rodean a un comando no cambian el comando', () => {
    test.each([
        ['ok!', 'SI'],
        ['sí.', 'SI'],
        ['dale!!', 'SI'],
        ['no!', 'NO'],
        ['cancelar.', 'CANCELAR'],
    ])('«%s» sigue siendo %s', (texto, lista) => {
        expect(esComando(texto, COMANDO[lista])).toBe(true);
    });

    test('pero no se comen letras: «sino» no es «si»', () => {
        expect(esComando('sino', COMANDO.SI)).toBe(false);
    });
});

describe('la ráfaga', () => {
    // El debounce junta varios mensajes en un turno, así que aquí no llega «sí» sino «sí\nsí».
    test('se mira la última línea, que es la intención actual', () => {
        expect(ultimaLinea('hola\n\nbuenas tardes')).toBe('buenas tardes');
        expect(esComando('quiero pedir\ncancelar', COMANDO.CANCELAR)).toBe(true);
    });

    test('y no «alguna»: «cancelar… no, sigue» no cancela', () => {
        expect(esComando('cancelar\nno, sigue', COMANDO.CANCELAR)).toBe(false);
    });
});

describe('normalizar', () => {
    test('quita tildes y mayúsculas, y deja los signos', () => {
        // Los signos se quitan en `esComando`, no aquí: `normalizar` la usan también las
        // expresiones regulares de los flujos.
        expect(normalizar('  ¡BUENOS DÍAS!  ')).toBe('¡buenos dias!');
    });
});
