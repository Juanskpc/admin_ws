'use strict';
/**
 * El bloque de datos del cliente que trae el mensaje del menú digital, ANTES de la línea `#P…`:
 *
 *     Nombre: Ana Pérez
 *     Teléfono: 3001234567
 *     Dirección: Cra 3 #21-10, apto 201
 *     Nota: sin cebolla en todo
 *
 *     #P12-4x2,9x1~m=D
 *
 * ⚠️ Contrato con `restaurante_app/.../menu-publico/datos-cliente.ts` (constante `ETIQUETAS`),
 * que lo escribe. Cambiar una etiqueta aquí sin cambiarla allá hace que el bot deje de leer un
 * dato que el cliente sí escribió — y no avisa: simplemente vuelve a preguntarlo.
 *
 * ## Por qué un parser por etiqueta, y no genérico
 *
 * Determinista y gratis, como `codigoPedido.js`: el modelo no interviene en leer cuatro líneas
 * con forma fija. Una etiqueta ausente o vacía no rompe nada — sencillamente no se siembra ese
 * dato, y `loQueFalta` lo pregunta como si el cliente hubiera llegado sin él.
 *
 * ## Todo esto es una SUGERENCIA, nunca una verdad
 *
 * El mensaje se puede editar antes de enviarlo. Lo que se lee aquí llena `tarea_datos` del
 * pedido —el mismo sitio que llenan las preguntas del flujo— y pasa por el MISMO camino: la
 * confirmación se lo vuelve a enseñar al cliente antes del «sí» (ADR-010). Nada de esto crea
 * nada por sí solo.
 */

/** Las etiquetas, en el orden en que se escriben. Igual que `ETIQUETAS` en el otro repo. */
const ETIQUETAS = { nombre: 'Nombre', telefono: 'Teléfono', direccion: 'Dirección', nota: 'Nota' };

const MAXIMOS = { nombre: 100, telefono: 20, direccion: 300, nota: 300 };

/**
 * `Etiqueta: valor` **al principio de una línea**, con el valor hasta el fin de esa línea. Una
 * etiqueta que aparezca dentro del VALOR de otra (una nota con «Dirección: otra cosa» pegado) no
 * cuenta: solo se lee lo que empieza línea, así que no hay forma de inyectar un dato falso desde
 * dentro de otro campo.
 */
function leerBloque(texto) {
    const lineas = String(texto || '').split(/\r?\n/);
    const datos = {};
    for (const linea of lineas) {
        for (const [campo, etiqueta] of Object.entries(ETIQUETAS)) {
            if (datos[campo] !== undefined) continue; // la primera aparición manda
            const patron = new RegExp(`^\\s*${etiqueta}\\s*:\\s*(.*)$`, 'i');
            const m = patron.exec(linea);
            if (!m) continue;
            const valor = sanear(m[1], MAXIMOS[campo]);
            if (valor) datos[campo] = valor;
        }
    }
    return datos;
}

/** Corta espacios y controla el largo; no hace falta más porque ya viene de una sola línea. */
function sanear(valor, max) {
    return String(valor ?? '').trim().slice(0, max);
}

/**
 * ¿El mensaje trae el bloque? Antes de gastar la lectura completa.
 */
function loTrae(texto) {
    return new RegExp(`^\\s*${ETIQUETAS.nombre}\\s*:`, 'im').test(String(texto || ''));
}

module.exports = { ETIQUETAS, MAXIMOS, leerBloque, loTrae, sanear };
