/**
 * Motor determinista (F5-D) — tests hostiles.
 *
 * El aviso de ESTADO-Y-CONTINUACION era que «el manejador es lo único que no está probado a
 * fondo, porque el andamio de eco no decide nada». Esto es esa deuda.
 *
 * No se prueba el camino feliz y ya: se prueban los caminos que ocurren de verdad y que, si
 * están mal, fallan en silencio o delante del cliente — el hold que caduca justo antes de
 * confirmar, la respuesta que no está en el menú, el que se va a mitad y vuelve al día
 * siguiente, y la regla de idempotencia que evita la cita duplicada.
 *
 * Corre **sin Postgres**: el Gate y el resolver de identidad se inyectan. Esa frontera es la
 * que `motor.js` fijó a propósito para que F5-D pudiera enchufar una FSM sin tocar el motor.
 */
'use strict';

const {
    crearManejadorDeterminista,
    PASO,
    TAREA_AGENDAR,
} = require('../../intelligence/engine/manejadorDeterminista');

// ── Dobles ──────────────────────────────────────────────────────────────────────────────

const SERVICIOS = {
    servicios: [
        { id_servicio: 1, nombre: 'Corte', duracion_min: 30, precio: 25000 },
        { id_servicio: 2, nombre: 'Tinte', duracion_min: 90, precio: 120000 },
    ],
};

const DISPONIBILIDAD = {
    fecha: '2026-08-20',
    duracion_min: 30,
    horas: [
        { hora: '09:00', id_profesional: 4 },
        { hora: '10:00', id_profesional: 4 },
    ],
};

const HOLD = {
    codigo_hold: 'HOLD-ABC',
    inicio: '2026-08-20T10:00:00',
    duracion_min: 30,
    precio: 25000,
    servicio: 'Corte',
    profesional: 'Laura',
};

/** Gate de mentira que además anota cómo se le llamó, que es la mitad de lo que se prueba. */
function gateFalso(respuestas = {}) {
    const llamadas = [];
    return {
        llamadas,
        async ejecutar({ capacidad, args, claveIdempotencia, principal, idNegocio }) {
            llamadas.push({ capacidad, args, claveIdempotencia, principal, idNegocio });
            const respuesta = respuestas[capacidad];
            if (typeof respuesta === 'function') return { resultado: await respuesta(args) };
            if (respuesta instanceof Error) throw respuesta;
            return { resultado: respuesta ?? {} };
        },
    };
}

function identidadFalsa({ nombre = null, telefono = null } = {}) {
    return {
        async resolver() {
            return {
                principal: { tipo: 'contacto', puedeOperarEn: () => true },
                persona: null,
                nombre,
                telefono,
            };
        },
    };
}

function conversacion({ variables = {}, tarea = null, datos = {} } = {}) {
    return {
        id_conversacion: 'conv-1',
        id_negocio: 7,
        canal: 'webchat',
        variables,
        tarea_actual: tarea,
        tarea_datos: datos,
    };
}

function entrada(texto, conv, turno = { id_turno: 'turno-1' }) {
    return { conversacion: conv, mensajes: [{ contenido: texto }], turno, texto };
}

const gateCompleto = () =>
    gateFalso({
        consultar_servicios: SERVICIOS,
        consultar_disponibilidad: DISPONIBILIDAD,
        proponer_turno: HOLD,
        reservar_turno: { codigo_cita: 'CITA-999', inicio: '2026-08-20T10:00:00' },
    });

// ── El camino completo ──────────────────────────────────────────────────────────────────

describe('agendar una cita de principio a fin', () => {
    test('cinco turnos: servicio, fecha, hora, nombre, confirmar', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        // 1. Saluda → menú de servicios
        let conv = conversacion();
        let d = await manejar(entrada('hola', conv));
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.respuestas[0].opciones).toHaveLength(2);

        // 2. Elige servicio → pide fecha
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('1', conv));
        expect(d.tarea.datos).toMatchObject({ paso: PASO.FECHA, id_servicio: 1 });

        // 3. Da fecha → menú de horas
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('2026-08-20', conv));
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['09:00', '10:00']);

        // 4. Elige hora → pide nombre (no lo conocemos)
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('10:00', conv));
        expect(d.tarea.datos.paso).toBe(PASO.NOMBRE);

        // 5. Da nombre → aparta y pide confirmación
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('Nicolás', conv));
        expect(d.tarea.datos).toMatchObject({ paso: PASO.CONFIRMAR, codigo_hold: 'HOLD-ABC' });

        // 6. Confirma → cita creada y tarea cerrada
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('sí', conv));
        expect(d.tarea).toBeNull();
        expect(d.variables.ultima_cita).toBe('CITA-999');
        expect(d.respuestas[0]).toContain('CITA-999');
    });

    test('no vuelve a pedir el nombre si el Identity Resolver ya lo conoce', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({
            gate,
            identidad: identidadFalsa({ nombre: 'Nicolás', telefono: '+573114682492' }),
        });

        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' },
        });
        const d = await manejar(entrada('10:00', conv));

        // Se salta el paso NOMBRE y aparta directamente.
        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(gate.llamadas.map((l) => l.capacidad)).toContain('proponer_turno');
    });

    test('el teléfono conocido viaja a la cita', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({
            gate,
            identidad: identidadFalsa({ nombre: 'Nicolás', telefono: '+573114682492' }),
        });

        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'HOLD-ABC', nombre: 'Nicolás' },
        });
        await manejar(entrada('sí', conv));

        const reserva = gate.llamadas.find((l) => l.capacidad === 'reservar_turno');
        expect(reserva.args.cliente_telefono).toBe('+573114682492');
    });
});

// ── Lo hostil ───────────────────────────────────────────────────────────────────────────

describe('el hold caduca mientras el cliente decide', () => {
    test('no es un error: vuelve a ofrecer horas sin perder la tarea', async () => {
        const caducado = Object.assign(new Error('Esa hora ya no está apartada'), {
            code: 'HOLD_NO_VIGENTE',
        });
        const gate = gateFalso({ reservar_turno: caducado });
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'VIEJO', nombre: 'Ana' },
        });
        const d = await manejar(entrada('sí', conv));

        expect(d.pasos[0].decision).toBe('hold_caducado');
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
        expect(d.resultado).toBe('resuelto'); // no es un fallo del sistema
        expect(d.respuestas[0].texto).toMatch(/liberó esa hora/);
    });

    test('un error que NO es el hold sí se propaga', async () => {
        // Tragarse cualquier excepción convertiría una avería real en un mensaje amable y
        // el Ledger no registraría nada. Solo el hold caducado es conversación.
        const gate = gateFalso({ reservar_turno: new Error('la base se cayó') });
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.CONFIRMAR, codigo_hold: 'X', nombre: 'Ana', fecha: '2026-08-20', hora: '10:00' },
        });
        await expect(manejar(entrada('sí', conv))).rejects.toThrow(/la base se cayó/);
    });
});

describe('entradas que no están en el menú', () => {
    test.each([
        [PASO.SERVICIO, 'quiero lo de siempre'],
        [PASO.FECHA, 'cuando puedas'],
        [PASO.HORA, 'temprano'],
        [PASO.CONFIRMAR, 'mmm'],
    ])('en el paso %s repregunta sin perder la tarea', async (pasoActual, texto) => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        const datos = { paso: pasoActual, id_servicio: 1, fecha: '2026-08-20', codigo_hold: 'H', nombre: 'Ana' };
        const d = await manejar(entrada(texto, conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.pasos[0].decision).toBe('entrada_no_entendida');
        expect(d.tarea.datos.paso).toBe(pasoActual); // no avanza ni retrocede
    });

    test('un nombre de una sola letra no se acepta', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const datos = { paso: PASO.NOMBRE, id_servicio: 1, fecha: '2026-08-20', hora: '10:00' };
        const d = await manejar(entrada('x', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.tarea.datos.paso).toBe(PASO.NOMBRE);
    });

    test('un día sin horas libres devuelve al paso de fecha, no cierra la tarea', async () => {
        const gate = gateFalso({
            consultar_disponibilidad: { fecha: '2026-08-20', horas: [] },
            consultar_servicios: SERVICIOS,
        });
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        const datos = { paso: PASO.FECHA, id_servicio: 1 };
        const d = await manejar(entrada('2026-08-20', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.pasos[0].decision).toBe('sin_disponibilidad');
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
    });
});

describe('salir y volver', () => {
    test('cancelar manda en cualquier paso y cierra la tarea', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });

        for (const pasoActual of Object.values(PASO)) {
            const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: pasoActual } });
            const d = await manejar(entrada('cancelar', conv));
            expect(d.tarea).toBeNull();
            expect(d.pasos[0].decision).toBe('tarea_cancelada');
        }
    });

    test('«seguimos» retoma el paso exacto donde se quedó', async () => {
        // Es el «lo dejamos a medias el martes» de ADR-014: la tarea vive en la fila de la
        // conversación, así que esto vale igual tras reiniciar el proceso.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const datos = { paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' };
        const d = await manejar(entrada('seguimos', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.tarea.datos).toMatchObject(datos);
        expect(d.respuestas[0]).toMatch(/horas libres/i);
    });

    test('una tarea con un paso desconocido vuelve al menú en vez de reventar', async () => {
        // Pasa al desplegar una FSM nueva con conversaciones vivas a medias.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        // Con un texto cualquiera, no con un comando: «hola» es MENU y saldría por otra rama.
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: 'paso_de_otra_version' } });
        const d = await manejar(entrada('lo que sea', conv));

        expect(d.pasos[0].decision).toBe('paso_desconocido');
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
    });
});

// ── Las reglas que evitan daño ──────────────────────────────────────────────────────────

describe('idempotencia y capacidades', () => {
    test('la clave de idempotencia es el id del turno', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa({ nombre: 'Ana' }) });

        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        await manejar(entrada('sí', conversacion({ tarea: TAREA_AGENDAR, datos }), { id_turno: 'turno-42' }));

        expect(gate.llamadas[0].claveIdempotencia).toBe('turno-42');
    });

    test('ningún turno invoca dos veces la misma capacidad', async () => {
        // Es la regla que hace segura la clave = id del turno: el Gate guarda por
        // (negocio, capacidad, clave), así que repetir capacidad dentro de un turno haría
        // que la segunda llamada recibiera el resultado de la primera.
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa({ nombre: 'Ana' }) });

        const pasosDeLaTarea = [
            [{ paso: PASO.SERVICIO }, '1'],
            [{ paso: PASO.FECHA, id_servicio: 1 }, '2026-08-20'],
            [{ paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' }, '10:00'],
            [{ paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' }, 'sí'],
        ];

        for (const [datos, texto] of pasosDeLaTarea) {
            gate.llamadas.length = 0;
            await manejar(entrada(texto, conversacion({ tarea: TAREA_AGENDAR, datos })));
            const nombres = gate.llamadas.map((l) => l.capacidad);
            expect(new Set(nombres).size).toBe(nombres.length);
        }
    });

    test('aparta con el MISMO profesional que tenía libre esa hora', async () => {
        // Regresión de F5-D, cazada por el e2e: `consultar_disponibilidad` funde las agendas
        // de varios profesionales y dice cuál tiene libre cada hora. Si la FSM tira ese dato,
        // `proponer_turno` vuelve a elegir y puede caer en uno que acaba de ocuparse —
        // SLOT_NO_DISPONIBLE sobre una hora que el propio bot acababa de ofrecer.
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa({ nombre: 'Ana' }) });

        const datos = {
            paso: PASO.HORA,
            id_servicio: 1,
            fecha: '2026-08-20',
            profesional_por_hora: { '09:00': 4, '10:00': 7 },
        };
        await manejar(entrada('10:00', conversacion({ tarea: TAREA_AGENDAR, datos })));

        const propuesta = gate.llamadas.find((l) => l.capacidad === 'proponer_turno');
        expect(propuesta.args.id_profesional).toBe(7);
    });

    test('sin profesional conocido no lo inventa: deja elegir al adaptador', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa({ nombre: 'Ana' }) });

        const datos = { paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' };
        await manejar(entrada('10:00', conversacion({ tarea: TAREA_AGENDAR, datos })));

        const propuesta = gate.llamadas.find((l) => l.capacidad === 'proponer_turno');
        expect(propuesta.args).not.toHaveProperty('id_profesional');
    });

    test('toda invocación lleva el Principal y el negocio de la conversación', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });
        await manejar(entrada('hola', conversacion()));

        expect(gate.llamadas[0].idNegocio).toBe(7);
        expect(gate.llamadas[0].principal.tipo).toBe('contacto');
    });
});

describe('texto agrupado por el debounce', () => {
    // Lo cazó el test de ráfaga de extremo a extremo: al bot no le llega «sí», le llega
    // «sí\nsí\nsí», porque el debounce junta la ráfaga en UN turno. Comparar el bloque
    // entero contra «sí» no casaba y la cita no se creaba.
    test('tres «sí» seguidos confirman', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });
        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        const d = await manejar(entrada('sí\nsí\nsí', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.pasos[0].decision).toBe('cita_creada');
    });

    test('manda la ÚLTIMA línea, que es la intención actual', async () => {
        // «cancelar… no, espera» no debe cancelar: si valiera cualquier línea, sí lo haría.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.CONFIRMAR, codigo_hold: 'H', nombre: 'Ana', fecha: '2026-08-20', hora: '10:00' } });
        const d = await manejar(entrada('cancelar\nno, espera\nsí', conv));

        expect(d.pasos[0].decision).toBe('cita_creada');
    });

    test('un cambio de opinión en la ráfaga elige lo último', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO } });
        const d = await manejar(entrada('1\nmejor 2', conv));

        expect(d.tarea.datos.id_servicio).toBe(2);
    });

    test('un nombre partido en dos mensajes se une, no se recorta', async () => {
        // La excepción a la regla: «Nicolás\nPaez» son dos trozos de UN nombre, no dos
        // intenciones distintas.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const datos = { paso: PASO.NOMBRE, id_servicio: 1, fecha: '2026-08-20', hora: '10:00' };
        const d = await manejar(entrada('Nicolás\nPaez', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.variables.nombre).toBe('Nicolás Paez');
    });
});

describe('rastro para el Ledger (ADR-022)', () => {
    // «Capacidades ejecutadas» es una de las doce preguntas, y hasta F5-E nadie llenaba
    // `intelligence.invocacion_capacidad`: el Gate audita en `auditoria`, que responde otra
    // pregunta. Lo destapó la Consola al no encontrar nada que enseñar.
    test('devuelve lo que invocó, con su vertical y su latencia', async () => {
        const gate = gateCompleto();
        gate.ejecutar = (async (original) => original)(gate.ejecutar);
        const manejar = crearManejadorDeterminista({
            gate: {
                ...gate,
                async ejecutar(args) {
                    const r = await gateCompleto().ejecutar(args);
                    return { ...r, vertical: 'reserva' };
                },
            },
            identidad: identidadFalsa(),
        });

        const d = await manejar(entrada('hola', conversacion()));

        expect(d.invocaciones).toHaveLength(1);
        expect(d.invocaciones[0]).toMatchObject({
            capacidad: 'consultar_servicios',
            vertical: 'reserva',
            resultado: 'ok',
        });
        expect(typeof d.invocaciones[0].latenciaMs).toBe('number');
    });

    test('una capacidad que falla PERO se maneja sí llega al Ledger', async () => {
        // El hold caducado es el caso real: la capacidad falla, la FSM lo trata como
        // conversación y devuelve decisión. Esa invocación fallida es media respuesta a
        // «¿por qué el bot dijo eso?», así que tiene que quedar registrada.
        const caducado = Object.assign(new Error('caducó'), { code: 'HOLD_NO_VIGENTE' });
        const gate = gateFalso({ reservar_turno: caducado });
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        const d = await manejar(entrada('sí', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.invocaciones).toHaveLength(1);
        expect(d.invocaciones[0]).toMatchObject({
            capacidad: 'reservar_turno',
            resultado: 'error',
            errorCodigo: 'HOLD_NO_VIGENTE',
        });
    });

    test('si el error se propaga, la decisión no vuelve y el rastro se queda en la auditoría', async () => {
        // Límite conocido y aceptado: cuando el manejador lanza, el motor escribe el turno
        // como `error` (con su código y su detalle) pero no hay decisión que traiga
        // invocaciones. No se pierde nada importante: el Gate ya audita cada invocación
        // fallida en `auditoria.audit_evento` con argumentos completos, que es donde un
        // incidente se investiga. El Ledger cuenta la conversación; la auditoría, los hechos.
        const gate = gateFalso({ consultar_servicios: new Error('la base se cayó') });
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });

        await expect(manejar(entrada('hola', conversacion()))).rejects.toThrow(/la base se cayó/);
    });

    test('sin invocaciones no ensucia la decisión con un array vacío', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO } });
        const d = await manejar(entrada('cancelar', conv));

        expect(d.invocaciones).toBeUndefined();
    });
});

describe('memoria de conversación', () => {
    test('las variables se devuelven completas, porque reemplazan y no fusionan', async () => {
        // Si una rama devolviera solo lo que cambia, el resto se perdería en silencio. Este
        // test recorre el paso donde es más fácil olvidarlo.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const conv = conversacion({
            variables: { nombre: 'Ana', telefono: '+573114682492', ultima_cita: 'CITA-1', turnos: 3 },
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.SERVICIO },
        });
        const d = await manejar(entrada('1', conv));

        expect(d.variables).toMatchObject({
            nombre: 'Ana',
            telefono: '+573114682492',
            ultima_cita: 'CITA-1',
            turnos: 4,
        });
    });

    test('el código de la cita queda guardado: sin él no se puede reagendar ni cancelar', async () => {
        // No existe `consultar_mis_citas`. Este test es el recordatorio de por qué.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        const d = await manejar(entrada('sí', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.variables.ultima_cita).toBe('CITA-999');
    });
});

describe('presentación (ADR-017)', () => {
    test('los menús van en opciones, nunca numerados dentro del texto', async () => {
        // Cada canal pinta las opciones como sabe: chips en WebChat, botones en WhatsApp, y
        // la voz las enumera. Un «1) Corte 2) Tinte» escrito en el texto rompe los tres.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const d = await manejar(entrada('hola', conversacion()));

        expect(d.respuestas[0].opciones).toBeDefined();
        expect(d.respuestas[0].texto).not.toMatch(/^\s*\d\s*[).-]/m);
        expect(d.respuestas[0].texto).not.toContain('1)');
    });

    test('marca el nivel como determinista, que es lo que mide el coste en el Ledger', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), identidad: identidadFalsa() });
        const d = await manejar(entrada('hola', conversacion()));

        expect(d.nivel).toBe('determinista');
    });

    test('sin servicios activos lo dice y no abre tarea', async () => {
        const gate = gateFalso({ consultar_servicios: { servicios: [] } });
        const manejar = crearManejadorDeterminista({ gate, identidad: identidadFalsa() });
        const d = await manejar(entrada('hola', conversacion()));

        expect(d.tarea).toBeNull();
        expect(d.resultado).toBe('sin_respuesta');
    });
});
