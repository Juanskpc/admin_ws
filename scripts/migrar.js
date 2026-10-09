/**
 * `migrar.js` — corre una migración y apunta que se corrió.
 *
 * ## Para qué
 *
 * Las 132 migraciones del repo son idempotentes y cada una tiene su `npm run migrate:<nombre>`.
 * Lo que no había era **memoria**: nada en la base dice qué se aplicó, así que la pregunta
 * «¿producción tiene esta migración?» solo se podía contestar buscando a mano la columna que
 * añade. Este script añade la memoria sin tocar ninguna de las 132.
 *
 * ## Cómo se usa
 *
 *   node scripts/migrar.js --estado          Qué hay aplicado y qué falta.
 *   node scripts/migrar.js --pendientes      Solo los nombres que faltan (uno por línea).
 *   node scripts/migrar.js restaurante-cajas Corre esa y la apunta. Si ya está, no la repite.
 *   node scripts/migrar.js restaurante-cajas --forzar   La corre otra vez (son idempotentes).
 *   node scripts/migrar.js --adoptar         Marca TODAS como aplicadas sin correrlas.
 *
 * ## Por qué un proceso hijo y no un `require`
 *
 * Cada migración se autoejecuta al cargarla y termina llamando a `sequelize.close()`. Un
 * `require()` desde aquí dejaría la conexión cerrada antes de poder escribir el registro, y el
 * `process.exitCode` del hijo se mezclaría con el nuestro. Lanzarla como proceso aparte respeta
 * su forma tal como está —cero cambios en 132 archivos— y da algo que un `require` no da: el
 * código de salida, que es lo que distingue «se aplicó» de «reventó».
 *
 * ## Lo que este script NO hace
 *
 * **No corre todas las pendientes de golpe.** Tentador y peligroso: entre estas migraciones hay
 * dependencias de orden que no están declaradas en ninguna parte —`docs/perfiles-de-reserva.md`
 * documenta un orden fijo, y la nota de despliegue del 2026-09-24 avisa de cuatro que van antes
 * del backend—, y ni el orden alfabético ni el de `package.json` lo reproducen. Un runner que
 * las encadene en el orden equivocado rompe producción de una forma que cuesta mucho deshacer.
 * Así que `--estado` dice qué falta y la persona decide en qué orden. Cuando el orden esté
 * declarado de verdad, encadenarlas será un cambio pequeño.
 */
'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const DIR_MIGRACIONES = path.join(__dirname, '..', 'migrations');

/** `migrate_restaurante_cajas.js` → `restaurante-cajas`, la forma que escribe una persona. */
function nombrePublico(archivo) {
    return archivo.replace(/^migrate_/, '').replace(/\.js$/, '').replace(/_/g, '-');
}

/** `restaurante-cajas` → `migrate_restaurante_cajas.js`. */
function nombreArchivo(publico) {
    return `migrate_${publico.replace(/-/g, '_')}.js`;
}

/**
 * Todas las migraciones del directorio, por nombre público.
 *
 * `migrate.js` se queda fuera: es la migración inicial del esquema, no una de las
 * incrementales, y no tiene el prefijo `migrate_`.
 */
function migracionesEnDisco() {
    return fs
        .readdirSync(DIR_MIGRACIONES)
        .filter((f) => f.startsWith('migrate_') && f.endsWith('.js'))
        .map(nombrePublico)
        .sort();
}

async function registroExiste() {
    const [[fila]] = await sequelize.query(
        `SELECT to_regclass('general.gener_migracion') IS NOT NULL AS existe;`
    );
    return Boolean(fila?.existe);
}

async function aplicadas() {
    const [filas] = await sequelize.query(
        `SELECT nombre, aplicada_en, origen, ejecutada_por, duracion_ms
           FROM general.gener_migracion
          ORDER BY aplicada_en;`
    );
    return new Map((filas || []).map((f) => [f.nombre, f]));
}

async function apuntar(nombre, { origen, duracionMs = null, notas = null }) {
    // `ON CONFLICT` y no un INSERT a pelo: volver a correr una migración con `--forzar` tiene
    // que actualizar la fecha, no reventar por la restricción de unicidad.
    await sequelize.query(
        `
        INSERT INTO general.gener_migracion (nombre, origen, duracion_ms, ejecutada_por, notas)
        VALUES (:nombre, :origen, :duracionMs, :quien, :notas)
        ON CONFLICT (nombre) DO UPDATE
           SET aplicada_en   = CURRENT_TIMESTAMP,
               origen        = EXCLUDED.origen,
               duracion_ms   = EXCLUDED.duracion_ms,
               ejecutada_por = EXCLUDED.ejecutada_por,
               notas         = COALESCE(EXCLUDED.notas, general.gener_migracion.notas);
        `,
        {
            replacements: {
                nombre,
                origen,
                duracionMs,
                quien: (os.userInfo().username || 'desconocido').slice(0, 100),
                notas,
            },
        }
    );
}

function corrrerMigracion(publico) {
    const archivo = path.join(DIR_MIGRACIONES, nombreArchivo(publico));
    if (!fs.existsSync(archivo)) {
        console.error(`❌ No existe ${path.relative(process.cwd(), archivo)}`);
        return { ok: false };
    }

    console.log(`\n▶ ${publico}\n`);
    const inicio = Date.now();
    // `stdio: inherit` para que la salida de la migración se vea tal cual: son scripts que
    // cuentan lo que van haciendo paso a paso, y esconderlo detrás de un spinner quita
    // justamente la información que sirve cuando algo va mal.
    const res = spawnSync(process.execPath, [archivo], {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
    });

    return { ok: res.status === 0, duracionMs: Date.now() - inicio, codigo: res.status };
}

async function mostrarEstado() {
    const enDisco = migracionesEnDisco();
    const hechas = await aplicadas();

    const pendientes = enDisco.filter((n) => !hechas.has(n));
    // Una fila registrada cuyo archivo ya no está: la migración se borró del repo pero la base
    // la recuerda. No es un error, pero conviene verlo.
    const huerfanas = [...hechas.keys()].filter((n) => !enDisco.includes(n));

    console.log(`\nMigraciones en el repo: ${enDisco.length}`);
    console.log(`Registradas en esta base: ${hechas.size}`);
    console.log(`Pendientes de registrar: ${pendientes.length}\n`);

    if (pendientes.length) {
        console.log('── Sin registrar ──');
        for (const n of pendientes) console.log(`  ○ ${n}`);
        console.log(
            '\n  «Sin registrar» NO significa «sin aplicar»: si esta base es anterior al\n' +
            '  registro, lo más probable es que ya las tenga todas. Para decirlo de una vez:\n' +
            '    node scripts/migrar.js --adoptar\n'
        );
    }

    if (huerfanas.length) {
        console.log('── Registradas pero ya no están en el repo ──');
        for (const n of huerfanas) console.log(`  ? ${n}`);
        console.log('');
    }

    if (hechas.size) {
        console.log('── Últimas diez aplicadas ──');
        const ultimas = [...hechas.values()].slice(-10);
        for (const f of ultimas) {
            const fecha = new Date(f.aplicada_en).toISOString().slice(0, 16).replace('T', ' ');
            const marca = f.origen === 'registrada' ? '(solo registrada)' : '';
            console.log(`  ✓ ${fecha}  ${f.nombre} ${marca}`);
        }
        console.log('');
    }
}

async function adoptar() {
    const enDisco = migracionesEnDisco();
    const hechas = await aplicadas();
    const pendientes = enDisco.filter((n) => !hechas.has(n));

    if (!pendientes.length) {
        console.log('\nNada que adoptar: todas están registradas.\n');
        return;
    }

    console.log(`\nMarcando ${pendientes.length} migraciones como aplicadas SIN correrlas.`);
    console.log('Quedan con origen «registrada», que es una afirmación tuya, no una comprobación.\n');

    for (const n of pendientes) {
        await apuntar(n, {
            origen: 'registrada',
            notas: 'Adoptada al estrenar el registro: la base ya era anterior.',
        });
        console.log(`  ✓ ${n}`);
    }
    console.log(`\n✅ ${pendientes.length} registradas.\n`);
}

async function principal() {
    const args = process.argv.slice(2);
    const forzar = args.includes('--forzar');
    const objetivo = args.find((a) => !a.startsWith('--'));

    if (!(await registroExiste())) {
        console.error(
            '\n❌ Falta la tabla del registro. Créala primero:\n' +
            '     npm run migrate:registro-migraciones\n'
        );
        process.exitCode = 1;
        return;
    }

    if (args.includes('--adoptar')) return adoptar();

    if (args.includes('--pendientes')) {
        const hechas = await aplicadas();
        for (const n of migracionesEnDisco()) if (!hechas.has(n)) console.log(n);
        return;
    }

    if (!objetivo || args.includes('--estado')) return mostrarEstado();

    const hechas = await aplicadas();
    if (hechas.has(objetivo) && !forzar) {
        const f = hechas.get(objetivo);
        console.log(
            `\n✓ «${objetivo}» ya está registrada (${new Date(f.aplicada_en).toISOString().slice(0, 16).replace('T', ' ')}` +
            `${f.origen === 'registrada' ? ', solo registrada' : ''}).\n` +
            '  Para correrla igualmente: --forzar (son idempotentes).\n'
        );
        return;
    }

    const res = corrrerMigracion(objetivo);
    if (!res.ok) {
        console.error(`\n❌ «${objetivo}» falló (código ${res.codigo}). NO se registra.\n`);
        process.exitCode = 1;
        return;
    }

    await apuntar(objetivo, { origen: 'aplicada', duracionMs: res.duracionMs });
    console.log(`\n✅ «${objetivo}» aplicada y registrada (${res.duracionMs} ms).\n`);
}

principal()
    .catch((err) => {
        console.error('\n❌', err.message);
        process.exitCode = 1;
    })
    .finally(() => sequelize.close());
