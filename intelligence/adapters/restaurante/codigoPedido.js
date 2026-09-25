/**
 * El código compacto que manda el menú digital.
 *
 * ## Qué es y por qué existe
 *
 * Cuando el cliente arma el carrito en la carta y pulsa «Continuar por WhatsApp», se abre un
 * mensaje con dos mitades:
 *
 *     Hola, quiero pedir:
 *
 *     • 2 × Bandeja paisa
 *     • 1 × Limonada de coco
 *
 *     Total aproximado: $78.000
 *
 *     #P12-4x2,9x1~m=D~z=7        ← esta línea
 *
 * La parte de arriba la lee una persona. La última línea la lee esto.
 *
 * **Sin el código habría que entender la prosa**, y eso lo hace bien el modelo pero cuesta
 * dinero por turno y puede equivocarse: «dos bandejas» y «2 bandejas» y «un par de bandejas»
 * son la misma cosa para un humano y tres problemas distintos para una expresión regular. Con
 * el código, leer el pedido es determinista, gratis y no falla nunca.
 *
 * Van **ids y no nombres** porque el mensaje viaja dentro de una URL —`wa.me/...?text=`— y los
 * nombres se comen el largo disponible enseguida.
 *
 * ## Ingredientes que se quitan (desde 2026-09-24)
 *
 * Una línea puede llevar `-r<id>.<id>…`: los ingredientes que el cliente quitó de ese plato.
 *
 *     #P12-4x1-r12.15,9x2        1 × producto 4 SIN los ingredientes 12 y 15; 2 × producto 9
 *
 * Dos líneas del mismo producto con distintas exclusiones son líneas distintas (`4x1-r12,4x1`):
 * solo se suman las que coinciden en producto Y exclusiones. Un `-r` sin ids válidos se ignora y
 * la línea se lee como siempre. Como todo lo del código, son una SUGERENCIA: `tomar_pedido`
 * comprueba que cada id sea removible de ese producto en este negocio (`exclusiones.js`).
 * Lo escribe `carrito.service.ts`.
 *
 * ## Los modificadores opcionales (desde 2026-09-24)
 *
 * Después de los productos pueden venir modificadores `~<letra>=<valor>`, que llevan lo que el
 * cliente YA eligió en la carta para que el bot no se lo vuelva a preguntar:
 *
 *     ~m=D | R | L     cómo lo recibe: D domicilio, R recoger en el local, L en el local (mesa)
 *     ~z=<id>          barrio del domicilio (`rest_barrio_domicilio.id_barrio`); `~z=0` = «Otro
 *                      barrio»: el restaurante confirma el valor del domicilio
 *     ~t=<id>          mesa (`rest_mesa.id_mesa`), solo con m=L
 *
 * Son **una sugerencia del cliente, nunca una verdad**: el mensaje se puede editar antes de
 * enviarlo. El servidor relee el barrio (y con él el valor del domicilio) y la mesa desde la base
 * y comprueba que sean de ESTE negocio; aquí solo se convierten en números. Un código sin
 * modificadores —todos los que se generaron antes de esta fecha— se lee exactamente igual que
 * siempre y el objeto devuelto NO gana claves nuevas. Un modificador desconocido o con basura se
 * ignora: el pedido no se rechaza por eso.
 *
 * ⚠️ Lo escribe `carrito.service.ts` (restaurante_app). Cambiar el formato en uno sin el otro
 * hace que el cliente mande un pedido que nadie entiende.
 *
 * ## Lo que este archivo NO decide
 *
 * No valida que los productos existan, ni calcula el total, ni crea nada. Solo convierte texto
 * en `[{id_producto, cantidad}]`. Quién manda sobre los precios y la disponibilidad es
 * `tomar_pedido`, que relee el catálogo — si algo cambió entre que el cliente miró la carta y
 * escribió, gana el catálogo. Lo que el menú mostró es una estimación, no una promesa.
 *
 * ## El id de negocio que viene dentro
 *
 * El código lleva el negocio (`#P12-...`) y **se comprueba**, pero no se usa: el `id_negocio`
 * real lo impone la plataforma desde el Principal (ADR-010). Sirve para detectar un caso muy
 * concreto y muy confuso: alguien que armó el carrito en la carta de un restaurante y lo mandó
 * al WhatsApp de otro. Sin la comprobación, ese pedido se crearía con los ids de productos del
 * negocio equivocado — que o no existen, o son otra cosa.
 */
'use strict';

/**
 * `#P<negocio>-<id>x<cant>[,<id>x<cant>...]`
 *
 * Anclado al final de línea y admitiendo espacios alrededor: el cliente casi siempre escribe
 * algo antes de enviar, y el mensaje llega con saltos de línea de por medio.
 */
const ITEM = String.raw`\d+x\d+(?:-r[0-9A-Za-z.]*)?`;
const PATRON = new RegExp(String.raw`#P(\d+)-(${ITEM}(?:,${ITEM})*)((?:~[a-z]=[A-Za-z0-9]*)*)\s*$`, 'im');

/**
 * Igual que `PATRON`, pero con `g`: sirve para recorrer TODAS las coincidencias del mensaje y
 * quedarse con la ÚLTIMA (`buscarUltimo`), que es donde vive el código de verdad.
 *
 * Hace falta desde que el bloque de datos del cliente (`datosCliente.js`) se antepuso al código:
 * un valor libre —una dirección, una nota— puede contener algo con forma `#P12-4x1` al final de
 * su línea, y con `im` a secas `PATRON.exec` se habría quedado con la PRIMERA coincidencia del
 * mensaje, que ya no es necesariamente la real.
 */
const PATRON_GLOBAL = new RegExp(PATRON.source, 'gim');

/** La última coincidencia de `PATRON` en el texto, o `null`. El código real es siempre la última línea. */
function buscarUltimo(texto) {
    const cadena = String(texto || '');
    let ultimo = null;
    // `matchAll` reinicia el índice en cada llamada; no comparte estado con `PATRON` (que no lleva `g`).
    for (const m of cadena.matchAll(PATRON_GLOBAL)) ultimo = m;
    return ultimo;
}

/** Máximo de ingredientes quitados por línea: más que esto no viene de una persona. */
const MAX_EXCLUSIONES = 12;

/** `"12.15"` → `[12, 15]`: enteros positivos, sin repetidos. */
function leerExclusiones(crudo) {
    const ids = [];
    for (const parte of String(crudo || '').split('.')) {
        if (!/^\d{1,9}$/.test(parte)) continue;
        const n = Number(parte);
        if (n > 0 && !ids.includes(n)) ids.push(n);
        if (ids.length >= MAX_EXCLUSIONES) break;
    }
    return ids.sort((a, b) => a - b);
}

/** `m=` → el `tipo_pedido` del dominio. */
const MODALIDAD = { D: 'DOMICILIO', R: 'LLEVAR', L: 'MESA' };

/**
 * Lee los modificadores. Devuelve solo los que son válidos; el resto se ignora.
 * `z=0` es «otro barrio» (`idBarrio: 0`); un id de barrio o de mesa tiene que ser entero > 0.
 */
function leerModificadores(crudo) {
    const salida = {};
    for (const par of String(crudo || '').split('~').filter(Boolean)) {
        const [clave, valor] = par.split('=');
        if (clave === 'm' && MODALIDAD[valor]) salida.modalidad = MODALIDAD[valor];
        else if (clave === 'z' && /^\d{1,9}$/.test(valor)) salida.idBarrio = Number(valor);
        else if (clave === 't' && /^\d{1,9}$/.test(valor) && Number(valor) > 0) {
            salida.idMesa = Number(valor);
        }
    }
    return salida;
}

/** Tope de seguridad. Un pedido con más líneas que esto no viene de un carrito, viene de un bot. */
const MAX_ITEMS = 30;

/**
 * Extrae el pedido de un mensaje, o `null` si no lo lleva.
 *
 * @param {string} texto
 * @returns {{idNegocio: number, items: Array<{id_producto: number, cantidad: number}>}|null}
 */
function leer(texto) {
    const encontrado = buscarUltimo(texto);
    if (!encontrado) return null;

    const idNegocio = Number(encontrado[1]);
    const items = [];

    for (const par of encontrado[2].split(',')) {
        const [cabeza, quitados] = par.split('-r');
        const [id, cantidad] = cabeza.split('x').map(Number);
        if (!Number.isInteger(id) || id <= 0) continue;
        if (!Number.isInteger(cantidad) || cantidad <= 0) continue;
        items.push({ id_producto: id, cantidad, exclusiones: leerExclusiones(quitados) });
    }

    if (items.length === 0 || items.length > MAX_ITEMS) return null;

    // Un mismo producto puede aparecer dos veces si el carrito se armó raro. Se suman en vez de
    // crear dos líneas —el cliente pidió tres, no dos y una—, pero SOLO si coinciden también en
    // lo que se quita: «una sin cebolla» y «una con todo» son dos líneas.
    const sumados = new Map();
    for (const i of items) {
        const clave = `${i.id_producto}:${i.exclusiones.join('.')}`;
        const previo = sumados.get(clave);
        if (previo) previo.cantidad += i.cantidad;
        else sumados.set(clave, { ...i });
    }

    return {
        idNegocio,
        // `exclusiones` solo aparece en la línea que la lleva: un código sin `-r` da el mismo
        // objeto de siempre.
        items: [...sumados.values()].map(({ id_producto, cantidad, exclusiones }) => ({
            id_producto,
            cantidad,
            ...(exclusiones.length ? { exclusiones } : {}),
        })),
        ...leerModificadores(encontrado[3]),
    };
}

/** ¿Este mensaje trae un pedido del menú digital? */
function loTrae(texto) {
    return PATRON.test(String(texto || ''));
}

module.exports = { leer, loTrae, PATRON, MAX_ITEMS, MAX_EXCLUSIONES, MODALIDAD };
