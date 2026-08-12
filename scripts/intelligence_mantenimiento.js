/**
 * Mantenimiento del esquema `intelligence`: particiones y retención.
 *
 * Uso:
 *   node scripts/intelligence_mantenimiento.js estado
 *   node scripts/intelligence_mantenimiento.js particiones [--meses 12]
 *   node scripts/intelligence_mantenimiento.js retencion [--aplicar]
 *
 * ## Las dos cosas que hay que vigilar, y por qué se hacen a mano
 *
 * **1. Particiones futuras.** Una tabla particionada sin la partición del mes en curso
 * rechaza *todo* INSERT con «no partition of relation found for row». Es un fallo de
 * producción que ocurre a medianoche del día 1, sin aviso previo, y que tumba el asistente
 * entero. Por eso `estado` avisa con antelación y `particiones` crea las que falten.
 *
 * **2. Retención.** Los datos de `intelligence` caducan a ritmos distintos:
 *
 * | Dato | Retención | Por qué |
 * |---|---|---|
 * | `mensaje.crudo` | 30 días | Payload del canal. PII sin valor pasado el incidente. |
 * | `mensaje` | 6 meses | El contenido de la conversación. Sujeto a Ley 1581 (ADR-024). |
 * | `paso` | 6 meses | Depuración: por qué el bot hizo lo que hizo. |
 * | `turno` | 24 meses | Métricas de producto: resolución, latencia, ratio IA. |
 * | `invocacion_capacidad` | 24 meses | **Trazabilidad**: qué tocó el asistente y cuándo. |
 * | `costo` | **no caduca** | Factura. Se agrega, nunca se borra (ADR-022). |
 *
 * `costo` es la excepción deliberada: es el único dato de este esquema con valor contable,
 * y borrar histórico de facturación para ahorrar disco es un mal negocio en cualquier
 * escala imaginable.
 *
 * **Nada de esto tiene un cron.** No porque falte, sino porque hoy no hay ni una fila: un
 * proceso automático que borra datos es exactamente lo que no conviene tener andando
 * desatendido antes de que haya nada que borrar. Cuando el volumen lo pida, se programa —
 * y con `--aplicar` explícito, nunca por defecto.
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;

/** Meses que se conservan por tabla. `null` = no caduca. */
const RETENCION_MESES = {
    mensaje: 6,
    paso: 6,
    turno: 24,
    invocacion_capacidad: 24,
    costo: null,
};

/** Umbral de aviso: por debajo de esto, quedan pocos meses de pista por delante. */
const MESES_MINIMOS = 3;

async function q(sql, replacements = {}) {
    const [filas] = await sequelize.query(sql, { replacements, logging: false });
    return filas;
}

/**
 * Particiones existentes por tabla, con su mes.
 *
 * `pg_inherits` también lista las particiones de los **índices** particionados (una por
 * índice y por mes), que aquí son ruido: no se dropean ni se cuentan, caen solas con su
 * tabla. Se filtran por `relkind = 'r'`, que deja solo particiones que son tablas de verdad.
 */
async function particiones() {
    return q(`
        SELECT parent.relname AS tabla,
               hijo.relname   AS particion,
               substring(hijo.relname from '(\\d{4}_\\d{2})$') AS mes
          FROM pg_inherits i
          JOIN pg_class hijo   ON hijo.oid = i.inhrelid AND hijo.relkind = 'r'
          JOIN pg_class parent ON parent.oid = i.inhparent AND parent.relkind = 'p'
          JOIN pg_namespace n  ON n.oid = parent.relnamespace
         WHERE n.nspname = 'intelligence'
         ORDER BY parent.relname, hijo.relname;
    `);
}

async function comandoEstado() {
    const todas = await particiones();
    if (todas.length === 0) {
        console.log('\n✗ No hay ninguna partición. ¿Se ejecutó npm run migrate:intelligence-ledger?\n');
        process.exitCode = 1;
        return;
    }

    const mesActual = new Date().toISOString().slice(0, 7).replace('-', '_');
    const porTabla = new Map();
    for (const p of todas) {
        if (!porTabla.has(p.tabla)) porTabla.set(p.tabla, []);
        porTabla.get(p.tabla).push(p.mes);
    }

    console.log('\nParticiones de intelligence\n');
    let alarma = false;

    for (const [tabla, meses] of [...porTabla].sort()) {
        meses.sort();
        const futuros = meses.filter((m) => m >= mesActual).length;
        const marca = futuros < MESES_MINIMOS ? '⚠' : '·';
        if (futuros < MESES_MINIMOS) alarma = true;
        console.log(
            `  ${marca} ${tabla.padEnd(24)} ${String(meses.length).padStart(3)} particiones ` +
                `· ${meses[0]} → ${meses[meses.length - 1]} · ${futuros} mes(es) por delante`
        );
    }

    const filas = await q(`
        SELECT relname AS tabla, n_live_tup AS filas
          FROM pg_stat_user_tables
         WHERE schemaname = 'intelligence' AND n_live_tup > 0
         ORDER BY n_live_tup DESC;
    `);
    console.log(filas.length ? '\nFilas por partición con datos:' : '\nTodas las tablas están vacías.');
    if (filas.length) console.table(filas);

    if (alarma) {
        console.log(`\n⚠ Alguna tabla tiene menos de ${MESES_MINIMOS} meses de particiones por delante.`);
        console.log('  Sin la partición del mes, TODO INSERT falla. Ejecuta:');
        console.log('     node scripts/intelligence_mantenimiento.js particiones --meses 12\n');
    } else {
        console.log();
    }
}

async function comandoParticiones(meses) {
    const [{ n }] = await q(`SELECT intelligence.asegurar_particiones(:meses) AS n;`, { meses });
    console.log(`\n✓ ${n} partición(es) creada(s). Cobertura: ${meses} meses desde el actual.\n`);
}

async function comandoRetencion(aplicar) {
    console.log(`\nRetención${aplicar ? '' : ' (simulación — usa --aplicar para ejecutar)'}\n`);

    const todas = await particiones();
    const corte = (mesesAtras) => {
        const d = new Date();
        d.setMonth(d.getMonth() - mesesAtras);
        return d.toISOString().slice(0, 7).replace('-', '_');
    };

    let algo = false;
    for (const [tabla, mesesRetencion] of Object.entries(RETENCION_MESES)) {
        if (mesesRetencion === null) {
            console.log(`  · ${tabla.padEnd(24)} no caduca (dato contable)`);
            continue;
        }
        const limite = corte(mesesRetencion);
        const caducadas = todas.filter((p) => p.tabla === tabla && p.mes < limite);

        if (caducadas.length === 0) {
            console.log(`  · ${tabla.padEnd(24)} nada que purgar (corte: ${limite})`);
            continue;
        }
        algo = true;
        for (const p of caducadas) {
            // DROP de partición, no DELETE: es instantáneo, no genera bloat y no bloquea la
            // tabla. Es la razón de ser del particionado, no un efecto secundario.
            console.log(`  ${aplicar ? '✗ DROP' : '→ dropearía'} intelligence.${p.particion}`);
            if (aplicar) await sequelize.query(`DROP TABLE intelligence.${p.particion};`, { logging: false });
        }
    }

    if (!algo) console.log('\n  Nada ha caducado todavía.');
    console.log();
}

async function main() {
    const argv = process.argv.slice(2);
    const comando = argv[0];
    const opcion = (n) => {
        const i = argv.indexOf(`--${n}`);
        return i >= 0 ? argv[i + 1] : null;
    };

    switch (comando) {
        case 'estado':
            await comandoEstado();
            break;
        case 'particiones':
            await comandoParticiones(Number(opcion('meses') || 12));
            break;
        case 'retencion':
            await comandoRetencion(argv.includes('--aplicar'));
            break;
        default:
            console.log(`
Uso:
  node scripts/intelligence_mantenimiento.js estado
  node scripts/intelligence_mantenimiento.js particiones [--meses 12]
  node scripts/intelligence_mantenimiento.js retencion [--aplicar]
`);
    }
}

main()
    .catch((e) => {
        console.error('\n✗', e.message, '\n');
        process.exitCode = 1;
    })
    .finally(() => sequelize.close());
