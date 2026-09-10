'use strict';

/**
 * Los países que EscalApp sabe atender, con todo lo que depende del país en una sola fila.
 *
 * ## Por qué una tabla y no dos
 *
 * Antes de esto, «de qué país es el negocio» decidía **solo** cómo se normaliza un teléfono, y
 * esa lista vivía dentro de `telefono.js`. Al aparecer la moneda —lo que hace que un precio se
 * lea `$ 25.000` en Bogotá y `S/ 25.00` en Lima— la tentación era abrir una segunda lista de
 * países. Sería la quinta copia de la misma decisión, y ya sabemos cómo acaba eso: en
 * `CLAUDE.md` está documentado el caso de la misma elección escrita en cuatro sitios, donde
 * olvidar uno no daba error sino un negocio inservible.
 *
 * Aquí el país es una fila. **Añadir un país es añadir una fila**, y con ella llegan a la vez
 * su prefijo telefónico y su moneda. Si algún día un país necesita reglas que no caben en esta
 * forma (Argentina y su `9` intercalado para móviles, por ejemplo), se añade el campo, no una
 * lista paralela.
 *
 * ## Qué NO decide esta tabla
 *
 * La moneda es **un indicador, no una conversión**: cambiar el país de un negocio no toca ni un
 * precio guardado. Un servicio de 25.000 pasa a leerse en la moneda nueva con el mismo número.
 * Es lo correcto —nadie quiere que su catálogo se revalorice solo— pero hay que decirlo en la
 * pantalla, o el primero que lo pruebe pensará que se le rompieron los precios.
 *
 * ## Teléfonos
 *
 *   `cc`      prefijo internacional, sin el '+'
 *   `cc_alt`  otros prefijos internacionales que la gente escribe y hay que aceptar
 *   `largo`   dígitos del número nacional
 *   `movil`   con qué dígitos empieza un móvil; `null` = el país no los distingue
 *   `trunk`   prefijo nacional que se escribe de más y hay que quitar (null si no se usa)
 *
 * Solo móviles: el objetivo del número es poder escribirle por WhatsApp, así que un fijo es tan
 * inservible como un número mal escrito. Donde el país no distingue (México), se acepta
 * cualquier número del largo correcto: mentir con un `null` sería peor que aceptar de más.
 *
 * ## Monedas
 *
 *   `codigo`     ISO 4217, el que entiende `Intl.NumberFormat`
 *   `simbolo`    para textos donde no se formatea con `Intl`
 *   `decimales`  0 en peso colombiano y chileno (nadie cobra céntimos), 2 en el resto
 *   `locale`     separadores de miles y decimales del país
 */
const PAISES = {
    CO: {
        nombre: 'Colombia',
        telefono: { cc: '57', largo: 10, movil: ['3'], trunk: '0' },
        moneda: { codigo: 'COP', simbolo: '$', decimales: 0, locale: 'es-CO' },
    },
    CL: {
        nombre: 'Chile',
        telefono: { cc: '56', largo: 9, movil: ['9'], trunk: null },
        moneda: { codigo: 'CLP', simbolo: '$', decimales: 0, locale: 'es-CL' },
    },
    PE: {
        nombre: 'Perú',
        telefono: { cc: '51', largo: 9, movil: ['9'], trunk: null },
        moneda: { codigo: 'PEN', simbolo: 'S/', decimales: 2, locale: 'es-PE' },
    },
    EC: {
        nombre: 'Ecuador',
        telefono: { cc: '593', largo: 9, movil: ['9'], trunk: '0' },
        moneda: { codigo: 'USD', simbolo: '$', decimales: 2, locale: 'es-EC' },
    },
    MX: {
        // México no separa móvil de fijo por el primer dígito, y arrastra el `1` que WhatsApp
        // exigía tras el 52: se acepta como prefijo alternativo y se guarda sin él, que es la
        // forma E.164 correcta.
        nombre: 'México',
        telefono: { cc: '52', cc_alt: ['521'], largo: 10, movil: null, trunk: null },
        moneda: { codigo: 'MXN', simbolo: '$', decimales: 2, locale: 'es-MX' },
    },
};

const PAIS_POR_DEFECTO = 'CO';

/** Normaliza lo que llegue («co», ' Cl ', null) al código de la tabla, o `null` si no existe. */
function codigoPais(valor) {
    const codigo = String(valor || '').trim().toUpperCase();
    return PAISES[codigo] ? codigo : null;
}

/** La fila del país. Un país desconocido cae en Colombia, que es lo que había antes. */
function infoPais(valor) {
    return PAISES[codigoPais(valor) || PAIS_POR_DEFECTO];
}

/** Los códigos que la plataforma acepta. Es lo que validan los endpoints. */
function paisesSoportados() {
    return Object.keys(PAISES);
}

/** Lista para pintar un selector: código, nombre y la moneda que arrastra cada uno. */
function paisesParaSeleccion() {
    return paisesSoportados().map((codigo) => ({
        codigo,
        nombre: PAISES[codigo].nombre,
        moneda: { ...PAISES[codigo].moneda },
    }));
}

/** La moneda de un país. Copia, para que nadie mute el catálogo por descuido. */
function monedaDePais(valor) {
    return { ...infoPais(valor).moneda };
}

module.exports = {
    PAISES,
    PAIS_POR_DEFECTO,
    codigoPais,
    infoPais,
    paisesSoportados,
    paisesParaSeleccion,
    monedaDePais,
};
