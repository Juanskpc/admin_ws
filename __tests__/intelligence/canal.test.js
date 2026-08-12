/**
 * Channel Gateway + WebChat hostil (F5-C — ADR-016, ADR-017).
 *
 * ADR-016 dice por qué esta suite existe y por qué no puede ser amable: las virtudes de un
 * canal propio —sin latencia, sin duplicados, sin reordenamiento— son **exactamente las
 * propiedades que ocultan los bugs que WhatsApp va a exponer**. Un WebChat cómodo haría que
 * los criterios de aceptación del motor pasaran siempre, y no por estar bien, sino por no
 * haber sido puestos a prueba.
 *
 * Así que cada test de aquí enciende un interruptor del simulador y comprueba **el bug
 * concreto que ese fallo caza**, según la tabla del ADR:
 *
 *   duplicar        → deduplicación por `id_externo`
 *   reordenar       → que el turno se lea en el orden en que se escribió
 *   fallar salida   → reintentos y dead letter
 *   retrasar salida → que el motor no asuma entrega inmediata
 *
 * Y uno que no es del simulador pero es la regla central del ADR: **la ingesta no devuelve la
 * respuesta del bot**. Si algún día la devolviera, todo lo demás dejaría de probar nada.
 *
 * Requiere:  npm run migrate:intelligence-ledger && npm run migrate:intelligence-canal
 * Correr con:  npx jest __tests__/intelligence/ --runInBand
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const gateway = require('../../intelligence/channels/gateway');
const adaptador = require('../../intelligence/channels/webchat/adaptador');
const simulador = require('../../intelligence/channels/webchat/simuladorFallos');
const mensajeCanonico = require('../../intelligence/core/mensajeCanonico');
const { CONFIG: COLA_CONFIG } = require('../../intelligence/engine/cola');
const { manejarEco } = require('../../intelligence/engine/manejadorEco');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

const CANAL = adaptador.NOMBRE;
const DEBOUNCE_TEST = 200;

let idNegocio;
let contador = 0;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const nuevaSesion = (prefijo) => `test_wc_${prefijo}_${Date.now()}_${contador++}`;

const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, replacements = {}) => (await consulta(sql, replacements))[0] ?? null;

async function conversacionDe(idSesion) {
    return unaFila(
        `SELECT * FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idSesion;`,
        { idNegocio, canal: CANAL, idSesion }
    );
}

async function mensajesDe(idConversacion, direccion) {
    return consulta(
        `SELECT * FROM intelligence.mensaje
          WHERE id_conversacion = :id AND direccion = :direccion
          ORDER BY COALESCE(enviado_en, creado_en), creado_en;`,
        { id: idConversacion, direccion }
    );
}

/** Un envío del widget, con su id de cliente y su marca de tiempo, como haría el navegador. */
async function enviar(idSesion, texto, { idMensajeCliente = null, enviadoEn = null } = {}) {
    return adaptador.recibirDelWidget({
        idNegocio,
        idSesion,
        texto,
        idMensajeCliente: idMensajeCliente || `cli_${idSesion}_${contador++}`,
        enviadoEn: enviadoEn || new Date(),
    });
}

/** Sesiones creadas por la suite, para limpiarlas al final sin tocar nada ajeno. */
const sesiones = new Set();
const sesion = (prefijo) => {
    const s = nuevaSesion(prefijo);
    sesiones.add(s);
    return s;
};

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay ningún negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;

    COLA_CONFIG.debounceMs = DEBOUNCE_TEST;
    COLA_CONFIG.debounceMaxMs = DEBOUNCE_TEST * 4;
});

beforeEach(() => {
    motor._reiniciar();
    motor.registrarManejador(manejarEco);
    gateway.limpiar();
    gateway.registrar(adaptador);
    simulador.limpiar();
    adaptador.limpiarBuzones();
});

afterEach(() => {
    motor.detener();
    gateway.detener();
});

afterAll(async () => {
    const ids = (
        await consulta(
            `SELECT id_conversacion FROM intelligence.conversacion
              WHERE canal = :canal AND id_externo IN (:sesiones);`,
            { canal: CANAL, sesiones: [...sesiones, '__ninguna__'] }
        )
    ).map((f) => f.id_conversacion);

    if (ids.length > 0) {
        await sequelize.query(
            `DELETE FROM intelligence.paso WHERE id_turno IN
                (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
            { replacements: { ids }, logging: false }
        );
        for (const tabla of ['mensaje', 'turno']) {
            await sequelize.query(
                `DELETE FROM intelligence.${tabla} WHERE id_conversacion IN (:ids);`,
                { replacements: { ids }, logging: false }
            );
        }
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
    }
    await sequelize.query(
        `DELETE FROM intelligence.ingesta_recibida WHERE canal = :canal AND id_externo LIKE 'cli_test_wc_%';`,
        { replacements: { canal: CANAL }, logging: false }
    );
    await sequelize.close();
});

// ── La regla central de ADR-016 ─────────────────────────────────────────────────────────

describe('la ingesta es asíncrona', () => {
    test('recibir un mensaje NO devuelve la respuesta del bot', async () => {
        // Si esto dejara de cumplirse, todos los demás tests de este archivo dejarían de
        // probar nada: sin camino asíncrono no hay entregas, ni retrasos, ni reintentos.
        const s = sesion('asincrono');

        const [acuse] = await enviar(s, 'hola');

        expect(acuse).toHaveProperty('id_conversacion');
        expect(acuse).not.toHaveProperty('respuesta');
        expect(acuse).not.toHaveProperty('respuestas');
        // Y en ese instante el buzón está vacío: el bot todavía no ha abierto el turno.
        expect(adaptador.leerDesde(idNegocio, s).mensajes).toHaveLength(0);

        await motor.drenar();
        // Tampoco ahora: el turno terminó, pero entregar es trabajo del gateway.
        expect(adaptador.leerDesde(idNegocio, s).mensajes).toHaveLength(0);

        await gateway.entregarUnaVez();
        expect(adaptador.leerDesde(idNegocio, s).mensajes).toHaveLength(1);
    }, 20000);
});

// ── Fallo 1: duplicar ───────────────────────────────────────────────────────────────────

describe('fallo inyectado: duplicar el mensaje entrante', () => {
    test('el canal entrega dos veces y solo se guarda uno', async () => {
        const s = sesion('duplicar');
        simulador.configurar(idNegocio, s, { duplicar: true });

        const acuses = await enviar(s, 'quiero cita');

        // El canal entregó dos veces de verdad — no es que el test finja el duplicado.
        expect(acuses).toHaveLength(2);
        expect(acuses.filter((a) => a.duplicado)).toHaveLength(1);
        expect(acuses[0].id_mensaje).toBe(acuses[1].id_mensaje);

        await motor.drenar();

        const conversacion = await conversacionDe(s);
        expect(await mensajesDe(conversacion.id_conversacion, 'entrante')).toHaveLength(1);
        // Y una sola respuesta: un duplicado no debe costar un turno más.
        expect(await mensajesDe(conversacion.id_conversacion, 'saliente')).toHaveLength(1);
    }, 20000);
});

// ── Fallo 2: reordenar ──────────────────────────────────────────────────────────────────

describe('fallo inyectado: reordenar dos mensajes', () => {
    test('llegan del revés y el turno se lee en el orden en que se escribieron', async () => {
        const s = sesion('reordenar');
        simulador.configurar(idNegocio, s, { reordenar: true });

        const primero = new Date(Date.now() - 4000);
        const segundo = new Date(Date.now() - 2000);

        // El simulador retiene el primero…
        const retenido = await enviar(s, 'quiero cita', { enviadoEn: primero });
        expect(retenido).toHaveLength(0);

        // …y lo suelta DETRÁS del segundo. El canal, por tanto, los entrega del revés.
        const soltados = await enviar(s, 'para mañana', { enviadoEn: segundo });
        expect(soltados).toHaveLength(2);

        await motor.drenar();

        const conversacion = await conversacionDe(s);
        const entrantes = await mensajesDe(conversacion.id_conversacion, 'entrante');
        expect(entrantes).toHaveLength(2);

        // Lo que importa: el turno los ordena por la hora del CANAL, no por la de llegada.
        // Sin `enviado_en` esto saldría «para mañana / quiero cita» y el asistente leería
        // una frase sin sentido.
        expect(entrantes.map((m) => m.contenido)).toEqual(['quiero cita', 'para mañana']);

        const [saliente] = await mensajesDe(conversacion.id_conversacion, 'saliente');
        expect(saliente.contenido.indexOf('quiero cita')).toBeLessThan(
            saliente.contenido.indexOf('para mañana')
        );
    }, 20000);

    test('apagar el reordenamiento suelta el mensaje que quedó retenido', async () => {
        // Si no, el mensaje se queda en el limbo del simulador y parece que el canal lo perdió.
        const s = sesion('reordenar_apagar');
        simulador.configurar(idNegocio, s, { reordenar: true });

        expect(await enviar(s, 'hola')).toHaveLength(0);

        simulador.configurar(idNegocio, s, { reordenar: false });
        const retenido = simulador.soltarRetenido(idNegocio, s);

        expect(retenido).not.toBeNull();
        expect(retenido.texto).toBe('hola');
    }, 20000);
});

// ── Fallo 3: fallar la entrega ──────────────────────────────────────────────────────────

describe('fallo inyectado: fallar la entrega saliente', () => {
    test('se reintenta y acaba entregando', async () => {
        const s = sesion('fallar');
        simulador.configurar(idNegocio, s, { fallarSalida: 2 });

        await enviar(s, 'hola');
        await motor.drenar();
        const conversacion = await conversacionDe(s);

        // Se comprueba la FILA y no los contadores del lote. Un lote arrastra los pendientes
        // de todo el sistema —otras sesiones, otros canales, restos de la CLI— y asertar
        // sobre `fallidos: 1` haría que este test dependiera de lo que hiciera cualquier otro.
        await gateway.entregarUnaVez();
        expect((await mensajesDe(conversacion.id_conversacion, 'saliente'))[0]).toMatchObject({
            estado_entrega: 'pendiente',
            intentos_entrega: 1,
        });

        await gateway.entregarUnaVez();
        expect((await mensajesDe(conversacion.id_conversacion, 'saliente'))[0]).toMatchObject({
            estado_entrega: 'pendiente',
            intentos_entrega: 2,
        });

        await gateway.entregarUnaVez();
        const [saliente] = await mensajesDe(conversacion.id_conversacion, 'saliente');
        expect(saliente.estado_entrega).toBe('entregado');
        expect(saliente.intentos_entrega).toBe(3);
        expect(saliente.entregado_en).not.toBeNull();
        // Una sola vez en el buzón, aunque hubiera tres intentos.
        expect(adaptador.leerDesde(idNegocio, s).mensajes).toHaveLength(1);
    }, 30000);

    test('agotar los intentos lo deja en dead letter y nadie lo reintenta más', async () => {
        const s = sesion('dead_letter');
        simulador.configurar(idNegocio, s, { fallarSalida: 99 });

        await enviar(s, 'hola');
        await motor.drenar();

        for (let i = 0; i < gateway.CONFIG.maxIntentos; i++) await gateway.entregarUnaVez();

        const conversacion = await conversacionDe(s);
        const [saliente] = await mensajesDe(conversacion.id_conversacion, 'saliente');
        expect(saliente.estado_entrega).toBe('fallido');
        expect(saliente.intentos_entrega).toBe(gateway.CONFIG.maxIntentos);

        // Un mensaje con cinco fallos seguidos no se arregla insistiendo: dejar de reclamarlo
        // es lo que hace que el problema se vea en vez de taparse.
        await gateway.entregarUnaVez();
        const [despues] = await mensajesDe(conversacion.id_conversacion, 'saliente');
        expect(despues.intentos_entrega).toBe(gateway.CONFIG.maxIntentos);
    }, 30000);
});

// ── Fallo 4: retrasar la entrega ────────────────────────────────────────────────────────

describe('fallo inyectado: retrasar la entrega saliente', () => {
    test('el motor no asume entrega inmediata: la conversación sigue avanzando', async () => {
        const s = sesion('retraso');
        simulador.configurar(idNegocio, s, { retrasoSalidaMs: 400 });

        await enviar(s, 'hola');
        await motor.drenar();

        // La entrega tarda; mientras tanto la persona escribe otra vez y el motor atiende ese
        // turno igual. Si el motor esperase a que se entregara, esto se bloquearía.
        const entrega = gateway.entregarUnaVez();
        await enviar(s, 'sigo aquí');
        await motor.drenar();

        const conversacion = await conversacionDe(s);
        expect((await mensajesDe(conversacion.id_conversacion, 'saliente')).length).toBe(2);

        await entrega;
        await gateway.entregarUnaVez();
        expect(adaptador.leerDesde(idNegocio, s).mensajes).toHaveLength(2);
    }, 30000);
});

// ── El buzón ────────────────────────────────────────────────────────────────────────────

describe('entrega al widget', () => {
    test('el cursor deja releer sin perder mensajes', async () => {
        // El widget puede perder una respuesta HTTP y volver a preguntar. Con cursor, repetir
        // la pregunta devuelve lo mismo; vaciando el buzón se habría comido los mensajes.
        const s = sesion('cursor');

        await enviar(s, 'hola');
        await motor.drenar();
        await gateway.entregarUnaVez();

        const primera = adaptador.leerDesde(idNegocio, s, 0);
        const repetida = adaptador.leerDesde(idNegocio, s, 0);
        const siguiente = adaptador.leerDesde(idNegocio, s, primera.cursor);

        expect(primera.mensajes).toHaveLength(1);
        expect(repetida.mensajes).toEqual(primera.mensajes);
        expect(siguiente.mensajes).toHaveLength(0);
    }, 20000);

    test('las opciones llegan como datos, no como texto ya formateado', async () => {
        // ADR-017: el núcleo no sabe cómo se pinta una opción. Si aquí llegara un «1) …\n2) …»
        // sería que el formato de un canal se filtró al núcleo y los demás lo heredarían.
        const s = sesion('opciones');

        await enviar(s, 'quiero cita pero pausa que me llaman');
        await motor.drenar();
        await gateway.entregarUnaVez();

        const [entregado] = adaptador.leerDesde(idNegocio, s).mensajes;
        expect(entregado.opciones).toEqual([{ id: 'seguimos', etiqueta: 'Seguimos' }]);
        expect(entregado.texto).not.toContain('Seguimos');

        const conversacion = await conversacionDe(s);
        const [saliente] = await mensajesDe(conversacion.id_conversacion, 'saliente');
        expect(saliente.opciones).toEqual([{ id: 'seguimos', etiqueta: 'Seguimos' }]);
    }, 20000);

    test('un canal sin adaptador no bloquea la cola de salida', async () => {
        const s = sesion('sin_adaptador');
        await enviar(s, 'hola');
        await motor.drenar();

        gateway.limpiar();
        gateway.registrar({ nombre: 'otro_canal', entregar: async () => {} });

        await gateway.entregarUnaVez();

        const conversacion = await conversacionDe(s);
        const [saliente] = await mensajesDe(conversacion.id_conversacion, 'saliente');
        expect(saliente.intentos_entrega).toBe(1);
        expect(saliente.estado_entrega).toBe('pendiente');
    }, 20000);
});

// ── El Mensaje Canónico ─────────────────────────────────────────────────────────────────

describe('Mensaje Canónico (ADR-017)', () => {
    test('rechaza lo que no es un mensaje', () => {
        const base = { canal: 'webchat', idNegocio: 1, idExterno: 'x', texto: 'hola' };

        expect(() => mensajeCanonico.normalizarEntrada({ ...base, texto: '   ' })).toThrow(
            /texto/i
        );
        expect(() => mensajeCanonico.normalizarEntrada({ ...base, idNegocio: 0 })).toThrow(
            /negocio/i
        );
        expect(() =>
            mensajeCanonico.normalizarEntrada({ ...base, texto: 'x'.repeat(5000) })
        ).toThrow(/caracteres/i);
    });

    test('no se cree una marca de tiempo imposible', () => {
        // `enviadoEn` ordena la conversación: un canal con el reloj mal —o un cliente que la
        // manipule— podría colar un mensaje delante de otro que no le corresponde.
        const base = { canal: 'webchat', idNegocio: 1, idExterno: 'x', texto: 'hola' };
        const anteayer = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const futuro = new Date(Date.now() + 24 * 60 * 60 * 1000);

        expect(mensajeCanonico.normalizarEntrada({ ...base, enviadoEn: anteayer }).enviadoEn).toBeNull();
        expect(mensajeCanonico.normalizarEntrada({ ...base, enviadoEn: futuro }).enviadoEn).toBeNull();
        expect(mensajeCanonico.normalizarEntrada({ ...base, enviadoEn: 'no es una fecha' }).enviadoEn).toBeNull();

        const ahora = new Date();
        expect(mensajeCanonico.normalizarEntrada({ ...base, enviadoEn: ahora }).enviadoEn).toEqual(ahora);
    });

    test('una cadena suelta es una respuesta válida; una sin texto no', () => {
        expect(mensajeCanonico.normalizarSalida('hola')).toEqual({ texto: 'hola', opciones: [] });
        expect(mensajeCanonico.normalizarSalida({ texto: 'elige', opciones: [{ etiqueta: 'A' }] })).toEqual(
            { texto: 'elige', opciones: [{ id: '1', etiqueta: 'A' }] }
        );
        expect(() => mensajeCanonico.normalizarSalida({ opciones: [] })).toThrow(/texto/i);
    });
});

// ── Ráfaga entera por el canal ──────────────────────────────────────────────────────────

describe('extremo a extremo por el canal', () => {
    test('cinco mensajes en ráfaga producen un turno y una entrega', async () => {
        // El criterio de aceptación 2 de F5, ahora atravesando el canal completo en vez de
        // llamando al motor a mano.
        const s = sesion('rafaga');

        for (const texto of ['hola', 'quiero cita', 'para mañana', 'con Laura', 'gracias']) {
            await enviar(s, texto);
            await dormir(30);
        }
        await motor.drenar();
        await gateway.entregarUnaVez();

        const conversacion = await conversacionDe(s);
        const turnos = await consulta(
            `SELECT * FROM intelligence.turno WHERE id_conversacion = :id;`,
            { id: conversacion.id_conversacion }
        );

        expect(turnos).toHaveLength(1);
        expect(await mensajesDe(conversacion.id_conversacion, 'entrante')).toHaveLength(5);

        const entregados = adaptador.leerDesde(idNegocio, s).mensajes;
        expect(entregados).toHaveLength(1);
        expect(entregados[0].texto).toContain('con Laura');
    }, 30000);
});
