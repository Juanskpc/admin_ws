'use strict';
const Models = require('../../app_core/models/conection');
const datosFiscales = require('../../app_core/facturacion/datosFiscales');
const configuracionFe = require('../../app_core/facturacion/configuracionDao');
const features = require('../../intelligence/core/features');
const { resolveAccesoNegocio } = require('./configuracionService');

/**
 * tiqueteDisenoService — cómo se ve el tiquete impreso de cada negocio.
 *
 * Dos diseños por negocio: el **común** (el de siempre, que también sirve de comanda) y el de
 * **factura electrónica** (su representación gráfica). Mismo esquema que `cartaDisenoService`:
 *
 * - **El backend valida, el frontend dibuja.** Aquí solo se conocen los nombres válidos de cada
 *   opción; los valores por defecto y el HTML viven en `shared/tiquete-diseno/tiquete-diseno.ts`,
 *   que es quien imprime.
 * - **El tiquete por defecto no es una fila.** Sin diseño guardado se imprime el de siempre.
 *
 * Lo que la DIAN exige en la representación gráfica (NIT y razón social del emisor, número con
 * prefijo, resolución, CUFE, QR, comprador, impuestos) **no es una opción**: no está en
 * `CAMPOS` y el frontend lo imprime siempre. Así ningún negocio puede quitarlo por error.
 */

const TIPOS = ['comun', 'electronica'];

/** Lo que el negocio puede mostrar u ocultar. Mismo nombre en los dos tipos. */
const CAMPOS = [
    'logo',
    'nit',
    'direccion',
    'telefono',
    'fecha',
    'numero_pedido',
    'atiende',
    'cajero',
    'tipo_pedido',
    'mesa',
    'cliente_domicilio',
    'notas',
    'precio_unitario',
    'desglose',
    'forma_pago',
];

const OPCIONES = {
    papel: ['58', '80'],
    letra: ['pequena', 'normal', 'grande'],
    separador: ['punteado', 'continuo'],
};

/** Textos libres: encabezado y pie. */
const TEXTOS = { encabezado: 160, pie: 160 };

function error(mensaje, code, statusCode = 422) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

function esTablaInexistente(err) {
    const code = err?.parent?.code || err?.original?.code;
    return code === '42P01';
}

/**
 * Deja solo lo conocido y con el tipo correcto. Lo desconocido se rechaza en vez de ignorarse:
 * si el frontend manda una opción que el servidor no conoce, guardarla a medias es peor que
 * avisar.
 */
function normalizarTipo(valor, tipo) {
    if (valor == null) return {};
    if (typeof valor !== 'object' || Array.isArray(valor)) {
        throw error(`El diseño «${tipo}» no es válido.`, 'DISENO_INVALIDO');
    }

    const limpio = {};
    for (const [clave, dato] of Object.entries(valor)) {
        if (clave === 'campos') {
            if (dato == null) continue;
            if (typeof dato !== 'object' || Array.isArray(dato)) {
                throw error('Los campos del tiquete no son válidos.', 'CAMPOS_INVALIDOS');
            }
            const campos = {};
            for (const [campo, visible] of Object.entries(dato)) {
                if (!CAMPOS.includes(campo)) {
                    throw error(`El campo «${campo}» no existe.`, 'CAMPO_DESCONOCIDO');
                }
                if (typeof visible !== 'boolean') {
                    throw error(`El campo «${campo}» debe ser sí o no.`, 'CAMPOS_INVALIDOS');
                }
                campos[campo] = visible;
            }
            limpio.campos = campos;
        } else if (OPCIONES[clave]) {
            if (!OPCIONES[clave].includes(dato)) {
                throw error(`El valor de «${clave}» no es válido.`, 'OPCION_INVALIDA');
            }
            limpio[clave] = dato;
        } else if (TEXTOS[clave]) {
            if (dato == null) continue;
            if (typeof dato !== 'string') {
                throw error(`«${clave}» debe ser texto.`, 'TEXTO_INVALIDO');
            }
            const texto = dato.trim();
            if (texto.length > TEXTOS[clave]) {
                throw error(
                    `«${clave}» admite hasta ${TEXTOS[clave]} caracteres.`,
                    'TEXTO_MUY_LARGO',
                );
            }
            limpio[clave] = texto;
        } else {
            throw error(`La opción «${clave}» no existe.`, 'OPCION_DESCONOCIDA');
        }
    }
    return limpio;
}

async function leerFila(idNegocio) {
    try {
        return await Models.TiqueteDiseno.findOne({ where: { id_negocio: idNegocio } });
    } catch (err) {
        // Sin la migración se imprime el tiquete por defecto.
        if (esTablaInexistente(err)) return null;
        throw err;
    }
}

/** Datos de la ficha fiscal que salen impresos. Sin migración de FE-1, no hay ficha. */
async function leerFiscal(idNegocio) {
    try {
        const ficha = await datosFiscales.obtener(idNegocio);
        if (!ficha) return null;
        return {
            razon_social: ficha.razon_social || null,
            nombre_comercial: ficha.nombre_comercial || null,
            tipo_documento: ficha.tipo_documento || null,
            numero_documento: ficha.numero_documento || null,
            dv: ficha.dv ?? null,
            direccion_fiscal: ficha.direccion_fiscal || null,
            regimen: ficha.regimen || null,
            responsable_iva: ficha.responsable_iva ?? null,
            responsable_inc: ficha.responsable_inc ?? null,
            correo_facturacion: ficha.correo_facturacion || null,
            telefono_facturacion: ficha.telefono_facturacion || null,
        };
    } catch (err) {
        if (esTablaInexistente(err)) return null;
        throw err;
    }
}

async function leerResolucion(idNegocio) {
    try {
        const rango = await configuracionFe.rangoEnUso(idNegocio, 'FV');
        if (!rango) return null;
        return {
            prefijo: rango.prefijo || null,
            numero_resolucion: rango.numero_resolucion || null,
            rango_desde: rango.rango_desde != null ? Number(rango.rango_desde) : null,
            rango_hasta: rango.rango_hasta != null ? Number(rango.rango_hasta) : null,
            vigencia_desde: rango.vigencia_desde || null,
            vigencia_hasta: rango.vigencia_hasta || null,
        };
    } catch (err) {
        if (esTablaInexistente(err)) return null;
        throw err;
    }
}

async function facturacionHabilitada(idNegocio) {
    try {
        return await features.estaHabilitado(idNegocio, features.FEATURE.FACTURACION_ELECTRONICA);
    } catch {
        return false;
    }
}

/** Todo lo que necesita la pestaña Tiquete: el diseño y los datos reales para la vista previa. */
async function getDisenoAdmin(idUsuario, idNegocio) {
    const acceso = await resolveAccesoNegocio(idUsuario, idNegocio);

    const [fila, negocio, fiscal, resolucion, habilitada] = await Promise.all([
        leerFila(acceso.idNegocio),
        Models.GenerNegocio.findOne({
            where: { id_negocio: acceso.idNegocio, estado: 'A' },
            attributes: ['id_negocio', 'nombre', 'nit', 'telefono', 'direccion', 'logo_url'],
        }),
        leerFiscal(acceso.idNegocio),
        leerResolucion(acceso.idNegocio),
        facturacionHabilitada(acceso.idNegocio),
    ]);

    if (!negocio) throw error('Negocio no encontrado.', 'NEGOCIO_NO_ENCONTRADO', 404);

    return {
        diseno: {
            comun: { ...(fila?.comun || {}) },
            electronica: { ...(fila?.electronica || {}) },
            actualizado_en: fila?.actualizado_en ?? null,
        },
        personalizado: Boolean(fila),
        negocio: {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            nit: negocio.nit || null,
            telefono: negocio.telefono || null,
            direccion: negocio.direccion || null,
            logo_url: negocio.logo_url || null,
        },
        fiscal,
        resolucion,
        facturacion_habilitada: habilitada,
        can_edit: acceso.canEdit,
    };
}

/** Guarda los dos diseños de una vez. Solo un administrador del negocio. */
async function guardarDiseno(idUsuario, { id_negocio: idNegocio, comun, electronica }) {
    const acceso = await resolveAccesoNegocio(idUsuario, idNegocio);
    if (!acceso.canEdit) {
        throw error(
            'Solo un administrador del negocio puede cambiar el tiquete.',
            'SIN_PERMISO_EDITAR',
            403,
        );
    }

    const datos = {
        comun: normalizarTipo(comun, 'comun'),
        electronica: normalizarTipo(electronica, 'electronica'),
        actualizado_en: new Date(),
        id_usuario: idUsuario,
    };

    await Models.sequelize.transaction(async (t) => {
        const fila = await Models.TiqueteDiseno.findOne({
            where: { id_negocio: acceso.idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (fila) {
            await fila.update(datos, { transaction: t });
        } else {
            await Models.TiqueteDiseno.create(
                { id_negocio: acceso.idNegocio, ...datos },
                { transaction: t },
            );
        }
    });

    return getDisenoAdmin(idUsuario, acceso.idNegocio);
}

module.exports = {
    TIPOS,
    CAMPOS,
    OPCIONES,
    TEXTOS,
    normalizarTipo,
    getDisenoAdmin,
    guardarDiseno,
};
