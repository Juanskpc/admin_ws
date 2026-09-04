/**
 * Los datos fiscales de un negocio: leerlos, y saber si alcanzan para emitir.
 *
 * FE-1. Ver `docs/facturacion-electronica.md` §5 y `docs/adr/ADR-026-facturacion-electronica.md`.
 *
 * ## La regla que hace que esto no moleste al cliente pequeño
 *
 * Los campos fiscales son NULL por defecto y **no se validan al guardar**. Se validan al
 * **activar**, y la validación no responde «no» sino **qué falta**. Esa es toda la diferencia
 * entre un formulario que se puede llenar en dos ratos y uno que hay que llenar entero de una
 * sentada o no deja seguir.
 *
 * Un negocio en `modo_facturacion = 'NINGUNO'` —el defecto de todos— no pasa por aquí nunca.
 *
 * ## Lo que este módulo NO decide
 *
 * **Si el negocio está obligado a facturar.** Eso depende de su figura jurídica, sus ingresos y su
 * régimen, y lo dice su contador. Aquí solo se guarda lo que el cliente declaró, con quién lo
 * declaró y cuándo. Ver §4.2 del documento.
 */
'use strict';

const Models = require('../models/conection');
const { calcularDv, normalizarDocumento } = require('../helpers/nit');

const MODO = {
    NINGUNO: 'NINGUNO',
    POS: 'POS',
    COMPLETO: 'COMPLETO',
};

/**
 * ¿Está registrado el negocio ante la Cámara de Comercio y la DIAN?
 *
 * `NO_DECLARADO` y `SIN_REGISTRO` NO son lo mismo, y esa es toda la razón de que exista esta
 * columna: al primero hay que preguntarle, al segundo no hay que volver a molestarlo nunca.
 * Muchos clientes de EscalApp son negocios informales y ayudarlos a crecer es parte del producto;
 * tratarlos como una ficha incompleta sería tratarlos como un error.
 *
 * Lo que el cliente declare aquí es responsabilidad suya: nosotros no verificamos nada ante la
 * Cámara de Comercio ni ante la DIAN. Debe estar en los términos y condiciones.
 */
const REGISTRO = {
    NO_DECLARADO: 'NO_DECLARADO',
    SIN_REGISTRO: 'SIN_REGISTRO',
    REGISTRADO: 'REGISTRADO',
};

/** Código DIAN del NIT. Es el único tipo de documento que lleva dígito de verificación. */
const TIPO_DOC_NIT = '31';

/**
 * Lo mínimo para construir cualquier documento fiscal, sea tiquete POS o factura de venta.
 * El emisor va igual en los dos; lo que cambia es si hay que identificar al comprador.
 */
const CAMPOS_EMISOR = [
    ['tipo_persona', 'tipo de persona (jurídica o natural)'],
    ['tipo_documento', 'tipo de documento'],
    ['numero_documento', 'número de documento'],
    ['razon_social', 'razón social (la del RUT, no el nombre comercial)'],
    ['responsabilidades_fiscales', 'responsabilidades fiscales del RUT'],
    ['tributos', 'tributos que causa (IVA, INC o ninguno)'],
    ['direccion_fiscal', 'dirección fiscal'],
    ['municipio_dane', 'municipio (código DANE)'],
    ['departamento_dane', 'departamento'],
    ['correo_facturacion', 'correo de facturación'],
];

function estaVacio(valor) {
    if (valor === null || valor === undefined) return true;
    if (Array.isArray(valor)) return valor.length === 0;
    if (typeof valor === 'string') return valor.trim() === '';
    return false;
}

/**
 * Crea la ficha fiscal de un negocio si no la tiene. Idempotente.
 *
 * Se llama desde TODOS los caminos que crean un negocio, con la misma transacción, para que no
 * exista un negocio sin ficha. La alternativa —crearla la primera vez que alguien la pida— deja
 * el sistema en dos estados posibles para lo mismo, que es de donde salen los bugs raros.
 *
 * La fila nace en `NINGUNO` / `NO_DECLARADO`: no asume nada del negocio y no le pide nada.
 *
 * @param {number} idNegocio
 * @param {object} [opciones]
 * @param {import('sequelize').Transaction} [opciones.transaction]
 */
async function asegurarFicha(idNegocio, { transaction } = {}) {
    await Models.sequelize.query(
        `INSERT INTO general.gener_negocio_fiscal (id_negocio)
         VALUES (:idNegocio)
         ON CONFLICT (id_negocio) DO NOTHING;`,
        { replacements: { idNegocio }, transaction }
    );
}

/**
 * Lee la ficha fiscal de un negocio.
 *
 * @param {number} idNegocio
 * @param {object} [opciones]
 * @param {import('sequelize').Transaction} [opciones.transaction]
 * @returns {Promise<object|null>} La fila, o null si el negocio no existe.
 */
async function obtener(idNegocio, { transaction } = {}) {
    const filas = await Models.sequelize.query(
        `SELECT * FROM general.gener_negocio_fiscal WHERE id_negocio = :idNegocio;`,
        {
            replacements: { idNegocio },
            transaction,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return filas.length > 0 ? filas[0] : null;
}

/**
 * ¿Este negocio tiene los datos para emitir documentos fiscales, y si no, qué le falta?
 *
 * No consulta al proveedor ni a la DIAN: solo mira los datos maestros. La resolución de
 * numeración y las credenciales son FE-2 y se comprueban aparte.
 *
 * @param {number} idNegocio
 * @param {object} [opciones]
 * @param {import('sequelize').Transaction} [opciones.transaction]
 * @returns {Promise<{puede: boolean, modo: string, motivo: string|null, faltan: string[]}>}
 *   `faltan` trae descripciones en español, listas para enseñárselas a una persona.
 */
async function puedeEmitir(idNegocio, { transaction } = {}) {
    const ficha = await obtener(idNegocio, { transaction });

    if (!ficha) {
        return {
            puede: false,
            modo: MODO.NINGUNO,
            motivo: 'SIN_FICHA',
            faltan: ['la ficha fiscal del negocio (no existe la fila)'],
        };
    }

    // El negocio que no está registrado no puede emitir, y no es un formulario a medio llenar:
    // es una respuesta final. Se contesta antes que nada para que la interfaz sepa que aquí NO
    // hay que insistir. (La base impide además que llegue a tener modo distinto de NINGUNO.)
    if (ficha.estado_registro === REGISTRO.SIN_REGISTRO) {
        return { puede: false, modo: ficha.modo_facturacion, motivo: 'SIN_REGISTRO', faltan: [] };
    }

    // El caso normal, y el que no debe costar nada: el negocio no factura y no se le pide nada.
    if (ficha.modo_facturacion === MODO.NINGUNO) {
        return { puede: false, modo: MODO.NINGUNO, motivo: 'MODO_NINGUNO', faltan: [] };
    }

    const faltan = [];

    for (const [campo, descripcion] of CAMPOS_EMISOR) {
        if (estaVacio(ficha[campo])) faltan.push(descripcion);
    }

    // El DV solo aplica al NIT, y ahí sí es obligatorio: sin él la DIAN rechaza el documento.
    if (ficha.tipo_documento === TIPO_DOC_NIT) {
        if (estaVacio(ficha.dv)) {
            faltan.push('dígito de verificación del NIT');
        } else if (!estaVacio(ficha.numero_documento)) {
            const esperado = calcularDv(ficha.numero_documento);
            if (esperado !== null && Number(ficha.dv) !== esperado) {
                // No es «falta un dato»: es un dato que está mal, y se rechaza cada documento que
                // se envíe con él. Merece decirlo con el número esperado delante.
                faltan.push(
                    `el dígito de verificación no corresponde al NIT (debería ser ${esperado}) — compruébalo contra el RUT`
                );
            }
        }
    }

    // Una persona natural se identifica con el nombre partido, no solo con la razón social.
    if (ficha.tipo_persona === '2' && estaVacio(ficha.primer_apellido)) {
        faltan.push('primer apellido y nombres (la DIAN los pide separados)');
    }

    return {
        puede: faltan.length === 0,
        modo: ficha.modo_facturacion,
        motivo: faltan.length === 0 ? null : 'DATOS_INCOMPLETOS',
        faltan,
    };
}

/**
 * Los campos que el panel puede escribir. Lista blanca a propósito: `modo_facturacion`,
 * `estado_registro` y los `declarado_*` NO están aquí porque no son «datos», son una
 * **declaración** y van por `declarar()`, que deja rastro de quién y cuándo.
 */
const CAMPOS_ACTUALIZABLES = [
    'tipo_persona',
    'tipo_documento',
    'numero_documento',
    'dv',
    'razon_social',
    'nombre_comercial',
    'primer_apellido',
    'segundo_apellido',
    'primer_nombre',
    'otros_nombres',
    'responsabilidades_fiscales',
    'tributos',
    'responsable_iva',
    'responsable_inc',
    'regimen',
    'tipo_contribuyente',
    'actividad_ciiu',
    'matricula_mercantil',
    'direccion_fiscal',
    'municipio_dane',
    'departamento_dane',
    'codigo_postal',
    'correo_facturacion',
    'telefono_facturacion',
];

function errorDominio(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

/**
 * Guarda los datos fiscales de un negocio.
 *
 * No obliga a mandarlos todos: la ficha se puede llenar en varias tandas, que es justo lo que
 * permite pedírselos al cliente sin encerrarlo en un formulario de una sentada. Lo que sí hace
 * es **normalizar y comprobar** lo que llega:
 *
 * - El documento se guarda solo con dígitos: sin puntos, sin guiones, sin DV.
 * - Si es NIT y no mandan DV, **se calcula** (es una función del número, no una adivinanza).
 * - Si mandan un DV que no corresponde, **se rechaza con el correcto delante**, en vez de dejar
 *   que la DIAN rechace cada documento después.
 *
 * @param {number} idNegocio
 * @param {object} campos Subconjunto de CAMPOS_ACTUALIZABLES.
 * @param {object} [opciones]
 * @param {import('sequelize').Transaction} [opciones.transaction]
 * @returns {Promise<object>} La ficha ya actualizada.
 */
async function actualizar(idNegocio, campos, { transaction } = {}) {
    const ficha = await obtener(idNegocio, { transaction });
    if (!ficha) throw errorDominio('El negocio no tiene ficha fiscal', 'SIN_FICHA', 404);

    const cambios = {};
    for (const campo of CAMPOS_ACTUALIZABLES) {
        if (Object.prototype.hasOwnProperty.call(campos, campo)) cambios[campo] = campos[campo];
    }
    if (Object.keys(cambios).length === 0) {
        throw errorDominio('No se envió ningún campo válido', 'SIN_CAMBIOS', 400);
    }

    // El documento, limpio. Lo que llegue con puntos o guiones se guarda sin ellos.
    if (cambios.numero_documento !== undefined && cambios.numero_documento !== null) {
        const limpio = normalizarDocumento(cambios.numero_documento);
        if (!limpio) {
            throw errorDominio('El número de documento no es válido', 'DOCUMENTO_INVALIDO', 400);
        }
        cambios.numero_documento = limpio;
    }

    const tipoDoc = cambios.tipo_documento ?? ficha.tipo_documento;
    const numeroDoc = cambios.numero_documento ?? ficha.numero_documento;

    if (tipoDoc === TIPO_DOC_NIT && numeroDoc) {
        const esperado = calcularDv(numeroDoc);
        const dvLlega = cambios.dv;
        const dvVacio = dvLlega === undefined || dvLlega === null || `${dvLlega}`.trim() === '';

        if (dvVacio) {
            // Calcularlo no es inventar nada: el DV es una función del número. Lo que no se
            // adivina —y no se adivina— es dónde termina el NIT si llega todo pegado.
            if (esperado !== null) cambios.dv = String(esperado);
        } else if (esperado !== null && Number(dvLlega) !== esperado) {
            throw errorDominio(
                `El dígito de verificación no corresponde al NIT ${numeroDoc}: debería ser ${esperado}. Compruébalo contra el RUT.`,
                'DV_INVALIDO',
                400
            );
        }
    }

    if (cambios.departamento_dane) {
        const dep = await Models.sequelize.query(
            `SELECT 1 FROM general.gener_departamento WHERE codigo = :codigo LIMIT 1;`,
            {
                replacements: { codigo: cambios.departamento_dane },
                transaction,
                type: Models.sequelize.QueryTypes.SELECT,
            }
        );
        if (dep.length === 0) {
            throw errorDominio('El departamento no existe', 'DEPARTAMENTO_INVALIDO', 400);
        }
    }

    if (cambios.municipio_dane && !/^[0-9]{5}$/.test(String(cambios.municipio_dane))) {
        throw errorDominio(
            'El municipio va en código DANE de 5 dígitos (por ejemplo 05001), no por nombre',
            'MUNICIPIO_INVALIDO',
            400
        );
    }

    const asignaciones = Object.keys(cambios)
        .map((c) => `${c} = :${c}`)
        .join(', ');
    await Models.sequelize.query(
        `UPDATE general.gener_negocio_fiscal
            SET ${asignaciones}, actualizado_en = now()
          WHERE id_negocio = :idNegocio;`,
        { replacements: { ...cambios, idNegocio }, transaction }
    );

    return obtener(idNegocio, { transaction });
}

/**
 * Registra lo que el CLIENTE declara: si su negocio está registrado, si está obligado a facturar
 * y qué quiere emitir. Deja constancia de quién lo declaró y cuándo.
 *
 * Va aparte de `actualizar()` porque no es lo mismo corregir una dirección que declarar la
 * situación legal del negocio. Nosotros **no verificamos** nada ante la Cámara de Comercio ni
 * ante la DIAN, así que lo único que nos protege de una declaración falsa es que quede escrito
 * quién dijo qué y cuándo — y que los términos y condiciones lo digan.
 *
 * Se puede declarar el modo aunque falten datos: la respuesta trae la lista de lo que falta, que
 * es la forma de que el formulario se pueda llenar en dos ratos en vez de en una sentada.
 *
 * @param {number} idNegocio
 * @param {{estado_registro?: string, obligado_a_facturar?: boolean, modo_facturacion?: string}} declaracion
 * @param {{idUsuario?: number, transaction?: import('sequelize').Transaction}} [contexto]
 * @returns {Promise<{ficha: object, estado: object}>}
 */
async function declarar(idNegocio, declaracion, { idUsuario, transaction } = {}) {
    const ficha = await obtener(idNegocio, { transaction });
    if (!ficha) throw errorDominio('El negocio no tiene ficha fiscal', 'SIN_FICHA', 404);

    const estadoRegistro = declaracion.estado_registro ?? ficha.estado_registro;
    const modo = declaracion.modo_facturacion ?? ficha.modo_facturacion;

    if (!Object.values(REGISTRO).includes(estadoRegistro)) {
        throw errorDominio('Estado de registro inválido', 'ESTADO_REGISTRO_INVALIDO', 400);
    }
    if (!Object.values(MODO).includes(modo)) {
        throw errorDominio('Modo de facturación inválido', 'MODO_INVALIDO', 400);
    }

    // El mismo invariante que hay en la base, pero contestado con una frase que se le puede
    // enseñar a una persona, en vez de con una violación de restricción.
    if (modo !== MODO.NINGUNO && estadoRegistro !== REGISTRO.REGISTRADO) {
        throw errorDominio(
            'Un negocio que no está registrado ante la Cámara de Comercio y la DIAN no puede emitir documentos electrónicos. Primero hay que declararlo como registrado.',
            'REGISTRO_REQUERIDO',
            409
        );
    }

    await Models.sequelize.query(
        `UPDATE general.gener_negocio_fiscal
            SET estado_registro     = :estadoRegistro,
                modo_facturacion    = :modo,
                obligado_a_facturar = :obligado,
                declarado_por       = :idUsuario,
                declarado_en        = now(),
                actualizado_en      = now()
          WHERE id_negocio = :idNegocio;`,
        {
            replacements: {
                estadoRegistro,
                modo,
                obligado:
                    declaracion.obligado_a_facturar === undefined
                        ? ficha.obligado_a_facturar
                        : declaracion.obligado_a_facturar,
                idUsuario: idUsuario ?? null,
                idNegocio,
            },
            transaction,
        }
    );

    return {
        ficha: await obtener(idNegocio, { transaction }),
        estado: await puedeEmitir(idNegocio, { transaction }),
    };
}

/** Catálogos que necesita el formulario: departamentos e impuestos. */
async function catalogos({ transaction } = {}) {
    const [departamentos, impuestos] = await Promise.all([
        Models.sequelize.query(
            `SELECT codigo, nombre FROM general.gener_departamento ORDER BY nombre;`,
            { transaction, type: Models.sequelize.QueryTypes.SELECT }
        ),
        Models.sequelize.query(
            `SELECT id_impuesto, codigo, nombre, tarifa, descripcion
               FROM facturacion.fe_impuesto WHERE estado = 'A' ORDER BY codigo, tarifa;`,
            { transaction, type: Models.sequelize.QueryTypes.SELECT }
        ),
    ]);
    return { departamentos, impuestos };
}

module.exports = {
    MODO,
    REGISTRO,
    TIPO_DOC_NIT,
    CAMPOS_ACTUALIZABLES,
    asegurarFicha,
    obtener,
    puedeEmitir,
    actualizar,
    declarar,
    catalogos,
};
