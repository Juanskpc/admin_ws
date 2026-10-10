'use strict';

const Models = require('../models/conection');
const { POR_APLICATIVO, COMUNES } = require('./pasosDeClonado');

/**
 * Copia la configuración de una matriz a una sede recién creada.
 *
 * Lo declarativo está en `pasosDeClonado.js`; aquí solo está la mecánica. Se ejecuta DENTRO de la
 * transacción que crea la sede: si un paso falla, la sede no llega a existir. Una sede a medias
 * —con categorías pero sin productos— sería peor que ninguna, porque nadie sabría qué le falta.
 *
 * ## Fila a fila, no `INSERT ... SELECT`
 *
 * Un `INSERT ... SELECT` masivo sería más rápido, pero no dice qué id nuevo le tocó a cada fila
 * vieja, y eso es exactamente lo que hace falta para traducir las FK: el producto clonado tiene
 * que apuntar a la categoría clonada, no a la de la matriz. El orden de `RETURNING` sobre un
 * `INSERT ... SELECT` no está garantizado por Postgres, así que correlacionarlo por posición
 * sería apostar. Fila a fila el mapa viejo→nuevo es un hecho, no una suposición. El volumen lo
 * permite: una carta grande son ~80 productos y ~30 insumos, no 80.000 pedidos.
 *
 * ## Las columnas se leen de la base
 *
 * `information_schema` es la única fuente que sabe qué columnas tiene la tabla EN ESTA base. Una
 * lista escrita en el código se desincroniza —y de hecho ya lo está entre desarrollo y
 * producción—, y el `.rawAttributes` de Sequelize tampoco sirve: describe el modelo, que es otra
 * lista escrita a mano.
 */

/** Columnas que nunca viajan: las rellena el DEFAULT de la columna en la fila nueva. */
const FECHAS = ['fecha_creacion', 'fecha_actualizacion', 'creado_en', 'actualizado_en'];

/**
 * Qué columnas tiene de verdad esta tabla en esta base, cuáles son JSON y cuáles obligatorias.
 *
 * El tipo importa por una razón concreta: el driver devuelve una columna `jsonb` como objeto de
 * JavaScript, y el enlazador de Sequelize no sabe convertirlo —`Invalid value { borde: ... }`—.
 * Esas van al INSERT como texto con un `::jsonb` detrás, así que hay que saber cuáles son.
 *
 * La obligatoriedad decide qué hacer con una FK que apunta a algo que no se clonó: si la columna
 * admite NULL, se deja en NULL; si no, la fila entera se salta, porque no puede existir sin su
 * padre.
 */
async function columnasDe(tabla, transaction) {
    const [schema, nombre] = tabla.split('.');
    const filas = await Models.sequelize.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = :schema AND table_name = :nombre
          ORDER BY ordinal_position;`,
        {
            replacements: { schema, nombre },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        },
    );
    return {
        nombres: filas.map((f) => f.column_name),
        json: new Set(filas.filter((f) => f.data_type === 'jsonb' || f.data_type === 'json')
            .map((f) => f.column_name)),
        obligatorias: new Set(filas.filter((f) => f.is_nullable === 'NO').map((f) => f.column_name)),
    };
}

/**
 * Un paso: lee las filas del padre, inserta las de la sede y devuelve el mapa viejo→nuevo.
 *
 * El mapa queda vacío cuando el paso lleva `onConflict` y la fila ya existía. Eso solo pasa en
 * tablas de las que no cuelga nadie (el punto de caja, la config de reserva), así que no se
 * pierde ningún enlace por el camino.
 */
async function ejecutarPaso(paso, { idPadre, idSede, mapas, transaction }) {
    const {
        tabla, pk, donde = null, excluir = [], enlaces = {}, autoEnlaces = {},
        fijos = {}, onConflict = null, puente = null,
    } = paso;

    const { nombres: reales, json: columnasJson, obligatorias } = await columnasDe(tabla, transaction);
    if (reales.length === 0) {
        // La tabla no existe en esta base. Pasa con una migración de vertical sin aplicar, y
        // frenar el alta de la sede por eso sería desproporcionado.
        return { tabla, insertadas: 0, omitida: 'la tabla no existe' };
    }

    const noViajan = new Set([
        pk, 'id_negocio', ...FECHAS, ...excluir,
        ...Object.keys(enlaces), ...Object.keys(autoEnlaces), ...Object.keys(fijos),
    ]);
    const copiar = reales.filter((c) => !noViajan.has(c));
    // Solo se traducen las FK que la tabla tiene de verdad: un `enlaces` que nombre una columna
    // que esta base no tiene se ignora en vez de romper la consulta.
    const fkEnlaces = Object.keys(enlaces).filter((c) => reales.includes(c));
    const fkAuto = Object.keys(autoEnlaces).filter((c) => reales.includes(c));
    const fijosReales = Object.keys(fijos).filter((c) => reales.includes(c));

    // ── Las filas del padre ───────────────────────────────────────────────────
    const aLeer = [pk, ...copiar, ...fkEnlaces, ...fkAuto];
    const condiciones = [];
    const repl = {};

    if (puente) {
        // Tabla sin id_negocio: sus filas se eligen por las que ya se clonaron.
        const mapa = mapas.get(puente.mapa);
        const ids = mapa ? [...mapa.keys()] : [];
        if (ids.length === 0) return { tabla, insertadas: 0 };
        condiciones.push(`${puente.columna} IN (:idsPuente)`);
        repl.idsPuente = ids;
    } else {
        condiciones.push('id_negocio = :idPadre');
        repl.idPadre = idPadre;
    }
    if (donde) condiciones.push(`(${donde})`);

    const origen = await Models.sequelize.query(
        `SELECT ${aLeer.map((c) => `"${c}"`).join(', ')}
           FROM ${tabla}
          WHERE ${condiciones.join(' AND ')}
          ORDER BY ${pk};`,
        { replacements: repl, type: Models.sequelize.QueryTypes.SELECT, transaction },
    );
    if (origen.length === 0) return { tabla, insertadas: 0 };

    // ── Las filas de la sede ──────────────────────────────────────────────────
    // `id_negocio` se escribe salvo cuando ES la PK (reserva_config), donde ya va como la llave.
    const escribeNegocio = reales.includes('id_negocio') && pk !== 'id_negocio';
    const columnasInsert = [
        ...(escribeNegocio ? ['id_negocio'] : []),
        ...(pk === 'id_negocio' ? ['id_negocio'] : []),
        ...copiar, ...fkEnlaces, ...fkAuto, ...fijosReales,
    ];

    const mapa = new Map();
    let insertadas = 0;
    let saltadas = 0;

    for (const fila of origen) {
        const valores = {};
        let saltar = false;
        if (escribeNegocio || pk === 'id_negocio') valores.id_negocio = idSede;
        for (const c of copiar) valores[c] = fila[c];
        for (const c of fkEnlaces) {
            const original = fila[c];
            if (original === null || original === undefined) { valores[c] = null; continue; }

            const mapaDestino = mapas.get(enlaces[c]);
            // Que el mapa no exista significa que ese paso no llegó a correr: es un error de
            // ORDEN en `pasosDeClonado.js`, y hay que verlo, no taparlo.
            if (mapaDestino === undefined) {
                const err = new Error(
                    `No se pudo clonar ${tabla}: ${c} apunta a ${enlaces[c]}, que no se ha clonado `
                    + `todavía. Revisa el orden de los pasos en pasosDeClonado.js.`,
                );
                err.code = 'SEDE_CLON_ORDEN_PASOS';
                err.statusCode = 500;
                throw err;
            }

            const traducido = mapaDestino.get(Number(original));
            if (traducido === undefined) {
                // El mapa existe pero esta fila concreta no está: a lo que apunta quedó FUERA
                // del clonado. Pasa de verdad —la matriz tiene una variante activa de un
                // servicio que dio de baja—, y no es un error del código. Lo que no se puede es
                // dejar la FK apuntando a la fila de la matriz: eso sería una fuga entre
                // negocios, el peor incidente posible aquí (ADR-002). Si la columna admite
                // NULL se queda en NULL; si no, la fila no puede existir sin su padre y se
                // salta entera.
                if (obligatorias.has(c)) { saltar = true; break; }
                valores[c] = null;
                continue;
            }
            valores[c] = traducido;
        }
        if (saltar) { saltadas += 1; continue; }
        // Las FK a la propia tabla entran en NULL: la segunda pasada las corrige.
        for (const c of fkAuto) valores[c] = null;
        for (const c of fijosReales) valores[c] = fijos[c];

        // Una columna JSON se enlaza como texto y se convierte en SQL: el driver la devolvió
        // como objeto y el enlazador no sabe qué hacer con eso.
        for (const c of columnasJson) {
            if (!(c in valores)) continue;
            valores[c] = valores[c] === null || valores[c] === undefined
                ? null : JSON.stringify(valores[c]);
        }

        const [res] = await Models.sequelize.query(
            `INSERT INTO ${tabla} (${columnasInsert.map((c) => `"${c}"`).join(', ')})
             VALUES (${columnasInsert.map((c) => (columnasJson.has(c) ? `:${c}::jsonb` : `:${c}`)).join(', ')})
             ${onConflict ? `ON CONFLICT ${onConflict}` : ''}
             RETURNING ${pk};`,
            { replacements: valores, type: Models.sequelize.QueryTypes.INSERT, transaction },
        );

        const devuelto = Array.isArray(res) ? res[0] : res;
        // Con ON CONFLICT DO NOTHING no hay fila devuelta: la que había se respeta.
        if (devuelto && devuelto[pk] !== undefined) {
            mapa.set(Number(fila[pk]), Number(devuelto[pk]));
            insertadas += 1;
        }
    }

    mapas.set(tabla, mapa);
    if (saltadas > 0) {
        // Visible en el log y en el evento de auditoría del alta: es la respuesta a «¿por qué a
        // la sede le faltan dos variantes?».
        console.warn(`[sede] ${tabla}: ${saltadas} fila(s) no clonada(s) porque lo que referencian `
            + 'quedó fuera (la matriz lo tiene inactivo).');
    }

    // ── Segunda pasada: las FK a la propia tabla ──────────────────────────────
    for (const c of fkAuto) {
        for (const fila of origen) {
            const original = fila[c];
            if (original === null || original === undefined) continue;
            const nuevoPadre = mapas.get(autoEnlaces[c])?.get(Number(original));
            const nuevaFila = mapa.get(Number(fila[pk]));
            // Si lo apuntado no se clonó (p. ej. el empaque estaba inactivo), se deja en NULL:
            // es lo mismo que tiene un producto al que nunca se le puso empaque.
            if (nuevoPadre === undefined || nuevaFila === undefined) continue;
            await Models.sequelize.query(
                `UPDATE ${tabla} SET "${c}" = :nuevoPadre WHERE ${pk} = :nuevaFila;`,
                { replacements: { nuevoPadre, nuevaFila }, transaction },
            );
        }
    }

    return { tabla, insertadas, ...(saltadas > 0 ? { saltadas } : {}) };
}

/**
 * Clona la configuración de `idPadre` en `idSede`.
 *
 * @param {Object}  opciones
 * @param {number}  opciones.idPadre     La matriz de la que se copia.
 * @param {number}  opciones.idSede      La sede recién creada (debe estar vacía).
 * @param {string}  opciones.aplicativo  Nombre del módulo ('RESTAURANTE', 'RESERVA'). Por NOMBRE,
 *                                       nunca por id: los de `gener_tipo_negocio` difieren
 *                                       entre desarrollo y producción.
 * @param {Object}  opciones.transaction La transacción que crea la sede.
 * @returns {Promise<Array<{tabla:string, insertadas:number}>>} Resumen por tabla.
 */
async function clonarConfiguracion({ idPadre, idSede, aplicativo, transaction }) {
    if (!idPadre || !idSede) throw new Error('clonarConfiguracion: faltan idPadre o idSede');
    if (Number(idPadre) === Number(idSede)) throw new Error('clonarConfiguracion: padre y sede son el mismo negocio');

    const clave = String(aplicativo || '').trim().toUpperCase();
    const pasos = [...COMUNES, ...(POR_APLICATIVO[clave] || [])];

    const mapas = new Map();
    const resumen = [];
    for (const paso of pasos) {
        resumen.push(await ejecutarPaso(paso, { idPadre, idSede, mapas, transaction }));
    }
    return resumen;
}

/** ¿Hay pasos escritos para este aplicativo? Lo usa la consola para avisar antes de crear. */
function aplicativoSoportado(aplicativo) {
    return Object.hasOwn(POR_APLICATIVO, String(aplicativo || '').trim().toUpperCase());
}

module.exports = { clonarConfiguracion, aplicativoSoportado };
