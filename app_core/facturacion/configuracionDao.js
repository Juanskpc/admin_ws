'use strict';
/**
 * Cómo emite cada negocio: `facturacion.fe_configuracion` (credenciales, ambiente, impuestos por
 * defecto, estado) y `facturacion.fe_resolucion` (los rangos de numeración copiados del
 * proveedor). R4.1 de `docs/plan-fe-restaurante.md`.
 *
 * Las credenciales del proveedor son de cada negocio (D2) y se guardan cifradas. **Ninguna
 * función de aquí las devuelve en una fila**: `obtener` dice solo si las hay, y quien las
 * necesita para llamar al proveedor las pide con `obtenerCredenciales`.
 */
const Models = require('../models/conection');
const credencialCifrada = require('../helpers/credencialCifrada');
const datosFiscales = require('./datosFiscales');
const features = require('../../intelligence/core/features');

const sequelize = Models.sequelize;
const SELECT = sequelize.QueryTypes.SELECT;

const ESTADOS_QUE_EMITEN = ['EN_PRUEBAS', 'ACTIVO'];
const CAMPOS_EDITABLES = [
    'ambiente',
    'impuesto_defecto_codigo',
    'impuesto_defecto_tarifa',
    'impuesto_domicilio_codigo',
    'impuesto_domicilio_tarifa',
    'enviar_correo',
    'facturar_todo',
];
const CAMPOS_CREDENCIAL = ['client_id', 'client_secret', 'username', 'password'];

function fallo(mensaje, code, statusCode) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

async function leerFila(idNegocio, transaction) {
    const filas = await sequelize.query(
        `SELECT * FROM facturacion.fe_configuracion WHERE id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, transaction, type: SELECT }
    );
    return filas[0] || null;
}

function sinCredenciales(fila) {
    if (!fila) return null;
    const { credenciales_cifradas: cifradas, ...resto } = fila;
    return { ...resto, tiene_credenciales: Boolean(cifradas) };
}

async function obtener(idNegocio, { transaction } = {}) {
    return sinCredenciales(await leerFila(idNegocio, transaction));
}

async function obtenerCredenciales(idNegocio, { transaction } = {}) {
    const fila = await leerFila(idNegocio, transaction);
    if (!fila?.credenciales_cifradas) {
        throw fallo('Este negocio no tiene credenciales del proveedor de facturación.', 'FE_SIN_CREDENCIALES', 409);
    }
    return JSON.parse(credencialCifrada.descifrar(fila.credenciales_cifradas));
}

async function exigirImpuesto(codigo, tarifa, transaction) {
    const filas = await sequelize.query(
        `SELECT 1 FROM facturacion.fe_impuesto
          WHERE codigo = :codigo AND tarifa = :tarifa AND estado = 'A' LIMIT 1;`,
        { replacements: { codigo, tarifa }, transaction, type: SELECT }
    );
    if (filas.length === 0) {
        throw fallo(`El impuesto ${codigo} con tarifa ${tarifa}% no está en el catálogo.`, 'FE_IMPUESTO_INVALIDO', 422);
    }
}

/**
 * Crea o actualiza la configuración. Solo toca lo que viene en `campos`; `credenciales`
 * ({client_id, client_secret, username, password}) se cifra antes de guardarse.
 */
async function guardar(idNegocio, campos, { transaction } = {}) {
    const actual = await leerFila(idNegocio, transaction);
    const valores = {};
    for (const c of CAMPOS_EDITABLES) if (campos[c] !== undefined) valores[c] = campos[c];

    for (const cual of ['defecto', 'domicilio']) {
        const codigo = valores[`impuesto_${cual}_codigo`];
        const tarifa = valores[`impuesto_${cual}_tarifa`];
        if (codigo === undefined && tarifa === undefined) continue;
        await exigirImpuesto(
            codigo ?? actual?.[`impuesto_${cual}_codigo`] ?? 'ZZ',
            Number(tarifa ?? actual?.[`impuesto_${cual}_tarifa`] ?? 0),
            transaction
        );
    }

    if (campos.credenciales !== undefined) {
        const faltan = CAMPOS_CREDENCIAL.filter((c) => !campos.credenciales?.[c]);
        if (faltan.length) {
            throw fallo(`Faltan credenciales del proveedor: ${faltan.join(', ')}.`, 'FE_CREDENCIALES_INCOMPLETAS', 422);
        }
        const limpias = Object.fromEntries(CAMPOS_CREDENCIAL.map((c) => [c, String(campos.credenciales[c]).trim()]));
        valores.credenciales_cifradas = credencialCifrada.cifrar(JSON.stringify(limpias));
    }

    const columnas = Object.keys(valores);
    await sequelize.query(
        `INSERT INTO facturacion.fe_configuracion (id_negocio${columnas.map((c) => `, ${c}`).join('')})
         VALUES (:idNegocio${columnas.map((c) => `, :${c}`).join('')})
         ON CONFLICT (id_negocio) DO UPDATE
            SET ${columnas.map((c) => `${c} = EXCLUDED.${c}, `).join('')}actualizado_en = now();`,
        { replacements: { idNegocio, ...valores }, transaction }
    );
    return obtener(idNegocio, { transaction });
}

async function rangoEnUso(idNegocio, tipo = 'FV', { transaction } = {}) {
    const filas = await sequelize.query(
        `SELECT * FROM facturacion.fe_resolucion
          WHERE id_negocio = :idNegocio AND tipo_documento = :tipo AND en_uso;`,
        { replacements: { idNegocio, tipo }, transaction, type: SELECT }
    );
    return filas[0] || null;
}

async function listarRangos(idNegocio, { transaction } = {}) {
    return sequelize.query(
        `SELECT * FROM facturacion.fe_resolucion WHERE id_negocio = :idNegocio
          ORDER BY tipo_documento, prefijo, id_rango_proveedor;`,
        { replacements: { idNegocio }, transaction, type: SELECT }
    );
}

/**
 * Copia los rangos que devolvió el proveedor. No toca `en_uso`: cuál se usa lo elige una persona.
 * Los que no son factura ni nota crédito (documento soporte, nómina) se saltan.
 */
async function guardarRangos(idNegocio, rangos, { transaction } = {}) {
    for (const r of rangos) {
        if (!['FV', 'NC'].includes(r.tipoDocumento)) continue;
        await sequelize.query(
            `INSERT INTO facturacion.fe_resolucion
                 (id_negocio, id_rango_proveedor, tipo_documento, prefijo, numero_resolucion,
                  rango_desde, rango_hasta, consecutivo_actual, vigencia_desde, vigencia_hasta, vencida)
             VALUES (:idNegocio, :id, :tipoDocumento, :prefijo, :resolucion,
                     :desde, :hasta, :actual, :vigenciaDesde, :vigenciaHasta, :vencido)
             ON CONFLICT (id_negocio, id_rango_proveedor) DO UPDATE
                SET tipo_documento = EXCLUDED.tipo_documento, prefijo = EXCLUDED.prefijo,
                    numero_resolucion = EXCLUDED.numero_resolucion,
                    rango_desde = EXCLUDED.rango_desde, rango_hasta = EXCLUDED.rango_hasta,
                    consecutivo_actual = EXCLUDED.consecutivo_actual,
                    vigencia_desde = EXCLUDED.vigencia_desde, vigencia_hasta = EXCLUDED.vigencia_hasta,
                    vencida = EXCLUDED.vencida, sincronizado_en = now();`,
            {
                replacements: {
                    idNegocio,
                    id: r.id,
                    tipoDocumento: r.tipoDocumento,
                    prefijo: r.prefijo ?? null,
                    resolucion: r.resolucion ?? null,
                    desde: r.desde ?? null,
                    hasta: r.hasta ?? null,
                    actual: r.actual ?? null,
                    vigenciaDesde: r.vigenciaDesde ?? null,
                    vigenciaHasta: r.vigenciaHasta ?? null,
                    vencido: Boolean(r.vencido),
                },
                transaction,
            }
        );
    }
    return listarRangos(idNegocio, { transaction });
}

/** Marca un rango como el que se usa; los demás del mismo negocio y tipo dejan de estarlo. */
async function usarRango(idNegocio, idResolucion, { transaction } = {}) {
    const hacer = async (t) => {
        const filas = await sequelize.query(
            `SELECT * FROM facturacion.fe_resolucion
              WHERE id_negocio = :idNegocio AND id_resolucion = :idResolucion FOR UPDATE;`,
            { replacements: { idNegocio, idResolucion }, transaction: t, type: SELECT }
        );
        const rango = filas[0];
        if (!rango) throw fallo('Ese rango no es de este negocio.', 'FE_RANGO_NO_ENCONTRADO', 404);
        if (rango.vencida) throw fallo('Ese rango de numeración está vencido.', 'FE_RANGO_VENCIDO', 409);
        // Primero se sueltan todos: el índice único no admite dos en uso ni por un instante.
        await sequelize.query(
            `UPDATE facturacion.fe_resolucion SET en_uso = false
              WHERE id_negocio = :idNegocio AND tipo_documento = :tipo AND en_uso;`,
            { replacements: { idNegocio, tipo: rango.tipo_documento }, transaction: t }
        );
        await sequelize.query(
            `UPDATE facturacion.fe_resolucion SET en_uso = true WHERE id_resolucion = :idResolucion;`,
            { replacements: { idResolucion }, transaction: t }
        );
        return { ...rango, en_uso: true };
    };
    return transaction ? hacer(transaction) : sequelize.transaction(hacer);
}

/** Tras un documento aceptado, anota hasta dónde va el rango (para avisar cuando se acaba). */
async function anotarConsecutivo(idResolucion, numero, { transaction } = {}) {
    // El número trae el prefijo delante (SETP990024154): solo interesa la parte numérica.
    const digitos = /(\d+)$/.exec(String(numero || ''))?.[1];
    if (!digitos) return;
    await sequelize.query(
        `UPDATE facturacion.fe_resolucion
            SET consecutivo_actual = GREATEST(COALESCE(consecutivo_actual, 0), :n)
          WHERE id_resolucion = :idResolucion;`,
        { replacements: { idResolucion, n: Number(digitos) }, transaction }
    );
}

/**
 * Avisos sobre los rangos en uso, redactados para enseñárselos a una persona: el rango se acaba,
 * la resolución vence pronto o ya venció. Lista vacía = todo en orden.
 */
async function alertasDe(idNegocio, { transaction } = {}) {
    const rangos = await sequelize.query(
        `SELECT tipo_documento, prefijo, rango_desde, rango_hasta, consecutivo_actual, vencida,
                to_char(vigencia_hasta, 'DD/MM/YYYY') AS vence,
                (vigencia_hasta - CURRENT_DATE) AS dias
           FROM facturacion.fe_resolucion WHERE id_negocio = :idNegocio AND en_uso;`,
        { replacements: { idNegocio }, transaction, type: SELECT }
    );
    const alertas = [];
    for (const r of rangos) {
        const cual = r.tipo_documento === 'NC' ? 'de notas crédito' : 'de facturas';
        if (r.vencida || (r.dias !== null && Number(r.dias) < 0)) {
            alertas.push(`La resolución ${cual} (${r.prefijo ?? 'sin prefijo'}) está vencida.`);
        } else if (r.dias !== null && Number(r.dias) < 30) {
            alertas.push(`La resolución ${cual} vence el ${r.vence}.`);
        }
        const [desde, hasta, actual] = [r.rango_desde, r.rango_hasta, r.consecutivo_actual].map((x) =>
            x === null ? null : Number(x)
        );
        if (desde !== null && hasta !== null && actual !== null && hasta >= desde) {
            const quedan = hasta - actual;
            if (quedan / (hasta - desde + 1) < 0.1) {
                alertas.push(`Quedan ${Math.max(quedan, 0).toLocaleString('es-CO')} números en el rango ${cual}.`);
            }
        }
    }
    return alertas;
}

/** Los negocios que emiten hoy (para las tareas de fondo). */
async function negociosActivos() {
    const filas = await sequelize.query(
        `SELECT id_negocio FROM facturacion.fe_configuracion WHERE estado IN (:estados);`,
        { replacements: { estados: ESTADOS_QUE_EMITEN }, type: SELECT }
    );
    return filas.map((f) => f.id_negocio);
}

/**
 * Cambia el estado. Para empezar a emitir (EN_PRUEBAS o ACTIVO) tiene que estar todo: si falta
 * algo, el error dice qué.
 */
async function cambiarEstado(idNegocio, estado, idUsuario = null, { transaction } = {}) {
    if (ESTADOS_QUE_EMITEN.includes(estado)) {
        const faltan = [];
        const config = await obtener(idNegocio, { transaction });
        if (!config?.tiene_credenciales) faltan.push('las credenciales del proveedor');
        if (!(await rangoEnUso(idNegocio, 'FV', { transaction }))) faltan.push('un rango de numeración en uso');
        const fiscal = await datosFiscales.puedeEmitir(idNegocio, { transaction });
        if (!fiscal.puede) {
            faltan.push(...(fiscal.faltan.length ? fiscal.faltan : ['activar la facturación en los datos fiscales del negocio']));
        }
        if (faltan.length) throw fallo(`No se puede activar todavía. Falta: ${faltan.join('; ')}.`, 'FE_NO_LISTO', 409);
    }
    await sequelize.query(
        `INSERT INTO facturacion.fe_configuracion (id_negocio, estado, activado_en, activado_por)
         VALUES (:idNegocio, :estado, CASE WHEN :emite THEN now() END, CASE WHEN :emite THEN :idUsuario::integer END)
         ON CONFLICT (id_negocio) DO UPDATE
            SET estado = EXCLUDED.estado,
                activado_en = COALESCE(fe_configuracion.activado_en, EXCLUDED.activado_en),
                activado_por = COALESCE(fe_configuracion.activado_por, EXCLUDED.activado_por),
                actualizado_en = now();`,
        { replacements: { idNegocio, estado, idUsuario, emite: ESTADOS_QUE_EMITEN.includes(estado) }, transaction }
    );
    return obtener(idNegocio, { transaction });
}

/**
 * Los cuatro interruptores (D12). Devuelve el primero que falle.
 *
 * @returns {Promise<{facturar: boolean, motivo: string|null, config: object|null}>}
 */
async function debeFacturar(idNegocio, { transaction } = {}) {
    const config = await obtener(idNegocio, { transaction });
    const no = (motivo) => ({ facturar: false, motivo, config });
    if (!(await features.estaHabilitado(idNegocio, features.FEATURE.FACTURACION_ELECTRONICA))) return no('SIN_FEATURE');
    const ficha = await datosFiscales.obtener(idNegocio, { transaction });
    if (!ficha || ficha.modo_facturacion === datosFiscales.MODO.NINGUNO) return no('MODO_NINGUNO');
    if (!(await datosFiscales.puedeEmitir(idNegocio, { transaction })).puede) return no('DATOS_INCOMPLETOS');
    if (!config || !ESTADOS_QUE_EMITEN.includes(config.estado)) return no('NO_ACTIVO');
    return { facturar: true, motivo: null, config };
}

module.exports = {
    ESTADOS_QUE_EMITEN,
    obtener,
    obtenerCredenciales,
    guardar,
    cambiarEstado,
    rangoEnUso,
    listarRangos,
    guardarRangos,
    usarRango,
    anotarConsecutivo,
    alertasDe,
    negociosActivos,
    debeFacturar,
};
