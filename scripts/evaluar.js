#!/usr/bin/env node
/**
 * Arnés de evaluación desde la terminal (F6).
 *
 * Es la herramienta con la que se responde «¿mejoré o empeoré?» después de tocar un prompt, un
 * modelo, un proveedor o la tabla de enrutado. Sin ella, cambiar cualquiera de esas cosas es
 * superstición.
 *
 * ```bash
 * # Gratis, sin credencial y sin base de datos: solo la política de niveles.
 * npm run evaluar enrutado
 *
 * # Con modelo. Cuesta dinero de verdad; las capacidades se ejecutan EN SECO.
 * FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js respuestas --negocio 1
 * FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js inyeccion  --negocio 1
 *
 * # Comparar varios modelos con LAS MISMAS conversaciones. Ésta es la que decide.
 * FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js respuestas --negocio 1 \
 *     --comparar gpt-5.6-luna,gpt-5.6-terra,claude-opus-5
 * ```
 *
 * ⚠️ **`FEATURES_FORZADAS=asistente_ia` hace falta siempre** en las suites con modelo: ningún
 * plan comercial incluye el asistente todavía y sin la variable el Gate deniega todo, con lo que
 * el arnés mediría un bot mudo y daría 0% sin explicar por qué.
 *
 * ⚠️ Y la de siempre: **esto corre contra la base a la que apunte tu `.env`**. Las capacidades
 * van en seco, así que no debería dejar rastro en el dominio.
 */
'use strict';

require('dotenv').config();

const arnes = require('../intelligence/evaluacion/arnes');
const fabrica = require('../intelligence/model/adaptadores');
const precios = require('../intelligence/model/precios');

function argumento(nombre, porDefecto = null) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

const pct = (n) => (n === null || n === undefined ? 'n/d' : `${(n * 100).toFixed(1)}%`);

function pintar(resumen, etiqueta = '') {
    const titulo = etiqueta ? `${resumen.suite} · ${etiqueta}` : resumen.suite;
    console.log(`\n── ${titulo} ${'─'.repeat(Math.max(0, 60 - titulo.length))}`);
    console.log(`   acierto      ${pct(resumen.acierto)}  (${resumen.aciertos}/${resumen.casos})`);
    console.log(
        `   costo        $${resumen.costoUsd}  (${resumen.llamadasAlModelo} llamadas, ` +
            `$${resumen.costoUsdPorCaso}/caso)`
    );
    console.log(
        `   tokens       ${resumen.tokens.entrada} entrada · ${resumen.tokens.salida} salida · ` +
            `${resumen.tokens.cacheLectura} de caché`
    );
    console.log(`   caché        ${pct(resumen.aciertoDeCache)} de la entrada`);
    console.log(
        `   latencia     p50 ${resumen.latenciaMs.p50 ?? 'n/d'} ms · p95 ${resumen.latenciaMs.p95 ?? 'n/d'} ms`
    );

    if (resumen.fallos.length) {
        console.log(`\n   ${resumen.fallos.length} fallo(s):`);
        for (const f of resumen.fallos) console.log(`   ✗ ${f.id}: ${f.detalle}`);
    }

    // El aviso que ADR-019 convierte en criterio de aceptación: caché a cero de forma
    // sostenida no es «no hay caché», es un invalidador silencioso, y la fase no está terminada.
    if (resumen.llamadasAlModelo > 2 && resumen.aciertoDeCache === 0) {
        const tokensPorLlamada = Math.round(resumen.tokens.entrada / resumen.llamadasAlModelo);
        console.log(
            '\n   ⚠️  cache_read = 0 en toda la tanda. Con varias llamadas eso NO es normal: ' +
                'hay algo volátil delante del punto de corte (ADR-019). Revisa promptBuilder.js.'
        );
        // Salvo que el prompt sea demasiado corto para que haya caché siquiera. Medido el
        // 2026-08-18: OpenAI **no cachea por debajo de 1024 tokens de entrada**, y con dos
        // llamadas idénticas de 3213 tokens la segunda trajo 3210 cacheados. Los prompts reales
        // de esta suite rondan los 950-1020, justo debajo del umbral, así que el cero no
        // acusaba a nadie. Sin esta nota se pierde una tarde buscando un bug en el prefijo.
        if (tokensPorLlamada < 1024) {
            console.log(
                `       …aunque el prompt son ~${tokensPorLlamada} tokens por llamada, y OpenAI ` +
                    'no cachea por debajo de 1024. Ahí el cero es el umbral, no un prefijo roto: ' +
                    'compruébalo con dos llamadas largas idénticas antes de tocar el prompt.'
            );
        }
    }
}

/**
 * La tabla que decide. Ordenada por acierto y, a igualdad, por costo: primero que funcione, y
 * entre los que funcionan, el barato.
 */
function pintarComparacion(filas) {
    const orden = [...filas].sort(
        (a, b) => b.resumen.acierto - a.resumen.acierto || Number(a.resumen.costoUsd) - Number(b.resumen.costoUsd)
    );

    console.log('\n══ Comparación ═══════════════════════════════════════════════════════════════');
    console.log('   modelo                proveedor   acierto   costo/caso    p95      caché');
    for (const { etiqueta, proveedor, resumen } of orden) {
        console.log(
            `   ${etiqueta.padEnd(21)} ${proveedor.padEnd(11)} ${pct(resumen.acierto).padStart(7)}   ` +
                `$${Number(resumen.costoUsdPorCaso).toFixed(6)}  ` +
                `${String(resumen.latenciaMs.p95 ?? 'n/d').padStart(6)}ms  ${pct(resumen.aciertoDeCache).padStart(6)}`
        );
    }
    console.log(
        '\n   Se ordena por acierto y, a igualdad, por costo. Un modelo barato con el mismo\n' +
            '   acierto es evidencia a favor del nivel intermedio que ADR-018 dejó sin construir.'
    );
}

/** Monta el manejador de Nivel 4 para un modelo concreto, en seco y sin historial. */
function manejadorPara(modelo) {
    const elegido = fabrica.crearAdaptador({ modelo });
    if (!elegido) {
        throw new Error(
            `No hay credencial para el proveedor de "${modelo}". Se busca ` +
                `${fabrica.CREDENCIAL[precios.proveedorDe(modelo)] || 'la variable del proveedor'}.`
        );
    }

    const { crearManejadorLlm, CONFIG } = require('../intelligence/engine/manejadorLlm');
    return {
        proveedor: elegido.proveedor,
        modelo: elegido.modelo,
        manejador: crearManejadorLlm({
            adaptador: elegido.adaptador,
            // En seco: las capacidades se ejecutan y se deshacen (ADR-010). En F6 solo hay
            // consultas, así que es cinturón y tirantes — y lo seguirá siendo cuando no lo sea.
            config: { ...CONFIG, modelo: elegido.modelo, dryRun: true },
            // El arnés evalúa turnos aislados: cada caso arranca sin historial a propósito, para
            // que dos tandas separadas por una semana sean comparables.
            repositorio: { historialReciente: async () => [] },
        }),
    };
}

async function main() {
    const suite = process.argv[2] || 'enrutado';
    const idNegocio = Number(argumento('negocio', 1));
    const comparar = argumento('comparar');

    if (suite === 'enrutado' || suite === 'todo') {
        pintar(arnes.evaluarEnrutado());
        if (suite === 'enrutado') return process.exit(0);
    }

    const disponibles = fabrica.proveedoresDisponibles();
    if (disponibles.length === 0) {
        console.error(
            `\nLas suites con modelo necesitan una credencial (${Object.values(fabrica.CREDENCIAL).join(' o ')}). ` +
                'La suite de `enrutado` no, y es la que puede correr en CI.'
        );
        return process.exit(1);
    }

    const intelligence = require('../intelligence');
    intelligence.arrancar(); // el catálogo de capacidades: sin esto el Gate deniega todo

    const modelos = comparar ? comparar.split(',').map((m) => m.trim()) : [null];
    const suites = suite === 'todo' ? ['respuestas', 'inyeccion'] : [suite];

    let todoOk = true;

    for (const nombreSuite of suites) {
        const filas = [];
        for (const modelo of modelos) {
            const montado = manejadorPara(modelo);
            const resumen = await arnes.evaluarConversaciones({
                suite: nombreSuite,
                manejador: montado.manejador,
                gate: intelligence.policyGate,
                idNegocio,
            });
            pintar(resumen, `${montado.proveedor}/${montado.modelo}`);
            filas.push({ etiqueta: montado.modelo, proveedor: montado.proveedor, resumen });
            todoOk = todoOk && resumen.fallos.length === 0;
        }
        if (filas.length > 1) pintarComparacion(filas);
    }

    process.exit(todoOk ? 0 : 1);
}

main().catch((error) => {
    console.error('\nEl arnés falló:', error.message);
    process.exit(1);
});
