'use strict';
/**
 * Cómo llama el negocio a lo que se le agrega a un producto (`gener_negocio.termino_adiciones`).
 *
 * Es solo la PALABRA que se enseña (en el POS, la carta digital, la cocina y el tiquete): la
 * función es la misma para todos. Un restaurante dice «adición de queso», una heladería
 * «toppings», una pizzería «ingredientes extra».
 *
 * ⚠️ Hay una copia en `restaurante_app/src/app/core/utils/terminos-adicion.ts` para pintar sin
 * esperar a la API. Añadir un término = añadir una fila aquí Y allí.
 */
const TERMINOS = Object.freeze({
    ADICION: { singular: 'Adición', plural: 'Adiciones' },
    TOPPING: { singular: 'Topping', plural: 'Toppings' },
    EXTRA: { singular: 'Extra', plural: 'Extras' },
    AGREGADO: { singular: 'Agregado', plural: 'Agregados' },
    ACOMPANAMIENTO: { singular: 'Acompañamiento', plural: 'Acompañamientos' },
    COMPLEMENTO: { singular: 'Complemento', plural: 'Complementos' },
    INGREDIENTE_EXTRA: { singular: 'Ingrediente extra', plural: 'Ingredientes extra' },
    SALSA: { singular: 'Salsa', plural: 'Salsas' },
});

const CODIGOS = Object.freeze(Object.keys(TERMINOS));
const POR_DEFECTO = 'ADICION';

/** El término de un código, o el de por defecto si el código no existe. */
function termino(codigo) {
    return TERMINOS[codigo] || TERMINOS[POR_DEFECTO];
}

module.exports = { TERMINOS, CODIGOS, POR_DEFECTO, termino };
