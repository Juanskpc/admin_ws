/**
 * Un saludo con «veci» o con «¿cómo está?» es un saludo (Zona Burger, 2026-10-05).
 *
 * «Buenas noches veci» y «Hola cómo está» no casaban con `esSaludo` por una sola palabra, se
 * iban al modelo y el cliente recibía «¡Hola! Muy bien, gracias 😊» SIN la carta — que es lo
 * único que ese primer mensaje tiene que hacer.
 *
 * Correr con:  npx jest __tests__/intelligence/saludo_con_vocativo.test.js
 */
'use strict';

const { esSaludo } = require('../../intelligence/engine/texto');

describe('esSaludo', () => {
    test.each([
        'Buenas noches veci',
        'Hola cómo está',
        'Hola buenas noches veci, ¿cómo está?',
        'buenas tardes vecina',
        'Hola amiga',
        'Buenas señor',
        'hola veci 👋',
        // Lo de siempre sigue valiendo.
        'Buenas!',
        'holaa',
        'qué más',
        'qué dice',
    ])('%p es un saludo', (t) => {
        expect(esSaludo(t)).toBe(true);
    });

    test.each([
        'veci',
        'Esta',
        'cómo está',
        'esta porfa',
        'Buenas noches veci, tienen domicilio?',
        'Hola cómo está mi pedido',
        'Disculpe',
        'buenas noches veci para pedir una salchipapa',
    ])('%p NO es un saludo', (t) => {
        expect(esSaludo(t)).toBe(false);
    });
});
