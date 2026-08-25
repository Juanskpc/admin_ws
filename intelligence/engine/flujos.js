/**
 * Qué flujo determinista atiende a cada clase de negocio.
 *
 * ## El fallo que obligó a escribir esto (2026-08-24)
 *
 * Hasta hoy había **un** manejador determinista y era el de agendar citas. Funcionaba porque
 * `reserva` era la única vertical. El día que el canal apuntó a un restaurante, el primer «hola»
 * pidió `consultar_servicios` —una capacidad de citas— sobre un negocio que no la tiene ni debe
 * tenerla: `CAPACIDAD_NO_HABILITADA`, turno en error, **y el cliente sin respuesta**.
 *
 * No fue un fallo de configuración. Fue que el motor daba por supuesto de qué iba el negocio.
 *
 * ## Por qué los flujos los declaran los adaptadores
 *
 * Un flujo conversacional **es conocimiento de dominio**: sabe que existen servicios y horas, o
 * que existen categorías y productos. Eso pertenece al adaptador de la vertical, no al núcleo
 * (ADR-009). Si el motor tuviera un `if (tipo === 'RESTAURANTE')`, añadir la sexta vertical
 * volvería a costar cirugía aquí, que es justo lo que el `git diff = 0` de F9 persigue evitar.
 *
 * Así que este archivo no nombra a ninguna vertical: solo guarda lo que le registraron y
 * responde a «¿quién atiende a este negocio?».
 *
 * ## Qué pasa con un tipo que nadie declaró
 *
 * Devuelve `null`, y quien enruta decide. **No se cae al flujo de citas por defecto**: eso es
 * exactamente lo que rompió hoy — un parqueadero o un gimnasio recibirían el menú de una
 * peluquería y fallarían igual, solo que más adelante y con peor cara.
 */
'use strict';

/** Map<TIPO_NEGOCIO, { vertical, manejar }> */
const porTipo = new Map();

/**
 * Declara que este flujo atiende a estas clases de negocio.
 *
 * @param {Object}   registro
 * @param {string}   registro.vertical — para el rastro del Ledger y los mensajes de error.
 * @param {string[]} registro.tipos    — nombres de `general.gener_tipo_negocio.nombre`.
 * @param {Function} registro.manejar  — el manejador, con el contrato de `motor.registrarManejador`.
 */
function registrar({ vertical, tipos, manejar }) {
    if (!vertical || !Array.isArray(tipos) || typeof manejar !== 'function') {
        throw new Error('Un flujo necesita { vertical, tipos: [], manejar() }.');
    }
    for (const tipo of tipos) {
        const clave = String(tipo).trim().toUpperCase();
        if (porTipo.has(clave)) {
            // Dos verticales peleándose el mismo tipo de negocio es un error de composición, y
            // uno que en producción se vería como «el bot contesta cosas de otro rubro».
            throw new Error(
                `El tipo de negocio "${clave}" ya lo atiende la vertical ` +
                    `"${porTipo.get(clave).vertical}"; "${vertical}" no puede reclamarlo también.`
            );
        }
        porTipo.set(clave, { vertical, manejar });
    }
}

/** El flujo de esta clase de negocio, o `null` si nadie la declaró. */
function para(tipoNegocio) {
    if (!tipoNegocio) return null;
    return porTipo.get(String(tipoNegocio).trim().toUpperCase()) || null;
}

/** Para diagnóstico y para el log de arranque. */
function listar() {
    return [...porTipo.entries()].map(([tipo, { vertical }]) => ({ tipo, vertical }));
}

/** Solo para tests. */
function _limpiar() {
    porTipo.clear();
}

module.exports = { registrar, para, listar, _limpiar };
