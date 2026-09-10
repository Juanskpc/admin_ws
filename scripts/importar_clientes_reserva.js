/**
 * importar_clientes_reserva.js — carga la cartera de clientes de un negocio desde un Excel.
 *
 *   node scripts/importar_clientes_reserva.js <archivo.xlsx> --negocio=<id>
 *   node scripts/importar_clientes_reserva.js <archivo.xlsx> --negocio=<id> --aplicar
 *   node scripts/importar_clientes_reserva.js <archivo.xlsx> --negocio=<id> --sql=carga.sql
 *
 * Sin `--aplicar` ni `--sql` solo informa: no escribe una sola fila.
 *
 * ## Dónde aterrizan los clientes
 *
 * En `platform.persona_negocio`, que es la cartera de verdad (ADR-006, ADR-025) y la que ya lee
 * `/clientes` del módulo de reserva. No hay tabla propia de clientes ni la va a haber: la llave
 * es `(id_negocio, telefono_e164)` y **jamás cruza inquilinos**.
 *
 * El país sale del negocio (`gener_negocio.pais`), no de un parámetro, para que la normalización
 * sea exactamente la misma que usará la app cuando ese mismo cliente vuelva a aparecer al agendar
 * una cita. Si difirieran, el cliente importado y el de la cita serían dos fichas distintas.
 *
 * ## Los números comodín, que es lo que hace este script menos trivial de lo que parece
 *
 * En una exportación real de agenda, un puñado de números concentra cientos de personas: es el
 * número del propio local (o una variación mal tecleada de él) que el mostrador apunta cuando no
 * tiene el del cliente. En el primer caso medido, **14 números cargaban con el 41% de las filas**,
 * y uno solo tenía 287 personas distintas colgando.
 *
 * Deduplicar por teléfono a ciegas los fundiría a todos en un único cliente con el nombre del
 * último. Importarlos tal cual es peor: la clave es única, así que igualmente se fundirían, pero
 * además ese número recibiría los recordatorios de WhatsApp de 287 personas.
 *
 * Por eso se detectan y, por defecto, **se omiten**: un teléfono que no es de quien dice ser no
 * es un dato, es una equivocación pendiente de ocurrir. `--comodines=incluir` los mete igualmente
 * (uno por número, con el nombre más reciente) si se prefiere no perder el registro.
 *
 * ## Consentimiento
 *
 * `consentimiento_mensajeria` se queda en su valor por defecto (falso). Importar una lista no es
 * un consentimiento: que el negocio tenga el número no significa que el cliente haya aceptado que
 * le escribamos. Concederlo es una decisión del inquilino, y se toma en la app.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const Models = require('../app_core/models/conection');
const { normalizarE164 } = require('../app_core/helpers/telefono');
const { paisDeNegocio } = require('../app_core/helpers/paisNegocio');

const sequelize = Models.sequelize;

/** A partir de cuántas personas distintas un mismo número deja de ser creíble. */
const UMBRAL_COMODIN = 4;

// ────────────────────────────── argumentos ──────────────────────────────

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const opt = (nombre, porDefecto = null) => {
    const encontrado = args.find((a) => a.startsWith(`--${nombre}=`));
    return encontrado ? encontrado.slice(nombre.length + 3) : porDefecto;
};
const idNegocio = Number(opt('negocio'));
const aplicar = args.includes('--aplicar');
const salidaSql = opt('sql');
const comodines = opt('comodines', 'omitir');

function uso(mensaje) {
    console.error(`\n${mensaje}\n`);
    console.error('Uso: node scripts/importar_clientes_reserva.js <archivo.xlsx> --negocio=<id> [opciones]');
    console.error('  --aplicar              escribe en la base (sin esto, solo informa)');
    console.error('  --sql=<ruta>           genera un archivo SQL en vez de escribir');
    console.error('  --comodines=omitir     qué hacer con los números que tienen muchas personas');
    console.error('                         detrás: omitir (por defecto) o incluir');
    process.exit(1);
}

if (!archivo) uso('Falta el archivo .xlsx.');
if (!fs.existsSync(archivo)) uso(`No existe el archivo: ${archivo}`);
if (!Number.isInteger(idNegocio) || idNegocio < 1) uso('Falta --negocio=<id>.');
if (!['omitir', 'incluir'].includes(comodines)) uso('--comodines solo acepta "omitir" o "incluir".');

// ────────────────────────────── lectura ──────────────────────────────

const celda = (c) => {
    let v = c.value;
    if (v && typeof v === 'object') v = v.text ?? v.result ?? v;
    return v === null || v === undefined ? '' : String(v).trim();
};

/** Para comparar nombres sin que "José" y "jose" cuenten como dos personas. */
const claveNombre = (s) => s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Localiza las columnas por su encabezado en vez de por posición: la exportación de la agenda
 * del cliente no tiene por qué mantener el orden entre versiones.
 */
function mapearColumnas(hoja) {
    const encabezados = {};
    const fila = hoja.getRow(1);
    for (let c = 1; c <= hoja.columnCount; c += 1) {
        encabezados[claveNombre(celda(fila.getCell(c)))] = c;
    }
    const buscar = (...candidatos) => {
        for (const cand of candidatos) {
            const k = claveNombre(cand);
            const exacto = encabezados[k];
            if (exacto) return exacto;
            const parcial = Object.keys(encabezados).find((e) => e.includes(k));
            if (parcial) return encabezados[parcial];
        }
        return null;
    };
    return {
        nombre:   buscar('Nombre'),
        apellido: buscar('Apellido'),
        telefono: buscar('Numero de telefono', 'Telefono', 'Celular'),
        creado:   buscar('Fecha de creacion', 'Fecha'),
    };
}

async function leerFilas() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(archivo);
    const hoja = wb.worksheets[0];
    const col = mapearColumnas(hoja);
    if (!col.telefono) throw new Error('El Excel no tiene una columna de teléfono reconocible.');

    const filas = [];
    for (let r = 2; r <= hoja.rowCount; r += 1) {
        const fila = hoja.getRow(r);
        const nombre = [col.nombre && celda(fila.getCell(col.nombre)), col.apellido && celda(fila.getCell(col.apellido))]
            .filter(Boolean).join(' ').trim();
        const telefono = celda(fila.getCell(col.telefono));
        if (!nombre && !telefono) continue;
        filas.push({
            fila: r,
            nombre,
            telefono,
            creado: col.creado ? celda(fila.getCell(col.creado)) : '',
        });
    }
    return { filas, col, hoja: hoja.name };
}

// ────────────────────────────── agrupación ──────────────────────────────

function agrupar(filas, pais) {
    const porTelefono = new Map();
    const descartadas = [];

    for (const f of filas) {
        const e164 = normalizarE164(f.telefono, pais);
        if (!e164) { descartadas.push(f); continue; }
        if (!porTelefono.has(e164)) porTelefono.set(e164, []);
        porTelefono.get(e164).push(f);
    }

    const grupos = [...porTelefono.entries()].map(([telefono, ocurrencias]) => {
        const personas = new Set(ocurrencias.map((o) => claveNombre(o.nombre)).filter(Boolean));
        // El nombre bueno es el de la aparición más reciente: la misma regla que usó el backfill
        // histórico de `platform`, para que las dos fuentes no se contradigan.
        const masReciente = [...ocurrencias].sort(
            (a, b) => String(b.creado).localeCompare(String(a.creado)),
        )[0];
        return {
            telefono,
            nombre: masReciente.nombre || null,
            filas: ocurrencias.length,
            personas: personas.size,
            comodin: personas.size >= UMBRAL_COMODIN,
        };
    });

    return { grupos, descartadas };
}

// ────────────────────────────── escritura ──────────────────────────────

const SQL_UPSERT = `INSERT INTO platform.persona_negocio (id_negocio, telefono_e164, nombre_mostrado)
VALUES (:idNegocio, :telefono, :nombre)
ON CONFLICT (id_negocio, telefono_e164) WHERE telefono_e164 IS NOT NULL
DO UPDATE SET
    nombre_mostrado = COALESCE(EXCLUDED.nombre_mostrado, platform.persona_negocio.nombre_mostrado),
    actualizado_en  = now();`;

async function escribirEnBase(aImportar) {
    const t = await sequelize.transaction();
    try {
        for (const g of aImportar) {
            await sequelize.query(SQL_UPSERT, {
                replacements: { idNegocio, telefono: g.telefono, nombre: g.nombre },
                transaction: t,
            });
        }
        await t.commit();
        return aImportar.length;
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

/** Comillas simples duplicadas: `standard_conforming_strings` está activo, no hay más que escapar. */
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function generarSql(aImportar, resumen) {
    const lineas = [
        '-- Carga de cartera de clientes en platform.persona_negocio',
        `-- Origen : ${path.basename(archivo)}`,
        `-- Negocio: ${idNegocio}`,
        `-- Generado: ${new Date().toISOString()}`,
        `-- ${resumen}`,
        '--',
        '-- Idempotente: re-ejecutarlo no duplica clientes, solo refresca el nombre.',
        '-- consentimiento_mensajeria se deja en su valor por defecto a propósito: importar una',
        '-- lista no es un consentimiento para escribirle a nadie.',
        '',
        'BEGIN;',
        '',
    ];
    for (const g of aImportar) {
        lineas.push(
            'INSERT INTO platform.persona_negocio (id_negocio, telefono_e164, nombre_mostrado)',
            `VALUES (${idNegocio}, ${lit(g.telefono)}, ${lit(g.nombre)})`,
            'ON CONFLICT (id_negocio, telefono_e164) WHERE telefono_e164 IS NOT NULL',
            'DO UPDATE SET nombre_mostrado = COALESCE(EXCLUDED.nombre_mostrado, platform.persona_negocio.nombre_mostrado),',
            '              actualizado_en  = now();',
        );
    }
    lineas.push('', 'COMMIT;', '');
    fs.writeFileSync(salidaSql, lineas.join('\n'), 'utf8');
}

// ────────────────────────────── principal ──────────────────────────────

async function main() {
    const [negocio] = await sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.pais, tn.nombre AS tipo
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
          WHERE n.id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    if (!negocio) throw new Error(`No existe el negocio ${idNegocio}.`);

    const pais = await paisDeNegocio(idNegocio);
    console.log(`\nNegocio ${negocio.id_negocio}: "${negocio.nombre}" (${negocio.tipo ?? '?'}) — país ${pais}`);
    console.log(`Archivo : ${path.basename(archivo)}`);

    const { filas } = await leerFilas();
    const { grupos, descartadas } = agrupar(filas, pais);

    const comodinesDetectados = grupos.filter((g) => g.comodin);
    const limpios = grupos.filter((g) => !g.comodin);
    const aImportar = comodines === 'incluir' ? grupos : limpios;

    console.log('\n── Lo que dice el archivo ─────────────────────────────');
    console.log(`  filas leídas                    ${filas.length}`);
    console.log(`  teléfonos no utilizables        ${descartadas.length}`);
    console.log(`  teléfonos distintos válidos     ${grupos.length}`);
    console.log(`  → repetidos que se funden       ${filas.length - descartadas.length - grupos.length}`);

    if (descartadas.length > 0) {
        console.log(`\n  No utilizables (no son móviles de ${pais}):`);
        descartadas.slice(0, 15).forEach((d) => console.log(`    fila ${d.fila}: "${d.telefono}"  ${d.nombre}`));
        if (descartadas.length > 15) console.log(`    …y ${descartadas.length - 15} más`);
    }

    if (comodinesDetectados.length > 0) {
        console.log(`\n  ⚠ Números comodín (${UMBRAL_COMODIN}+ personas distintas detrás):`);
        comodinesDetectados
            .sort((a, b) => b.filas - a.filas)
            .forEach((g) => console.log(`    ${g.telefono}  ${g.filas} filas, ${g.personas} personas`));
        const filasComodin = comodinesDetectados.reduce((a, g) => a + g.filas, 0);
        console.log(`    → ${filasComodin} filas (${Math.round((filasComodin / filas.length) * 100)}% del archivo)`);
        console.log(`    → modo: ${comodines}`);
    }

    const resumen = `${aImportar.length} clientes de ${filas.length} filas`;
    console.log(`\n── Se importarían ${aImportar.length} clientes ─────────────────`);
    aImportar.slice(0, 8).forEach((g) => console.log(`    ${g.telefono}  ${g.nombre ?? '(sin nombre)'}`));
    if (aImportar.length > 8) console.log(`    …y ${aImportar.length - 8} más`);

    if (salidaSql) {
        generarSql(aImportar, resumen);
        console.log(`\n✓ SQL escrito en ${salidaSql} (${aImportar.length} sentencias). No se tocó la base.`);
        return;
    }
    if (!aplicar) {
        console.log('\nEsto es un ensayo: no se ha escrito nada. Añade --aplicar (o --sql=<ruta>).');
        return;
    }

    const n = await escribirEnBase(aImportar);
    const [{ total }] = await sequelize.query(
        'SELECT count(*)::int AS total FROM platform.persona_negocio WHERE id_negocio = :idNegocio;',
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    console.log(`\n✓ ${n} clientes cargados. La cartera del negocio tiene ahora ${total}.`);
}

main()
    .catch((e) => { console.error(`\n✗ ${e.message}`); process.exitCode = 1; })
    .finally(() => sequelize.close());
