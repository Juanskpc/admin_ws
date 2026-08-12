/**
 * CLI de capacidades — el arnés de F4 (ADR-015).
 *
 * Sirve para ejercitar la superficie de acción del asistente **sin IA, sin frontend y sin
 * gastar un centavo en tokens**. Es el criterio de aceptación de la fase: si desde aquí se
 * opera el negocio y la base queda impecable, el LLM que llegue en F6 será simplemente otro
 * invocador, y cuando algo falle sabremos que el fallo es del modelo.
 *
 * Uso:
 *   node scripts/capacidad.js listar [--negocio <id>]
 *   node scripts/capacidad.js describir <capacidad>
 *   node scripts/capacidad.js habilitar <capacidad> --negocio <id>
 *   node scripts/capacidad.js deshabilitar <capacidad> --negocio <id>
 *   node scripts/capacidad.js ejecutar <capacidad> --negocio <id> --usuario <id> [--args '<json>'] [--dry-run] [--clave <k>]
 *
 * Ejemplo:
 *   node scripts/capacidad.js ejecutar consultar_disponibilidad \
 *        --negocio 1 --usuario 1000000001 --args '{"id_servicio":1,"fecha":"2026-08-10"}'
 *
 * `--clave` es la clave de idempotencia: repetir la misma invocación con la misma clave
 * devuelve el resultado guardado sin volver a ejecutar. En F5 la pondrá el turno de
 * conversación; aquí se pone a mano para poder probarlo.
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');
const { resolverPrincipalUsuario } = require('../app_core/authz/principal');
const intelligence = require('../intelligence');

function parsearArgv(argv) {
    const posicionales = [];
    const opciones = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opciones.dryRun = true;
        else if (a.startsWith('--')) opciones[a.slice(2)] = argv[++i];
        else posicionales.push(a);
    }
    return { posicionales, opciones };
}

function exigir(valor, mensaje) {
    if (valor === undefined || valor === null || valor === '') {
        console.error(`\n✗ ${mensaje}\n`);
        process.exit(1);
    }
    return valor;
}

async function comandoListar(opciones) {
    const todas = intelligence.registry.listar();

    if (!opciones.negocio) {
        console.log('\nCatálogo de capacidades registradas:\n');
        for (const c of todas) {
            console.log(`  ${c.nombre.padEnd(28)} ${c.vertical.padEnd(14)} ${c.tipo}`);
        }
        console.log(`\n  ${todas.length} capacidad(es). Pasa --negocio <id> para ver cuáles puede ejecutar.\n`);
        return;
    }

    const idNegocio = Number(opciones.negocio);
    const disponibles = await intelligence.policyGate.capacidadesDisponibles(idNegocio);
    const nombresDisponibles = new Set(disponibles.map((c) => c.nombre));

    console.log(`\nCapacidades del negocio ${idNegocio}:\n`);
    for (const c of todas) {
        const habilitada = nombresDisponibles.has(c.nombre);
        console.log(`  ${habilitada ? '✓' : '·'} ${c.nombre.padEnd(28)} ${habilitada ? '' : '(no habilitada)'}`);
    }

    // El "·" tiene dos causas muy distintas y confundirlas cuesta una tarde: la feature
    // comercial apagada afecta a todas a la vez; la habilitación de dominio, a una sola.
    const feature = todas[0]?.feature;
    if (feature) {
        const { habilitado, motivo } = await intelligence.features.explicar(idNegocio, feature);
        console.log(`\n  Feature "${feature}": ${habilitado ? 'sí' : 'NO'} — ${motivo}`);
    }
    console.log();
}

function comandoDescribir(nombre) {
    const descripcion = intelligence.registry.describir(nombre);
    if (!descripcion) {
        console.error(`\n✗ La capacidad "${nombre}" no existe.\n`);
        process.exit(1);
    }
    console.log(`\n${JSON.stringify(descripcion, null, 2)}\n`);
}

async function comandoHabilitacion(nombre, opciones, habilitar) {
    const idNegocio = Number(exigir(opciones.negocio, 'Falta --negocio <id>.'));

    if (!intelligence.registry.obtener(nombre)) {
        console.error(`\n✗ La capacidad "${nombre}" no existe en el catálogo.\n`);
        process.exit(1);
    }

    await Models.sequelize.query(
        `
        INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada, habilitada_por)
        VALUES (:idNegocio, :nombre, :habilitada, :idUsuario)
        ON CONFLICT (id_negocio, capacidad)
        DO UPDATE SET habilitada = EXCLUDED.habilitada,
                      habilitada_en = now(),
                      habilitada_por = EXCLUDED.habilitada_por;
        `,
        {
            replacements: {
                idNegocio,
                nombre,
                habilitada: habilitar,
                idUsuario: opciones.usuario ? Number(opciones.usuario) : null,
            },
        }
    );

    console.log(`\n✓ "${nombre}" ${habilitar ? 'habilitada' : 'deshabilitada'} para el negocio ${idNegocio}.\n`);
}

async function comandoEjecutar(nombre, opciones) {
    const idNegocio = Number(exigir(opciones.negocio, 'Falta --negocio <id>.'));
    const idUsuario = Number(exigir(opciones.usuario, 'Falta --usuario <id> (quién ejecuta).'));

    let args = {};
    if (opciones.args) {
        try {
            args = JSON.parse(opciones.args);
        } catch (error) {
            console.error(`\n✗ --args no es JSON válido: ${error.message}\n`);
            process.exit(1);
        }
    }

    const principal = await resolverPrincipalUsuario(idUsuario);

    if (opciones.dryRun) console.log('\n[dry-run] la transacción se deshará al terminar.');

    const salida = await intelligence.policyGate.ejecutar({
        capacidad: nombre,
        principal,
        idNegocio,
        args,
        dryRun: Boolean(opciones.dryRun),
        claveIdempotencia: opciones.clave || null,
    });

    if (salida.reintento) console.log('\n[idempotencia] resultado guardado; no se volvió a ejecutar.');

    console.log(`\n${JSON.stringify(salida, null, 2)}\n`);
}

async function main() {
    const { posicionales, opciones } = parsearArgv(process.argv.slice(2));
    const [comando, argumento] = posicionales;

    intelligence.arrancar();

    switch (comando) {
        case 'listar':
            await comandoListar(opciones);
            break;
        case 'describir':
            comandoDescribir(exigir(argumento, 'Falta el nombre de la capacidad.'));
            break;
        case 'habilitar':
            await comandoHabilitacion(exigir(argumento, 'Falta el nombre de la capacidad.'), opciones, true);
            break;
        case 'deshabilitar':
            await comandoHabilitacion(exigir(argumento, 'Falta el nombre de la capacidad.'), opciones, false);
            break;
        case 'ejecutar':
            await comandoEjecutar(exigir(argumento, 'Falta el nombre de la capacidad.'), opciones);
            break;
        default:
            console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(1).join('\n'));
    }
}

main()
    .catch((error) => {
        console.error(`\n✗ ${error.code ? `[${error.code}] ` : ''}${error.message}\n`);
        process.exitCode = 1;
    })
    .finally(() => Models.sequelize.close());
