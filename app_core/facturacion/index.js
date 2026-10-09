'use strict';
/**
 * Lo que una vertical puede usar de la facturación electrónica. Nada más sale de este módulo
 * hacia ellas (ADR-005): la vertical avisa de que cobró y sigue con lo suyo.
 */
const { alCobrarPedido, alAnularPedido } = require('./emisionService');

module.exports = { alCobrarPedido, alAnularPedido };
