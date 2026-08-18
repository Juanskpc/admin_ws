#!/usr/bin/env node
/**
 * Arnés de evaluación desde la terminal (F6).
 *
 * Es la herramienta con la que se responde «¿mejoré o empeoré?» después de tocar un prompt, un
 * modelo o la tabla de enrutado. Sin ella, cambiar cualquiera de las tres cosas es superstición.
 *
 * ```bash
 * # Gratis, sin credencial y sin base de datos: solo la política de niveles.
 * node scripts/evaluar.js enrutado
 *
 * # Con modelo. Cuesta dinero de verdad; las capacidades se ejecutan EN SECO.
 * FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js respuestas --negocio 1
 * FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js inyeccion  --negocio 1
 *
 * # Barrido de esfuerzo: la forma de elegir `low` vs `medium` con datos y no a ojo.
 * LLM_ESFUERZO=medium node scripts/evaluar.js respuestas --negocio 1
 * ```
 *
 * ⚠️ **`FEATURES_FORZADAS=asistente_ia` hace falta siempre** en las suites con modelo: ningún
 * plan comercial incluye el asistente todavía y sin la variable el Gate deniega todo, con lo que
 * el arnés mediría un bot mudo y daría 0% sin explicar por qué.
 *
 * ⚠️ Y la de siempre: **esto corre contra la base a la que apunte tu `.env`**. Las capacidades
 * van en seco, así que no debería dejar rastro en el dominio — pero el Ledger no se toca aquí
 * (el arnés no abre turnos), así que tampoco quedan métricas: para eso está la Consola.
 */
'use strict';

require('dotenv').config();

const arnes = require('../intelligence/evaluacion/arnes');

function argumento(nombre, porDefecto = null) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

function pintar(resumen) {
    const pct = (n) => (n === null ? 'n/d' : `${(n * 100).toFixed(1)}%`);
    console.log(`\n── ${resumen.suite} ${'─'.repeat(Math.max(0, 60 - resumen.suite.length))}`);
    console.log(`   acierto      ${pct(resumen.acierto)}  (${resumen.aciertos}/${resumen.casos})`);
    console.log(`   costo        $${resumen.costoUsd}  (${resumen.llamadasAlModelo} llamadas, $${resumen.costoUsdPorCaso}/caso)`);
    console.log(
        `   tokens       ${resumen.tokens.entrada} entrada · ${resumen.tokens.salida} salida · ` +
            `${resumen.tokens.cacheLectura} de caché`
    );
    console.log(`   caché        ${pct(resumen.aciertoDeCache)} de la entrada`);
    console.log(`   latencia     p50 ${resumen.latenciaMs.p50 ?? 'n/d'} ms · p95 ${resumen.latenciaMs.p95 ?? 'n/d'} ms`);

    if (resumen.fallos.length) {
        console.log(`\n   ${resumen.fallos.length} fallo(s):`);
        for (const f of resumen.fallos) console.log(`   ✗ ${f.id}: ${f.detalle}`);
    }

    // El aviso que ADR-019 convierte en criterio de aceptación: caché a cero de forma
    // sostenida no es «no hay caché», es un invalidador silencioso, y la fase no está terminada.
    if (resumen.llamadasAlModelo > 2 && resumen.aciertoDeCache === 0) {
        console.log(
            '\n   ⚠️  cache_read = 0 en toda la tanda. Con varias llamadas eso NO es normal: ' +
                'hay algo volátil delante del punto de corte (ADR-019). Revisa promptBuilder.js.'
        );
    }
}

async function main() {
    const suite = process.argv[2] || 'enrutado';
    const idNegocio = Number(argumento('negocio', 1));

    if (suite === 'enrutado' || suite === 'todo') {
        pintar(arnes.evaluarEnrutado());
        if (suite === 'enrutado') return process.exit(0);
    }

    if (!process.env.ANTHROPIC_API_KEY) {
        console.error(
            '\nLas suites con modelo necesitan ANTHROPIC_API_KEY. La de `enrutado` no, y es la ' +
                'que puede correr en CI.'
        );
        return process.exit(1);
    }

    const intelligence = require('../intelligence');
    const { crearAdaptadorAnthropic } = require('../intelligence/model/adaptadores/anthropic');
    const { crearManejadorLlm, CONFIG } = require('../intelligence/engine/manejadorLlm');

    intelligence.arrancar(); // el catálogo de capacidades: sin esto el Gate deniega todo

    const manejador = crearManejadorLlm({
        adaptador: crearAdaptadorAnthropic(),
        // En seco: las capacidades se ejecutan y se deshacen (ADR-010). En F6 solo hay
        // consultas, así que es cinturón y tirantes — y lo seguirá siendo cuando no lo sea.
        config: { ...CONFIG, dryRun: true },
        // El arnés evalúa turnos aislados: cada caso arranca sin historial a propósito, para
        // que dos tandas separadas por una semana sean comparables.
        repositorio: { historialReciente: async () => [] },
    });

    const suites = suite === 'todo' ? ['respuestas', 'inyeccion'] : [suite];
    let todoOk = true;

    for (const nombre of suites) {
        const resumen = await arnes.evaluarConversaciones({
            suite: nombre,
            manejador,
            gate: intelligence.policyGate,
            idNegocio,
        });
        pintar(resumen);
        todoOk = todoOk && resumen.fallos.length === 0;
    }

    process.exit(todoOk ? 0 : 1);
}

main().catch((error) => {
    console.error('\nEl arnés falló:', error.message);
    process.exit(1);
});
