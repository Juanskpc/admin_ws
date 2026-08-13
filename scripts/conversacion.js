/**
 * CLI del Conversation Engine — el arnés de F5-B (ADR-015).
 *
 * Hace de canal falso: mete mensajes por el mismo punto por el que los meterá el WebChat de
 * F5-C y enseña lo que el motor produjo. Sirve para ver los tres mecanismos de ADR-014
 * funcionando **sin canal, sin IA y sin gastar un centavo en tokens**.
 *
 * Uso:
 *   node scripts/conversacion.js enviar --negocio 1 --de ana --texto "hola"
 *   node scripts/conversacion.js rafaga --negocio 1 --de ana
 *   node scripts/conversacion.js ver    --negocio 1 --de ana
 *   node scripts/conversacion.js listar --negocio 1
 *   node scripts/conversacion.js recuperar
 *
 * Opciones comunes:
 *   --canal <nombre>   por defecto `cli`
 *   --id-mensaje <id>  identificador del mensaje en el canal; repetirlo prueba la
 *                      deduplicación (el segundo envío no crea nada)
 *   --no-esperar       no esperar al turno; deja el mensaje pendiente y sale
 *
 * ## Qué mirar
 *
 * `rafaga` manda cinco mensajes en dos segundos. Es el criterio de aceptación 2 de F5: debe
 * salir **un** turno con cinco mensajes agrupados y **una** respuesta, no cinco turnos.
 *
 * Después, `ver` imprime la conversación entera desde el Ledger: los turnos, los mensajes de
 * cada uno, los pasos que los decidieron y el estado que quedó guardado. Si el motor hizo
 * algo raro, se ve ahí — que es exactamente para lo que ADR-022 pide que exista el Ledger.
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');
const intelligence = require('../intelligence');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

function parsearArgv(argv) {
    const posicionales = [];
    const opciones = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--no-esperar') opciones.noEsperar = true;
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

const canalDe = (opciones) => opciones.canal || 'cli';

async function comandoEnviar(opciones) {
    const idNegocio = Number(exigir(opciones.negocio, 'Falta --negocio <id>.'));
    const idExterno = exigir(opciones.de, 'Falta --de <quien-escribe>.');
    const contenido = exigir(opciones.texto, 'Falta --texto "<mensaje>".');

    const salida = await intelligence.motor.recibir({
        idNegocio,
        canal: canalDe(opciones),
        idExterno,
        texto: contenido,
        idExternoMensaje: opciones['id-mensaje'] || null,
        despertar: !opciones.noEsperar,
    });

    if (salida.duplicado) {
        console.log('\n· Duplicado: el canal ya había entregado este mensaje. No se guardó nada.\n');
        return;
    }

    console.log(`\n→ Mensaje guardado en la conversación ${salida.id_conversacion}.`);

    if (opciones.noEsperar) {
        console.log('  (--no-esperar: queda pendiente. `recuperar` lo retomará.)\n');
        return;
    }

    await intelligence.motor.drenar();
    await imprimirUltimoTurno(salida.id_conversacion);
}

async function comandoRafaga(opciones) {
    const idNegocio = Number(exigir(opciones.negocio, 'Falta --negocio <id>.'));
    const idExterno = exigir(opciones.de, 'Falta --de <quien-escribe>.');
    const canal = canalDe(opciones);
    const textos = ['hola', 'quiero cita', 'para mañana', 'con Laura', 'gracias'];

    console.log('\n→ Cinco mensajes en dos segundos. Deben producir UN turno.\n');

    for (const texto of textos) {
        const salida = await intelligence.motor.recibir({ idNegocio, canal, idExterno, texto });
        console.log(`   · "${texto}"`);
        await new Promise((r) => setTimeout(r, 400));
        if (!salida.id_conversacion) break;
    }

    await intelligence.motor.drenar();

    const conversacion = await buscarConversacion(idNegocio, canal, idExterno);
    await imprimirUltimoTurno(conversacion.id_conversacion);
}

async function buscarConversacion(idNegocio, canal, idExterno) {
    const [fila] = await sequelize.query(
        `
        SELECT id_conversacion, estado, variables, tarea_actual, tarea_datos, ultimo_mensaje_en
          FROM intelligence.conversacion
         WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idExterno;
        `,
        { replacements: { idNegocio, canal, idExterno }, ...SELECT }
    );
    if (!fila) {
        console.error('\n✗ No existe esa conversación.\n');
        process.exit(1);
    }
    return fila;
}

async function imprimirUltimoTurno(idConversacion) {
    const [turno] = await sequelize.query(
        `
        SELECT id_turno, secuencia, estado, resultado, error_codigo, intentos, latencia_ms
          FROM intelligence.turno
         WHERE id_conversacion = :idConversacion
         ORDER BY secuencia DESC
         LIMIT 1;
        `,
        { replacements: { idConversacion }, ...SELECT }
    );

    if (!turno) {
        console.log('\n  (todavía no hay ningún turno)\n');
        return;
    }

    const mensajes = await sequelize.query(
        `
        SELECT direccion, contenido FROM intelligence.mensaje
         WHERE id_turno = :idTurno ORDER BY creado_en;
        `,
        { replacements: { idTurno: turno.id_turno }, ...SELECT }
    );

    console.log(
        `\n  Turno #${turno.secuencia} — ${turno.resultado || turno.estado}` +
            ` · ${turno.latencia_ms} ms · intento ${turno.intentos}` +
            `${turno.error_codigo ? ` · ${turno.error_codigo}` : ''}`
    );
    for (const m of mensajes) {
        console.log(`    ${m.direccion === 'entrante' ? '←' : '→'} ${m.contenido.replace(/\n/g, ' ⏎ ')}`);
    }
    console.log();
}

async function comandoVer(opciones) {
    const idNegocio = Number(exigir(opciones.negocio, 'Falta --negocio <id>.'));
    const idExterno = exigir(opciones.de, 'Falta --de <quien-escribe>.');
    const conversacion = await buscarConversacion(idNegocio, canalDe(opciones), idExterno);

    console.log(`\nConversación ${conversacion.id_conversacion}`);
    console.log(`  estado:    ${conversacion.estado}`);
    console.log(`  variables: ${JSON.stringify(conversacion.variables)}`);
    console.log(
        `  tarea:     ${conversacion.tarea_actual || '(ninguna)'} ` +
            `${conversacion.tarea_actual ? JSON.stringify(conversacion.tarea_datos) : ''}`
    );

    const turnos = await sequelize.query(
        `
        SELECT id_turno, creado_en, secuencia, nivel, estado, resultado, error_codigo, intentos, latencia_ms
          FROM intelligence.turno
         WHERE id_conversacion = :idConversacion
         ORDER BY secuencia;
        `,
        { replacements: { idConversacion: conversacion.id_conversacion }, ...SELECT }
    );

    for (const turno of turnos) {
        console.log(
            `\n  ── Turno #${turno.secuencia} [${turno.nivel}] ${turno.resultado || turno.estado}` +
                ` · ${turno.latencia_ms ?? '?'} ms · intento ${turno.intentos}` +
                `${turno.error_codigo ? ` · ${turno.error_codigo}` : ''}`
        );

        const mensajes = await sequelize.query(
            `SELECT direccion, contenido, estado_entrega FROM intelligence.mensaje
              WHERE id_turno = :idTurno ORDER BY creado_en;`,
            { replacements: { idTurno: turno.id_turno }, ...SELECT }
        );
        for (const m of mensajes) {
            const marca = m.direccion === 'entrante' ? '←' : '→';
            const entrega = m.direccion === 'saliente' ? ` [${m.estado_entrega}]` : '';
            console.log(`     ${marca} ${m.contenido.replace(/\n/g, ' ⏎ ')}${entrega}`);
        }

        const pasos = await sequelize.query(
            `SELECT secuencia, tipo, decision, motivo FROM intelligence.paso
              WHERE id_turno = :idTurno ORDER BY secuencia;`,
            { replacements: { idTurno: turno.id_turno }, ...SELECT }
        );
        for (const p of pasos) {
            console.log(`       ${p.secuencia}. ${p.tipo}/${p.decision} ${JSON.stringify(p.motivo)}`);
        }
    }

    const [pendientes] = await sequelize.query(
        `SELECT count(*)::int AS n FROM intelligence.mensaje
          WHERE id_conversacion = :id AND direccion = 'entrante' AND id_turno IS NULL;`,
        { replacements: { id: conversacion.id_conversacion }, ...SELECT }
    );
    if (pendientes.n > 0) console.log(`\n  ${pendientes.n} mensaje(s) entrante(s) sin turno.`);

    // Los salientes nacen 'pendiente' y nadie los entrega todavía: el Channel Gateway es F5-C.
    const [salida] = await sequelize.query(
        `SELECT count(*)::int AS n FROM intelligence.mensaje
          WHERE id_conversacion = :id AND direccion = 'saliente' AND estado_entrega = 'pendiente';`,
        { replacements: { id: conversacion.id_conversacion }, ...SELECT }
    );
    if (salida.n > 0) {
        console.log(`  ${salida.n} respuesta(s) sin entregar — el Channel Gateway llega en F5-C.`);
    }
    console.log();
}

async function comandoListar(opciones) {
    const idNegocio = Number(exigir(opciones.negocio, 'Falta --negocio <id>.'));
    const filas = await sequelize.query(
        `
        SELECT c.canal, c.id_externo, c.estado, c.tarea_actual, c.ultimo_mensaje_en,
               (SELECT count(*) FROM intelligence.turno t WHERE t.id_conversacion = c.id_conversacion) AS turnos
          FROM intelligence.conversacion c
         WHERE c.id_negocio = :idNegocio
         ORDER BY c.ultimo_mensaje_en DESC NULLS LAST
         LIMIT 40;
        `,
        { replacements: { idNegocio }, ...SELECT }
    );

    console.log(`\nConversaciones del negocio ${idNegocio}:\n`);
    for (const f of filas) {
        console.log(
            `  ${f.canal.padEnd(10)} ${String(f.id_externo).padEnd(20)} ${f.estado.padEnd(15)}` +
                ` ${String(f.turnos).padStart(3)} turno(s)  ${f.tarea_actual || ''}`
        );
    }
    console.log(`\n  ${filas.length} conversación(es).\n`);
}

async function comandoRecuperar() {
    const { colgados, reencoladas } = await intelligence.motor.recuperar();
    console.log(`\n  ${colgados} turno(s) colgado(s) marcados, ${reencoladas} conversación(es) reencolada(s).`);
    if (reencoladas > 0) {
        await intelligence.motor.drenar();
        console.log('  Trabajo pendiente procesado.');
    }
    console.log();
}

async function main() {
    const { posicionales, opciones } = parsearArgv(process.argv.slice(2));
    const [comando] = posicionales;

    // Los comandos de lectura no arrancan el motor: mirar el Ledger no debe abrir turnos.
    // Y ninguno recupera al arrancar — `recuperar` es un comando explícito. Hacer las dos
    // cosas encolaba la misma conversación dos veces y la segunda pisaba el contador de
    // intentos de la primera, así que el turno revivido se presentaba como intento 1.
    if (['enviar', 'rafaga', 'recuperar'].includes(comando)) {
        // Desde F5-D conduce la FSM determinista, no el eco: la CLI es el banco de pruebas
        // del camino completo (canal → motor → Policy Gate → capacidad → dominio) y con el
        // eco solo se ejercitaba la mecánica. `--eco` recupera el andamio para aislar fallos
        // del motor de fallos de la conversación, que es justo lo que ADR-015 quiere separar.
        const manejador = opciones.eco
            ? intelligence.manejadorEco.manejarEco
            : intelligence.manejadorDeterminista.manejarDeterminista;
        await intelligence.arrancarMotor(manejador, { recuperar: false });
    }

    switch (comando) {
        case 'enviar':
            await comandoEnviar(opciones);
            break;
        case 'rafaga':
            await comandoRafaga(opciones);
            break;
        case 'ver':
            await comandoVer(opciones);
            break;
        case 'listar':
            await comandoListar(opciones);
            break;
        case 'recuperar':
            await comandoRecuperar();
            break;
        default:
            console.log(
                require('fs').readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(1).join('\n')
            );
    }

    intelligence.motor.detener();
}

main()
    .catch((error) => {
        console.error(`\n✗ ${error.code ? `[${error.code}] ` : ''}${error.message}\n`);
        process.exitCode = 1;
    })
    .finally(() => sequelize.close());
