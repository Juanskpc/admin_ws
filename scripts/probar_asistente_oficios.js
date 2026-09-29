'use strict';
/**
 * Una conversación real con el asistente, oficio por oficio.
 *
 *   node scripts/probar_asistente_oficios.js            # los siete
 *   node scripts/probar_asistente_oficios.js mascotas   # solo uno
 *
 * Requiere `scripts/fixtures/dev_reserva_oficios.js` corrido antes, y la base de desarrollo.
 *
 * ## Qué prueba que los tests no prueban
 *
 * Los tests de la FSM corren **sin Postgres**, con un Policy Gate de mentira: prueban que el
 * flujo decide bien. Esto prueba lo otro —que las capacidades hablan de verdad con la vertical,
 * que el hold aparta lo que dice, que la cita nace con la variante correcta— y sobre todo que
 * **la conversación se lee bien**, que es lo único que ve el cliente y lo que ningún `expect`
 * mira.
 *
 * Cada turno se imprime como lo vería la persona. Al final se comprueba lo que tiene que haber
 * pasado en la base: una cita creada, con su precio, su duración y su mascota.
 *
 * ## No escribe fuera de la base de desarrollo
 *
 * Aborta si la base no es `escalapp_dev`. Las citas que crea quedan en los negocios «Prueba …»,
 * que no son de nadie.
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');
const intelligence = require('../intelligence');
const policyGate = require('../intelligence/core/policyGate');
const identidad = require('../intelligence/engine/identidad');
const flujos = require('../intelligence/engine/flujos');
const contextoNegocio = require('../intelligence/core/contextoNegocio');
const { TIPO } = require('../app_core/authz/principal');

Models.sequelize.options.logging = false;

const TELEFONO_CLIENTE = '+573001112233';   // el mismo del fixture: tiene mascota registrada
const TELEFONO_NUEVO = '+573009998877';     // sin historial: el camino del que llega por primera vez

/** Dentro de tres días, que pasa la anticipación mínima de todos los oficios (máx. 24 h). */
function enTresDias() {
    const d = new Date(Date.now() + 3 * 86400000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

const GUIONES = {
    barberia: {
        negocio: 'Prueba Barbería',
        telefono: TELEFONO_NUEVO,
        // La referencia. Seis turnos, exactamente como antes de todo esto.
        turnos: ['hola', 'Corte de cabello', 'me da igual', enTresDias(), null, 'Nicolás', 'sí'],
        espera: { sinVariante: true },
    },
    salon: {
        negocio: 'Prueba Salón de Belleza',
        telefono: TELEFONO_NUEVO,
        // Un turno más que la barbería: el largo del cabello.
        turnos: ['hola', 'Coloración', 'Pelo largo', 'me da igual', enTresDias(), null, 'Carolina', 'sí'],
        espera: { variante: 'Pelo largo', duracion: 120, monto: 180000 },
    },
    spa: {
        negocio: 'Prueba Spa',
        telefono: TELEFONO_NUEVO,
        turnos: ['hola', 'Masaje relajante', 'me da igual', enTresDias(), null, 'Marta', 'sí'],
        espera: { terminos: ['tratamiento', 'terapeuta'] },
    },
    estetica: {
        negocio: 'Prueba Centro de Estética',
        telefono: TELEFONO_NUEVO,
        turnos: ['hola', 'Depilación láser', enTresDias(), null, 'Lucía', 'sí'],
        espera: { aviso: 'consentimiento' },
    },
    tatuajes: {
        negocio: 'Prueba Tatuajes',
        telefono: TELEFONO_NUEVO,
        // El servicio a cotizar NO se agenda: la conversación termina en una persona.
        turnos: ['hola', 'Tatuaje personalizado'],
        espera: { handoff: true },
    },
    mascotas: {
        negocio: 'Prueba Peluquería Canina',
        telefono: TELEFONO_CLIENTE,
        // Elegir a Firulais (GRANDE) tiene que fijar la variante «Grande» sin preguntarla.
        // Sin turno de nombre: a Ana ya la conoce por su teléfono, así que no lo pregunta.
        turnos: ['hola', 'Baño y secado', 'Firulais', enTresDias(), null, 'sí'],
        espera: { variante: 'Grande', duracion: 90, monto: 85000, mascota: 'Firulais' },
    },
    dia_cerrado: {
        negocio: 'Prueba Barbería',
        telefono: TELEFONO_NUEVO,
        // Pide un domingo (cerrado). Antes: «no hay horas el domingo, ¿probamos el lunes?», a
        // ciegas. Ahora: los próximos días que SÍ tienen horas, y se elige el primero.
        turnos: ['hola', 'Barba', 'me da igual', 'el domingo', 'PRIMER_DIA', null, 'Pedro', 'sí'],
        espera: {},
    },
    sin_horario: {
        negocio: 'Prueba Consultorio',
        telefono: TELEFONO_NUEVO,
        // Un negocio sin horario configurado —lo más probable detrás del caso de D'ALEX—. El bot
        // no puede proponer ningún día: lo dice en el primer intento y pasa a una persona.
        turnos: ['hola', 'Consulta general'],
        espera: { handoff: true },
    },
    hotel: {
        negocio: 'Prueba Hotel',
        telefono: TELEFONO_NUEVO,
        turnos: ['hola'],
        espera: { portal: true },
    },
};

async function idDeNegocio(nombre) {
    const [fila] = await Models.sequelize.query(
        'SELECT id_negocio FROM general.gener_negocio WHERE nombre = :nombre',
        { replacements: { nombre }, type: Models.sequelize.QueryTypes.SELECT },
    );
    if (!fila) throw new Error(`No existe el negocio «${nombre}». Corre antes el fixture de oficios.`);
    return fila.id_negocio;
}

/** Conversación en memoria: el motor guarda estado, aquí se simula esa parte. */
function conversacionNueva(idNegocio, telefono) {
    return {
        id_conversacion: `prueba-${idNegocio}-${Date.now()}`,
        id_negocio: idNegocio,
        canal: 'whatsapp',
        id_externo: telefono,
        variables: {},
        tarea_actual: null,
        tarea_datos: {},
    };
}

function pintar(decision) {
    for (const r of decision.respuestas || []) {
        if (typeof r === 'string') {
            console.log(`   🤖 ${r}`);
            continue;
        }
        console.log(`   🤖 ${r.texto}`);
        for (const o of r.opciones || []) {
            console.log(`        [${o.etiqueta}]${o.detalle ? ` — ${o.detalle}` : ''}`);
        }
    }
}

/** El primer botón de día (`YYYY-MM-DD`) que el bot ofreció. */
function primerDia(decision) {
    for (const r of decision?.respuestas || []) {
        if (typeof r === 'string') continue;
        const d = (r.opciones || []).find((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.id));
        if (d) return d.id;
    }
    return null;
}

/** Elige la primera hora que el bot ofreció; es lo que haría una persona. */
function primeraHora(decision) {
    for (const r of decision.respuestas || []) {
        if (typeof r === 'string') continue;
        const hora = (r.opciones || []).find((o) => /^\d{1,2}:\d{2}$/.test(o.id));
        if (hora) return hora.id;
    }
    return null;
}

async function correr(clave) {
    const guion = GUIONES[clave];
    const idNegocio = await idDeNegocio(guion.negocio);

    // El mismo enrutado que usa el motor: se pregunta de qué CLASE es el negocio y se atiende
    // con el flujo que esa vertical declaró. Es lo que hace que un alojamiento no reciba el
    // menú de una peluquería — y probarlo aquí, en vez de llamar al flujo de citas a mano,
    // significa que esta prueba también vigila el enrutado.
    const negocio = await contextoNegocio.obtener(idNegocio);
    const flujo = flujos.para(negocio.tipoNegocio);
    if (!flujo) throw new Error(`Ningún flujo atiende a un negocio de tipo «${negocio.tipoNegocio}».`);
    console.log(`  tipo «${negocio.tipoNegocio}» → flujo «${flujo.vertical}»`);

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`  ${clave.toUpperCase()} — ${guion.negocio} (negocio ${idNegocio})`);
    console.log('═'.repeat(78));

    const conversacion = conversacionNueva(idNegocio, guion.telefono);
    let ultima = null;
    let turnoN = 0;

    for (const entrada of guion.turnos) {
        turnoN += 1;
        // `null` = «elige la primera hora que me ofreciste»; `PRIMER_DIA`, el primer día.
        const texto = entrada === null
            ? primeraHora(ultima)
            : entrada === 'PRIMER_DIA' ? primerDia(ultima) : entrada;
        if (entrada === null && !texto) {
            console.log('\n   ⚠️  No se ofrecieron horas: el guion no puede seguir.');
            break;
        }
        console.log(`\n   👤 ${texto}`);

        const decision = await flujo.manejar({
            conversacion,
            mensajes: [],
            turno: { id_turno: `${conversacion.id_conversacion}-${turnoN}` },
            texto,
            // La identidad que el canal ya probó: en WhatsApp sale del `from` del webhook.
            principal: { tipo: TIPO.CONTACTO, telefono_verificado: guion.telefono },
        });

        pintar(decision);
        // El motor real persiste esto; aquí se hace a mano para encadenar los turnos.
        conversacion.variables = decision.variables || conversacion.variables;
        conversacion.tarea_actual = decision.tarea ? decision.tarea.nombre : null;
        conversacion.tarea_datos = decision.tarea ? decision.tarea.datos : {};
        ultima = decision;
    }

    return { idNegocio, ultima, guion };
}

async function comprobar({ idNegocio, ultima, guion }, clave) {
    const espera = guion.espera || {};
    const problemas = [];

    if (espera.handoff) {
        if (ultima?.resultado !== 'handoff') problemas.push('esperaba que cediera a una persona');
        return problemas;
    }
    if (espera.portal) {
        const texto = JSON.stringify(ultima?.respuestas || []);
        if (!/\/p\/|fechas/i.test(texto)) problemas.push('esperaba el portal o una pregunta por fechas');
        return problemas;
    }

    const codigo = ultima?.variables?.ultima_cita;
    if (!codigo) {
        problemas.push('no se creó ninguna cita');
        return problemas;
    }

    const [cita] = await Models.sequelize.query(
        `SELECT c.codigo_publico, c.monto_total, c.id_mascota,
                EXTRACT(EPOCH FROM (c.fecha_hora_fin - c.fecha_hora_inicio))/60 AS duracion,
                m.nombre AS mascota,
                (SELECT string_agg(COALESCE(cs.variante_snapshot, '—'), ', ')
                   FROM reserva.reserva_cita_servicio cs WHERE cs.id_cita = c.id_cita) AS variantes
           FROM reserva.reserva_cita c
           LEFT JOIN reserva.reserva_mascota m ON m.id_mascota = c.id_mascota
          WHERE c.codigo_publico = :codigo AND c.id_negocio = :idNegocio`,
        { replacements: { codigo, idNegocio }, type: Models.sequelize.QueryTypes.SELECT },
    );
    if (!cita) {
        problemas.push(`la cita ${codigo} no está en la base`);
        return problemas;
    }

    console.log(`\n   📋 Cita ${cita.codigo_publico}: ${Number(cita.duracion)} min · ` +
                `$${Number(cita.monto_total).toLocaleString('es-CO')}` +
                `${cita.variantes && cita.variantes !== '—' ? ` · ${cita.variantes}` : ''}` +
                `${cita.mascota ? ` · 🐾 ${cita.mascota}` : ''}`);

    if (espera.duracion && Number(cita.duracion) !== espera.duracion) {
        problemas.push(`duración ${cita.duracion} min, esperaba ${espera.duracion}`);
    }
    if (espera.monto && Number(cita.monto_total) !== espera.monto) {
        problemas.push(`monto ${cita.monto_total}, esperaba ${espera.monto}`);
    }
    if (espera.variante && !String(cita.variantes || '').includes(espera.variante)) {
        problemas.push(`variante «${cita.variantes}», esperaba «${espera.variante}»`);
    }
    if (espera.mascota && cita.mascota !== espera.mascota) {
        problemas.push(`mascota «${cita.mascota}», esperaba «${espera.mascota}»`);
    }
    if (espera.sinVariante && cita.variantes && cita.variantes !== '—') {
        problemas.push(`no debería tener variante y tiene «${cita.variantes}»`);
    }
    if (espera.terminos) {
        const dicho = JSON.stringify(ultima?.respuestas || []).toLowerCase();
        // Los términos se ven en los turnos intermedios; aquí solo se avisa, no se falla.
        for (const t of espera.terminos) {
            if (!dicho.includes(t)) console.log(`   · (nota) el último turno no dice «${t}»`);
        }
    }
    if (espera.aviso === 'consentimiento') {
        // El aviso sale al apartar la hora, dos turnos antes del final.
        console.log('   · (nota) revisa arriba que avisó del consentimiento');
    }
    return problemas;
}

/**
 * Borra lo que dejó la corrida anterior en los negocios de prueba.
 *
 * Sin esto la prueba se degrada sola: cada pasada agenda una cita más, la agenda se llena y al
 * cabo de unas cuantas el bot deja de encontrar horas. Un test que empieza a fallar por haberse
 * ejecutado muchas veces es peor que no tenerlo, porque enseña a desconfiar del rojo.
 *
 * Acotado a los negocios «Prueba …» y a la base de desarrollo: dos cinturones para un borrado.
 */
async function limpiar() {
    const nombres = Object.values(GUIONES).map((g) => g.negocio);
    const [{ ids }] = await Models.sequelize.query(
        `SELECT COALESCE(array_agg(id_negocio), '{}') AS ids
           FROM general.gener_negocio WHERE nombre IN (:nombres)`,
        { replacements: { nombres }, type: Models.sequelize.QueryTypes.SELECT },
    );
    if (!ids || ids.length === 0) return;

    await Models.sequelize.query(
        `DELETE FROM reserva.reserva_cita_servicio
          WHERE id_cita IN (SELECT id_cita FROM reserva.reserva_cita WHERE id_negocio IN (:ids))`,
        { replacements: { ids } },
    );
    await Models.sequelize.query('DELETE FROM reserva.reserva_hold WHERE id_negocio IN (:ids)', {
        replacements: { ids },
    });
    await Models.sequelize.query('DELETE FROM reserva.reserva_cita WHERE id_negocio IN (:ids)', {
        replacements: { ids },
    });
    console.log(`  (agenda de ${ids.length} negocios de prueba, vaciada)`);
}

async function main() {
    if (process.env.DB_NAME !== 'escalapp_dev') {
        throw new Error('Se niega a correr: la base no es escalapp_dev.');
    }
    // Registra capacidades y flujos de todos los adaptadores, igual que hace el backend al
    // arrancar. Sin esto el Registry está vacío y el Gate deniega por «no existe».
    intelligence.arrancar();

    await limpiar();

    // En WhatsApp el `id_externo` de la conversación es un teléfono que el propio canal probó
    // (viene del `from` de un webhook firmado por Meta). Lo declara el canal al arrancar; aquí
    // se hace a mano porque esta prueba no levanta los canales. Sin esto el Principal va sin
    // teléfono verificado y el bot trata a todo el mundo como a un desconocido.
    identidad.registrarCanalConIdentidad('whatsapp');

    const pedido = process.argv[2];
    const claves = pedido ? [pedido] : Object.keys(GUIONES);
    const fallos = [];

    for (const clave of claves) {
        if (!GUIONES[clave]) {
            console.error(`No conozco el oficio «${clave}». Hay: ${Object.keys(GUIONES).join(', ')}`);
            continue;
        }
        try {
            const resultado = await correr(clave);
            const problemas = await comprobar(resultado, clave);
            if (problemas.length) {
                fallos.push([clave, problemas]);
                problemas.forEach((p) => console.log(`   ❌ ${p}`));
            } else {
                console.log('   ✅ como se esperaba');
            }
        } catch (err) {
            fallos.push([clave, [err.message]]);
            console.log(`   💥 ${err.message}`);
        }
    }

    console.log(`\n${'═'.repeat(78)}`);
    if (fallos.length === 0) {
        console.log(`  ✅ ${claves.length} oficios, todos como se esperaba\n`);
    } else {
        console.log(`  ❌ ${fallos.length} de ${claves.length} con problemas:\n`);
        fallos.forEach(([c, ps]) => ps.forEach((p) => console.log(`     ${c}: ${p}`)));
        console.log();
        process.exitCode = 1;
    }
}

main()
    .then(() => Models.sequelize.close())
    .catch((e) => { console.error('\n✗', e.stack, '\n'); process.exitCode = 1; });
