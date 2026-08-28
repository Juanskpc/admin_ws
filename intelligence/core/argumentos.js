/**
 * Validación estricta de los argumentos de una capacidad.
 *
 * Es la frontera entre "alguien pidió algo raro" y "el dominio recibió basura". Quien
 * llama puede ser una CLI hoy y un modelo de lenguaje en F6; ninguno de los dos merece
 * confianza, así que la validación no depende de quién llama.
 *
 * **Estricto significa estricto:** un argumento no declarado es un error, no algo que se
 * ignore en silencio. Un parámetro sobrante suele ser una de dos cosas: el catálogo y quien
 * llama se desincronizaron, o alguien está intentando colar `id_negocio` por la puerta de
 * atrás. Las dos merecen un rechazo ruidoso.
 *
 * No se usa una librería de esquemas (ajv y compañía) a propósito: el metamodelo declara
 * seis tipos, los argumentos de una acción de negocio son un puñado, y una dependencia
 * nueva en el camino crítico de seguridad se paga en mantenimiento para siempre.
 */
'use strict';

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function rechazar(mensaje) {
    const e = new Error(mensaje);
    e.code = 'ARGUMENTOS_INVALIDOS';
    e.statusCode = 400;
    throw e;
}

function coercionar(nombre, decl, valor) {
    switch (decl.tipo) {
        case 'string': {
            if (typeof valor !== 'string') rechazar(`"${nombre}" debe ser texto.`);
            const limpio = valor.trim();
            if (decl.min_longitud && limpio.length < decl.min_longitud) {
                rechazar(`"${nombre}" es demasiado corto (mínimo ${decl.min_longitud}).`);
            }
            if (decl.max_longitud && limpio.length > decl.max_longitud) {
                rechazar(`"${nombre}" es demasiado largo (máximo ${decl.max_longitud}).`);
            }
            return limpio;
        }
        case 'entero': {
            const n = Number(valor);
            if (!Number.isInteger(n)) rechazar(`"${nombre}" debe ser un entero.`);
            if (decl.min !== undefined && n < decl.min) rechazar(`"${nombre}" debe ser >= ${decl.min}.`);
            if (decl.max !== undefined && n > decl.max) rechazar(`"${nombre}" debe ser <= ${decl.max}.`);
            return n;
        }
        case 'numero': {
            const n = Number(valor);
            if (!Number.isFinite(n)) rechazar(`"${nombre}" debe ser un número.`);
            if (decl.min !== undefined && n < decl.min) rechazar(`"${nombre}" debe ser >= ${decl.min}.`);
            if (decl.max !== undefined && n > decl.max) rechazar(`"${nombre}" debe ser <= ${decl.max}.`);
            return n;
        }
        case 'booleano': {
            if (typeof valor === 'boolean') return valor;
            if (valor === 'true') return true;
            if (valor === 'false') return false;
            return rechazar(`"${nombre}" debe ser booleano.`);
        }
        case 'fecha': {
            // Fecha de negocio: `YYYY-MM-DD` en hora Bogotá, la misma convención que usan
            // las verticales. No se acepta un instante con huso: una cita es a las 3 de la
            // tarde del día que dice el cliente, no un punto UTC.
            const s = String(valor).trim();
            if (!FECHA_ISO.test(s)) rechazar(`"${nombre}" debe tener el formato YYYY-MM-DD.`);
            const d = new Date(`${s}T00:00:00-05:00`);
            if (Number.isNaN(d.getTime())) rechazar(`"${nombre}" no es una fecha real.`);
            return s;
        }
        case 'enum': {
            const s = String(valor);
            if (!decl.valores.includes(s)) {
                rechazar(`"${nombre}" debe ser uno de: ${decl.valores.join(', ')}.`);
            }
            return s;
        }
        case 'lista': {
            // Una lista de objetos con forma declarada. Existe desde `tomar_pedido`
            // (2026-08-24): un catálogo que no sabe decir «varios de algo» no puede expresar un
            // pedido, y hasta entonces todas las capacidades pedían valores sueltos.
            //
            // Cada elemento se valida con el MISMO `coercionar`, recursivamente. No es elegancia:
            // es que los límites de un `id_producto` dentro de una lista tienen que ser los
            // mismos que fuera, y dos validadores distintos divergen el día que nadie mira.
            //
            // ⚠️ Una lista que llega como TEXTO se acepta si el texto es la lista.
            //
            // Es un tropiezo conocido del function-calling y se vio en producción el
            // 2026-08-26: el modelo mandó `items` como `"[{\"id_producto\":106,…}]"` —la lista
            // correcta, serializada— y antes de eso `"106x1,109x1,111x2"`, que es el código
            // compacto del carrito copiado tal cual. Le costó tres llamadas acertar.
            //
            // Rechazar lo segundo es correcto: no es una lista, es otra cosa. Rechazar lo
            // primero era terquedad cara: los datos estaban bien y completos, y la única
            // diferencia era una comilla. Se aceptan **solo** si el texto parsea a un array;
            // cualquier otra cosa sigue siendo un argumento inválido y se dice.
            const lista = comoLista(valor);
            if (!Array.isArray(lista)) rechazar(`"${nombre}" debe ser una lista.`);
            if (decl.min_items && lista.length < decl.min_items) {
                rechazar(`"${nombre}" necesita al menos ${decl.min_items} elemento(s).`);
            }
            if (decl.max_items && lista.length > decl.max_items) {
                rechazar(`"${nombre}" admite como mucho ${decl.max_items} elemento(s).`);
            }

            const forma = decl.elemento || {};
            return lista.map((item, i) => {
                if (item === null || typeof item !== 'object' || Array.isArray(item)) {
                    rechazar(`"${nombre}[${i}]" debe ser un objeto.`);
                }
                const limpio = {};
                for (const [campo, subDecl] of Object.entries(forma)) {
                    const bruto = item[campo];
                    if (bruto === undefined || bruto === null || bruto === '') {
                        if (subDecl.requerido) rechazar(`Falta "${campo}" en "${nombre}[${i}]".`);
                        continue;
                    }
                    limpio[campo] = coercionar(`${nombre}[${i}].${campo}`, subDecl, bruto);
                }
                return limpio;
            });
        }
        default:
            return rechazar(`"${nombre}" declara un tipo desconocido: ${decl.tipo}.`);
    }
}

/**
 * Valida y normaliza los argumentos contra el esquema declarado por la capacidad.
 *
 * @returns {Object} argumentos limpios — los únicos que llegan a `ejecutar`.
 */
function validar(capacidad, argumentos = {}) {
    if (argumentos === null || typeof argumentos !== 'object' || Array.isArray(argumentos)) {
        rechazar('Los argumentos deben ser un objeto.');
    }

    const declarados = capacidad.parametros || {};

    for (const nombre of Object.keys(argumentos)) {
        if (!(nombre in declarados)) {
            rechazar(
                `"${nombre}" no es un parámetro de "${capacidad.nombre}". Parámetros ` +
                    `admitidos: ${Object.keys(declarados).join(', ') || 'ninguno'}.`
            );
        }
    }

    const limpios = {};
    for (const [nombre, decl] of Object.entries(declarados)) {
        const valor = argumentos[nombre];
        const ausente = valor === undefined || valor === null || valor === '';

        if (ausente) {
            if (decl.requerido) rechazar(`Falta el parámetro obligatorio "${nombre}".`);
            if (decl.por_defecto !== undefined) limpios[nombre] = decl.por_defecto;
            continue;
        }
        limpios[nombre] = coercionar(nombre, decl, valor);
    }

    return limpios;
}

/**
 * Lo que el modelo mandó, leído como lista — o lo que sea, si no lo es.
 *
 * Se extrajo de `coercionar` el 2026-08-27 porque **hacía falta en dos sitios y solo estaba en
 * uno**. El otro es el texto de la pregunta de confirmación, que corre sobre los argumentos
 * CRUDOS —antes de validar nada— y hacía `.reduce` sobre ellos. Cuando el modelo mandó `items`
 * serializado, `pregunta()` reventó, el turno cayó al respaldo y el cliente no recibió nada.
 *
 * No valida: solo desenvuelve. Quien valida sigue siendo `validar`.
 */
function comoLista(valor) {
    if (Array.isArray(valor)) return valor;
    if (typeof valor === 'string') {
        try {
            const parseado = JSON.parse(valor);
            if (Array.isArray(parseado)) return parseado;
        } catch (_) {
            // No era una lista serializada. Se devuelve tal cual y quien llame decide.
        }
    }
    return valor;
}

module.exports = { validar, comoLista };
