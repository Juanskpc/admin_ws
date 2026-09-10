/**
 * El código con el que un cliente consulta o cancela su cita.
 *
 * ## Por qué dejó de ser un UUID
 *
 * Era `ed59d79c-195e-4e5a-b5de-e08bae99c2ac`. Nadie dicta eso por teléfono, nadie lo apunta en
 * una servilleta y nadie lo teclea sin equivocarse. En la práctica el código solo servía si el
 * cliente conservaba el enlace, y quien lo perdía tenía que llamar al negocio.
 *
 * Ahora son **8 caracteres** del alfabeto Base32 de Crockford, que existe precisamente para
 * esto: no tiene `I`, `L`, `O` ni `U`, así que no hay forma de confundir el uno con la ele ni
 * el cero con la o, y al leerlo tampoco salen palabras desafortunadas. Se muestra partido en
 * dos mitades (`K3M7-9QXP`) porque cuatro y cuatro se retienen de un vistazo; los guiones son
 * decorado y al buscar se ignoran.
 *
 * ## Sigue siendo una credencial
 *
 * Quien tiene el código puede ver y cancelar la cita, así que tiene que ser **impredecible**:
 * se genera con `crypto.randomBytes`, nunca con un contador ni con la fecha. 32^8 ≈ 1,1 billones
 * de combinaciones; con las citas de un negocio —miles, no millones— acertar una a ciegas es
 * imposible en la práctica, y el rate limit del API remata el asunto.
 *
 * Los códigos viejos (UUID) siguen siendo válidos: `normalizar` los deja pasar tal cual para
 * que un enlace ya enviado a un cliente no se rompa.
 */
const crypto = require('crypto');

/** Base32 de Crockford: 10 dígitos + 22 letras, sin I, L, O ni U. */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LONGITUD = 8;

const RE_CODIGO = new RegExp(`^[${ALFABETO}]{${LONGITUD}}$`);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Un código nuevo, uniforme.
 *
 * `byte % 32` no sesga porque 256 es múltiplo exacto de 32: cada símbolo del alfabeto sale de
 * ocho valores de byte, ni uno más. Con un alfabeto de otro tamaño habría que descartar el
 * sobrante en vez de tomar el módulo.
 */
function generar() {
    const bytes = crypto.randomBytes(LONGITUD);
    let salida = '';
    for (const b of bytes) salida += ALFABETO[b % ALFABETO.length];
    return salida;
}

/**
 * Lo que escribe una persona → lo que hay en la base, o `null` si no puede serlo.
 *
 * Acepta minúsculas, espacios y guiones porque el cliente copia el código de una pantalla y lo
 * pega como puede. Aplica además las equivalencias de Crockford —`O`→`0`, `I`/`L`→`1`— que son
 * el motivo de usar ese alfabeto: quien lee «cero» y escribe «o» encuentra su cita igual.
 */
function normalizar(entrada) {
    const crudo = String(entrada ?? '').trim();
    if (!crudo) return null;
    if (RE_UUID.test(crudo)) return crudo.toLowerCase();   // código antiguo, intacto

    const limpio = crudo
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, '')
        .replace(/O/g, '0')
        .replace(/[IL]/g, '1');

    return RE_CODIGO.test(limpio) ? limpio : null;
}

/** Para mostrar: `K3M79QXP` → `K3M7-9QXP`. Un UUID se devuelve como está. */
function formatear(codigo) {
    const c = String(codigo ?? '');
    if (!RE_CODIGO.test(c)) return c;
    return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** ¿Tiene forma de código válido (nuevo o antiguo)? Lo usa la validación de las rutas. */
function esValido(entrada) {
    return normalizar(entrada) !== null;
}

module.exports = { ALFABETO, LONGITUD, generar, normalizar, formatear, esValido };
