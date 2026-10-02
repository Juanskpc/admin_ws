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
} = require('../../intelligence/adapters/reserva/flujoCita');

// ── Dobles ──────────────────────────────────────────────────────────────────────────────

const SERVICIOS = {
    servicios: [
        { id_servicio: 1, nombre: 'Corte', duracion_min: 30, precio: 25000 },
        { id_servicio: 2, nombre: 'Tinte', duracion_min: 90, precio: 120000 },
    ],
};

/**
 * Lo que la FSM guarda en `tarea_datos` al pintar el menú, para poder resolver la respuesta
 * contra la lista real en vez de sacar un número del texto libre.
 */
const SERVICIOS_OFRECIDOS = SERVICIOS.servicios.map((s) => ({
    id: s.id_servicio,
    nombre: s.nombre,
}));

const PROFESIONALES = {
    profesionales: [
        { id_profesional: 4, nombre: 'Laura Gómez', especialidad: 'Colorimetría' },
        { id_profesional: 5, nombre: 'Marco Ruiz', especialidad: 'Barbería' },
    ],
};

/** Un servicio que presta una sola persona: el caso en que NO hay que preguntar nada. */
const UN_SOLO_PROFESIONAL = {
    profesionales: [{ id_profesional: 4, nombre: 'Laura Gómez', especialidad: 'Colorimetría' }],
};

const PROFESIONALES_OFRECIDOS = PROFESIONALES.profesionales.map((p) => ({
    id: p.id_profesional,
    nombre: p.nombre,
}));

const DISPONIBILIDAD = {
    fecha: '2026-08-20',
    duracion_min: 30,
    horas: [
        { hora: '09:00', id_profesional: 4, id_profesionales: [4] },
        // A las 10:00 están libres los dos: es la hora en la que el cliente elige con quién.
        { hora: '10:00', id_profesional: 4, id_profesionales: [4, 5] },
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

/**
 * Resolver de identidad de mentira, con la misma precedencia que el de verdad: lo que dijo o
 * tiene registrado manda sobre el nombre del perfil del canal, que es solo una pista.
 */
function identidadFalsa({ nombre = null, telefono = null } = {}) {
    const { nombreLegible } = require('../../intelligence/engine/identidad');
    return {
        async resolver(_conversacion, opciones = {}) {
            const delPerfil = nombreLegible(opciones.nombrePerfil);
            return {
                principal: { tipo: 'contacto', puedeOperarEn: () => true },
                persona: null,
                nombre: nombre ?? delPerfil,
                nombreEsPista: Boolean(!nombre && delPerfil),
                telefono,
            };
        },
    };
}

/**
 * Contexto del inquilino. Se dobla como el Gate y el resolver para que la suite siga corriendo
 * sin Postgres: es lo único nuevo del saludo que toca la base.
 */
const NEGOCIO_FALSO = {
    async obtener() {
        return { id: 7, nombre: 'Barbería Don Nico', tratamiento: 'Barbería Don Nico' };
    },
};

/** Un negocio que no se pudo leer: el saludo tiene que seguir siendo una frase, no «null». */
const NEGOCIO_ANONIMO = {
    async obtener() {
        return { id: null, nombre: null, tratamiento: 'el negocio' };
    },
};

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

/** Como `entrada`, pero con el nombre que WhatsApp trae del perfil de quien escribe. */
function entradaConPerfil(texto, conv, perfilNombre) {
    return {
        conversacion: conv,
        mensajes: [{ contenido: texto, crudo: { tipo: 'text', perfil_nombre: perfilNombre } }],
        turno: { id_turno: 'turno-1' },
        texto,
    };
}

const gateCompleto = () =>
    gateFalso({
        consultar_servicios: SERVICIOS,
        consultar_profesionales: PROFESIONALES,
        consultar_disponibilidad: DISPONIBILIDAD,
        proponer_turno: HOLD,
        reservar_turno: { codigo_cita: 'CITA-999', inicio: '2026-08-20T10:00:00' },
    });

// ── El camino completo ──────────────────────────────────────────────────────────────────

describe('agendar una cita de principio a fin', () => {
    test('siete turnos: servicio, fecha, hora, nombre, profesional, confirmar', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

        // 1. Saluda → menú de servicios
        let conv = conversacion();
        let d = await manejar(entrada('hola', conv));
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.respuestas[0].opciones).toHaveLength(2);

        // 2. Elige servicio → pide el día (el profesional va después de la hora, 2026-09-29)
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('1', conv));
        expect(d.tarea.datos).toMatchObject({ paso: PASO.FECHA, id_servicio: 1 });

        // 3. Da fecha → menú de horas, sin filtrar por nadie
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('2026-08-20', conv));
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        // Las horas, y al final la salida para cambiar de día (2026-08-24).
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['09:00', '10:00', 'volver_fecha']);
        const disponibilidad = gate.llamadas.find((l) => l.capacidad === 'consultar_disponibilidad');
        expect('id_profesional' in disponibilidad.args).toBe(false);

        // 4. Elige hora → pide nombre (no lo conocemos)
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('10:00', conv));
        expect(d.tarea.datos.paso).toBe(PASO.NOMBRE);

        // 5. Da nombre → pregunta con quién, entre los libres a las 10:00
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('Nicolás', conv));
        expect(d.tarea.datos).toMatchObject({ paso: PASO.PROFESIONAL, nombre: 'Nicolás' });
        // El nombre ya queda en la memoria: la próxima vez no se pregunta.
        expect(d.variables.nombre).toBe('Nicolás');

        // 6. Elige a Marco → aparta con él y pide confirmación
        conv = conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos });
        d = await manejar(entrada('Marco', conv));
        expect(d.tarea.datos).toMatchObject({ paso: PASO.CONFIRMAR, codigo_hold: 'HOLD-ABC', id_profesional: 5 });
        const propuesta = gate.llamadas.find((l) => l.capacidad === 'proponer_turno');
        expect(propuesta.args).toMatchObject({ inicio: '2026-08-20T10:00:00', id_profesional: 5 });

        // 7. Confirma → cita creada y tarea cerrada
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
            contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Nicolás', telefono: '+573114682492' }),
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
            contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Nicolás', telefono: '+573114682492' }),
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

// ── Quién habla ─────────────────────────────────────────────────────────────────────────

describe('el saludo dice a qué negocio escribiste', () => {
    const texto = (d) => (typeof d.respuestas[0] === 'string' ? d.respuestas[0] : d.respuestas[0].texto);

    test('en el primer contacto se presenta con el nombre del negocio', async () => {
        const manejar = crearManejadorDeterminista({
            gate: gateCompleto(),
            contextoNegocio: NEGOCIO_FALSO,
            identidad: identidadFalsa(),
        });
        const d = await manejar(entrada('hola', conversacion()));

        expect(texto(d)).toContain('Barbería Don Nico');
        expect(d.respuestas[0].opciones).toHaveLength(2); // sigue ofreciendo, no gasta un turno
    });

    test('a quien ya conoce lo saluda por su nombre', async () => {
        const manejar = crearManejadorDeterminista({
            gate: gateCompleto(),
            contextoNegocio: NEGOCIO_FALSO,
            identidad: identidadFalsa(),
        });
        const d = await manejar(entrada('hola', conversacion({ variables: { nombre: 'Ana' } })));

        expect(texto(d)).toContain('Ana');
        expect(texto(d)).toContain('Barbería Don Nico');
    });

    test('saluda por la hora del día, en la hora del NEGOCIO', async () => {
        // El proceso corre en UTC en el VPS. Con `getHours()` esto diría «buenas noches» a las
        // seis de la tarde en Bogotá, que es justo la clase de detalle que delata a un bot.
        const alas = (iso) =>
            crearManejadorDeterminista({
                gate: gateCompleto(),
                contextoNegocio: NEGOCIO_FALSO,
                identidad: identidadFalsa(),
                ahora: () => new Date(iso),
            });

        const manana = await alas('2026-08-26T14:00:00Z')(entrada('hola', conversacion())); // 09:00
        const tarde = await alas('2026-08-26T20:00:00Z')(entrada('hola', conversacion())); // 15:00
        const noche = await alas('2026-08-27T01:00:00Z')(entrada('hola', conversacion())); // 20:00

        expect(texto(manana)).toContain('Buenos días');
        expect(texto(tarde)).toContain('Buenas tardes');
        expect(texto(noche)).toContain('Buenas noches');
    });

    test('el nombre del negocio va en negrita de WhatsApp: un asterisco, no dos', async () => {
        const manejar = crearManejadorDeterminista({
            gate: gateCompleto(),
            contextoNegocio: NEGOCIO_FALSO,
            identidad: identidadFalsa(),
        });
        const d = await manejar(entrada('hola', conversacion()));

        expect(texto(d)).toContain('*Barbería Don Nico*');
        expect(texto(d)).not.toContain('**Barbería Don Nico**');
    });

    test('sin nombre de negocio dice una frase, nunca "null"', async () => {
        const manejar = crearManejadorDeterminista({
            gate: gateCompleto(),
            contextoNegocio: NEGOCIO_ANONIMO,
            identidad: identidadFalsa(),
        });
        const d = await manejar(entrada('hola', conversacion()));

        expect(texto(d)).not.toMatch(/null|undefined/);
        expect(texto(d)).toContain('el negocio');
    });

    test('volver al menú a mitad de una tarea NO vuelve a saludar', async () => {
        // Repetir «¡Buenas tardes! Te saluda…» a quien lleva cinco turnos hablando suena a que
        // el bot se olvidó de él.
        const manejar = crearManejadorDeterminista({
            gate: gateCompleto(),
            contextoNegocio: NEGOCIO_FALSO,
            identidad: identidadFalsa(),
        });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.FECHA, id_servicio: 1, ofrecidos: SERVICIOS_OFRECIDOS },
        });
        const d = await manejar(entrada('menu', conv));

        expect(texto(d)).not.toContain('Te saluda');
        expect(d.respuestas[0].opciones).toHaveLength(2); // pero sí reofrece el menú
    });
});

// ── Lo hostil ───────────────────────────────────────────────────────────────────────────

describe('el hold caduca mientras el cliente decide', () => {
    test('no es un error: vuelve a ofrecer horas sin perder la tarea', async () => {
        const caducado = Object.assign(new Error('Esa hora ya no está apartada'), {
            code: 'HOLD_NO_VIGENTE',
        });
        const gate = gateFalso({ reservar_turno: caducado });
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

        const datos = {
            paso: pasoActual,
            id_servicio: 1,
            fecha: '2026-08-20',
            codigo_hold: 'H',
            nombre: 'Ana',
            ofrecidos: SERVICIOS_OFRECIDOS,
        };
        const d = await manejar(entrada(texto, conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.pasos[0].decision).toBe('entrada_no_entendida');
        expect(d.tarea.datos.paso).toBe(pasoActual); // no avanza ni retrocede
    });

    test('un nombre de una sola letra no se acepta', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const datos = { paso: PASO.NOMBRE, id_servicio: 1, fecha: '2026-08-20', hora: '10:00' };
        const d = await manejar(entrada('x', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.tarea.datos.paso).toBe(PASO.NOMBRE);
    });

    test('un día sin horas libres devuelve al paso de fecha, no cierra la tarea', async () => {
        const gate = gateFalso({
            consultar_disponibilidad: { fecha: '2026-08-20', horas: [] },
            consultar_servicios: SERVICIOS,
        });
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

        const datos = { paso: PASO.FECHA, id_servicio: 1 };
        const d = await manejar(entrada('2026-08-20', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.pasos[0].decision).toBe('sin_disponibilidad');
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
    });
});

describe('salir y volver', () => {
    test('cancelar manda en cualquier paso y cierra la tarea', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

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
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const datos = { paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' };
        const d = await manejar(entrada('seguimos', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.tarea.datos).toMatchObject(datos);
        expect(d.respuestas[0]).toMatch(/horas libres/i);
    });

    test('una tarea con un paso desconocido vuelve al menú en vez de reventar', async () => {
        // Pasa al desplegar una FSM nueva con conversaciones vivas a medias.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }) });

        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        await manejar(entrada('sí', conversacion({ tarea: TAREA_AGENDAR, datos }), { id_turno: 'turno-42' }));

        expect(gate.llamadas[0].claveIdempotencia).toBe('turno-42');
    });

    test('ningún turno invoca dos veces la misma capacidad', async () => {
        // Es la regla que hace segura la clave = id del turno: el Gate guarda por
        // (negocio, capacidad, clave), así que repetir capacidad dentro de un turno haría
        // que la segunda llamada recibiera el resultado de la primera.
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }) });

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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }) });

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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }) });

        const datos = { paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' };
        await manejar(entrada('10:00', conversacion({ tarea: TAREA_AGENDAR, datos })));

        const propuesta = gate.llamadas.find((l) => l.capacidad === 'proponer_turno');
        expect(propuesta.args).not.toHaveProperty('id_profesional');
    });

    test('toda invocación lleva el Principal y el negocio de la conversación', async () => {
        const gate = gateCompleto();
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        const d = await manejar(entrada('sí\nsí\nsí', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.pasos[0].decision).toBe('cita_creada');
    });

    test('manda la ÚLTIMA línea, que es la intención actual', async () => {
        // «cancelar… no, espera» no debe cancelar: si valiera cualquier línea, sí lo haría.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.CONFIRMAR, codigo_hold: 'H', nombre: 'Ana', fecha: '2026-08-20', hora: '10:00' } });
        const d = await manejar(entrada('cancelar\nno, espera\nsí', conv));

        expect(d.pasos[0].decision).toBe('cita_creada');
    });

    test('un cambio de opinión en la ráfaga elige lo último', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.SERVICIO, ofrecidos: SERVICIOS_OFRECIDOS },
        });
        const d = await manejar(entrada('1\nmejor 2', conv));

        expect(d.tarea.datos.id_servicio).toBe(2);
    });

    test('pulsar un chip manda el id, no la etiqueta con su "(30 min)"', async () => {
        // La regresión que rompió el agendamiento desde el navegador: el widget mandaba la
        // etiqueta y el motor sacaba «el primer número», así que «Corte de cabello (30 min) —
        // $35.000» se leía como el servicio 30. La conversación seguía y solo fallaba tres
        // pasos después, sin horas libres ningún día.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.SERVICIO, ofrecidos: SERVICIOS_OFRECIDOS },
        });

        // Lo que manda el chip arreglado.
        const porId = await manejar(entrada('1', conv));
        expect(porId.tarea.datos.id_servicio).toBe(1);

        // Y aunque llegue la etiqueta entera, manda el NOMBRE, nunca el 30 de «(30 min)».
        const porEtiqueta = await manejar(entrada('Corte de cabello (30 min) — $35.000', conv));
        expect(porEtiqueta.tarea.datos.id_servicio).toBe(1);
    });

    test('un nombre partido en dos mensajes se une, no se recorta', async () => {
        // La excepción a la regla: «Nicolás\nPaez» son dos trozos de UN nombre, no dos
        // intenciones distintas.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
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
            contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa(),
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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

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
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });

        await expect(manejar(entrada('hola', conversacion()))).rejects.toThrow(/la base se cayó/);
    });

    test('sin invocaciones no ensucia la decisión con un array vacío', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO } });
        const d = await manejar(entrada('cancelar', conv));

        expect(d.invocaciones).toBeUndefined();
    });
});

describe('memoria de conversación', () => {
    test('las variables se devuelven completas, porque reemplazan y no fusionan', async () => {
        // Si una rama devolviera solo lo que cambia, el resto se perdería en silencio. Este
        // test recorre el paso donde es más fácil olvidarlo.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
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
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const datos = { paso: PASO.CONFIRMAR, fecha: '2026-08-20', hora: '10:00', codigo_hold: 'H', nombre: 'Ana' };
        const d = await manejar(entrada('sí', conversacion({ tarea: TAREA_AGENDAR, datos })));

        expect(d.variables.ultima_cita).toBe('CITA-999');
    });
});

describe('presentación (ADR-017)', () => {
    test('los menús van en opciones, nunca numerados dentro del texto', async () => {
        // Cada canal pinta las opciones como sabe: chips en WebChat, botones en WhatsApp, y
        // la voz las enumera. Un «1) Corte 2) Tinte» escrito en el texto rompe los tres.
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const d = await manejar(entrada('hola', conversacion()));

        expect(d.respuestas[0].opciones).toBeDefined();
        expect(d.respuestas[0].texto).not.toMatch(/^\s*\d\s*[).-]/m);
        expect(d.respuestas[0].texto).not.toContain('1)');
    });

    test('marca el nivel como determinista, que es lo que mide el coste en el Ledger', async () => {
        const manejar = crearManejadorDeterminista({ gate: gateCompleto(), contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const d = await manejar(entrada('hola', conversacion()));

        expect(d.nivel).toBe('determinista');
    });

    test('sin servicios activos lo dice y no abre tarea', async () => {
        const gate = gateFalso({ consultar_servicios: { servicios: [] } });
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
        const d = await manejar(entrada('hola', conversacion()));

        expect(d.tarea).toBeNull();
        expect(d.resultado).toBe('sin_respuesta');
    });
});


// ── Elegir profesional ──────────────────────────────────────────────────────────────────

describe('elegir profesional (2026-08-24)', () => {
    const conPaso = (datos) =>
        conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.PROFESIONAL, id_servicio: 1, profesionales_ofrecidos: PROFESIONALES_OFRECIDOS, ...datos },
        });

    function manejador(gate) {
        return crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
    }

    test('«me da igual» es la PRIMERA opción del menú', async () => {
        // No es cosmética: la mayoría no tiene preferencia, y para esa mayoría el paso es
        // fricción. Si la salida rápida deja de ser la primera —la que se pulsa sin leer—,
        // el menú empeora el flujo para casi todos con tal de mejorarlo para unos pocos.
        const gate = gateCompleto();
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: {
                paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20',
                profesional_por_hora: { '10:00': 4 }, libres_por_hora: { '10:00': [4, 5] },
            },
        });
        const d = await crearManejadorDeterminista({
            gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }),
        })(entrada('10:00', conv));

        const opciones = d.respuestas[0].opciones;
        expect(opciones[0]).toMatchObject({ id: 'cualquiera', etiqueta: 'Me da igual' });
        // La salida para volver va al FINAL: retroceder es la excepción, elegir es la norma.
        expect(opciones.map((o) => o.etiqueta)).toEqual([
            'Me da igual',
            'Laura Gómez',
            'Marco Ruiz',
            '← Otra hora',
        ]);
    });

    test('solo se ofrece a quien tiene libre la hora elegida', async () => {
        // Marco no está libre a las 09:00: ofrecerlo terminaría en «esa hora ya no está».
        const gate = gateCompleto();
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: {
                paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20',
                profesional_por_hora: { '09:00': 4, '10:00': 4 },
                libres_por_hora: { '09:00': [4], '10:00': [4, 5] },
            },
        });
        const d = await crearManejadorDeterminista({
            gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }),
        })(entrada('09:00', conv));

        // Con una sola persona libre no se pregunta: se aparta con ella.
        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        const propuesta = gate.llamadas.find((l) => l.capacidad === 'proponer_turno');
        expect(propuesta.args.id_profesional).toBe(4);
    });

    test('«me da igual» aparta con quien ofreció la hora', async () => {
        const gate = gateCompleto();
        const d = await manejador(gate)(entrada('me da igual', conPaso({
            fecha: '2026-08-20', hora: '10:00', nombre: 'Ana',
            profesional_por_hora: { '10:00': 4 }, libres_por_hora: { '10:00': [4, 5] },
        })));

        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(gate.llamadas.find((l) => l.capacidad === 'proponer_turno').args.id_profesional).toBe(4);
    });

    test('con UN solo profesional no se pregunta: se salta al día', async () => {
        // Un menú de una opción es pedirle a alguien que confirme lo inevitable.
        const gate = gateFalso({
            consultar_servicios: SERVICIOS,
            consultar_profesionales: UN_SOLO_PROFESIONAL,
            consultar_disponibilidad: DISPONIBILIDAD,
        });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO, ofrecidos: SERVICIOS_OFRECIDOS } });
        const d = await manejador(gate)(entrada('1', conv));

        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
        expect(d.respuestas[0].texto).toMatch(/qué día/i);
        // Y no se guarda a nadie: dejar la disponibilidad sin filtrar da el mismo resultado
        // —solo hay uno— sin afirmar una elección que el cliente nunca hizo.
        expect(d.tarea.datos.id_profesional_preferido).toBeUndefined();
    });

    test('sin profesionales tampoco se pregunta: el problema se explica en el paso de horas', async () => {
        const gate = gateFalso({
            consultar_servicios: SERVICIOS,
            consultar_profesionales: { profesionales: [] },
            consultar_disponibilidad: { fecha: '2026-08-20', horas: [] },
        });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO, ofrecidos: SERVICIOS_OFRECIDOS } });
        const d = await manejador(gate)(entrada('1', conv));

        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
    });

    test('elegir a alguien FILTRA la disponibilidad por esa persona', async () => {
        // Es el efecto que hace que el menú signifique algo. Sin esto, elegir a Marco daría
        // las horas de todos y el cliente acabaría con quien no pidió.
        const gate = gateCompleto();
        const manejar = manejador(gate);

        let d = await manejar(entrada('Marco', conPaso()));
        expect(d.tarea.datos.id_profesional_preferido).toBe(5);

        d = await manejar(entrada('2026-08-20', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));
        const disponibilidad = gate.llamadas.find((l) => l.capacidad === 'consultar_disponibilidad');
        expect(disponibilidad.args.id_profesional).toBe(5);
    });

    test('«me da igual» NO manda filtro, en vez de mandarlo en null', async () => {
        const gate = gateCompleto();
        const manejar = manejador(gate);

        let d = await manejar(entrada('cualquiera', conPaso()));
        d = await manejar(entrada('2026-08-20', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));

        const disponibilidad = gate.llamadas.find((l) => l.capacidad === 'consultar_disponibilidad');
        expect('id_profesional' in disponibilidad.args).toBe(false);
    });

    test('se le reconoce por el nombre de pila, que es como escribe la gente', async () => {
        const d = await manejador(gateCompleto())(entrada('con laura porfa', conPaso()));
        expect(d.tarea.datos.id_profesional_preferido).toBe(4);
    });

    test('si no se entiende, repregunta en vez de elegir por su cuenta', async () => {
        const d = await manejador(gateCompleto())(entrada('el mejor que tengan', conPaso()));
        expect(d.tarea.datos.paso).toBe(PASO.PROFESIONAL);
        expect(d.respuestas[0]).toMatch(/con quién|me da igual/i);
    });

    test('una conversación abierta antes de que esto existiera vuelve a ver el menú', async () => {
        // `tarea_datos` está persistido y no se migra solo: sin la lista guardada no se puede
        // resolver sin adivinar, así que se reofrece el menú, que la repuebla.
        const d = await manejador(gateCompleto())(entrada('Laura', conPaso({
            profesionales_ofrecidos: undefined,
            fecha: '2026-08-20', hora: '10:00', nombre: 'Ana', libres_por_hora: { '10:00': [4, 5] },
        })));
        expect(d.tarea.datos.paso).toBe(PASO.PROFESIONAL);
        expect(d.tarea.datos.profesionales_ofrecidos).toHaveLength(2);
    });
});


// ── Retroceder ──────────────────────────────────────────────────────────────────────────

describe('retroceder sin empezar de cero (2026-08-24)', () => {
    function manejador(gate) {
        return crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
    }

    /** Una tarea con TODO elegido: es lo que permite ver qué sobrevive y qué no. */
    const todoElegido = (paso) =>
        conversacion({
            tarea: TAREA_AGENDAR,
            datos: {
                paso,
                id_servicio: 1,
                id_profesional_preferido: 5,
                profesionales_ofrecidos: PROFESIONALES_OFRECIDOS,
                fecha: '2026-08-20',
                hora: '10:00',
                profesional_por_hora: { '10:00': 5 },
                libres_por_hora: { '10:00': [4, 5] },
                codigo_hold: 'HOLD-ABC',
                nombre: 'Ana',
            },
        });

    test('cambiar de servicio olvida TODO lo que venía después', async () => {
        // Un servicio de 3 h y otro de 15 min no comparten ni la hora ni a quien lo presta.
        // Conservar algo de eso es guardarse una selección imposible que no falla hasta el
        // último paso.
        const d = await manejador(gateCompleto())(entrada('quiero cambiar de servicio', todoElegido(PASO.HORA)));

        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        for (const clave of ['id_servicio', 'id_profesional_preferido', 'fecha', 'hora', 'codigo_hold']) {
            expect(d.tarea.datos[clave]).toBeUndefined();
        }
    });

    test('cambiar de profesional conserva día y hora, y ofrece a quien la tiene libre', async () => {
        // Desde 2026-09-29 la persona se elige DESPUÉS de la hora: cambiarla no mueve la cita.
        const d = await manejador(gateCompleto())(entrada('con otra persona', todoElegido(PASO.CONFIRMAR)));

        expect(d.tarea.datos.paso).toBe(PASO.PROFESIONAL);
        expect(d.tarea.datos).toMatchObject({ id_servicio: 1, fecha: '2026-08-20', hora: '10:00' });
        // El hold de la persona anterior no se arrastra: se toma otro al elegir.
        expect(d.tarea.datos.codigo_hold).toBeUndefined();
    });

    test('cambiar de día conserva el servicio y tira la hora', async () => {
        const d = await manejador(gateCompleto())(entrada('otro día', todoElegido(PASO.HORA)));

        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
        expect(d.tarea.datos.id_servicio).toBe(1);
        expect(d.tarea.datos.hora).toBeUndefined();
        expect(d.tarea.datos.codigo_hold).toBeUndefined();
    });

    test('rechazar la confirmación vuelve a las horas de ESE día, sin repreguntar la fecha', async () => {
        // Antes mandaba al paso de fecha: «Ver otras horas» prometía horas y pedía teclear el
        // día otra vez, un paso de castigo por cambiar de opinión.
        const d = await manejador(gateCompleto())(entrada('no', todoElegido(PASO.CONFIRMAR)));

        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        expect(d.tarea.datos.fecha).toBe('2026-08-20');
        // Desde 2026-09-29 la fecha se escribe como la dice una persona, no como la guarda la base.
        expect(d.respuestas[0].texto).toMatch(/horas libres el jueves 20 de agosto/);
        expect(d.tarea.datos.codigo_hold).toBeUndefined();
    });

    test('el menú de horas ofrece volver, y el chip funciona igual que el texto', async () => {
        const d = await manejador(gateCompleto())(entrada('volver_fecha', todoElegido(PASO.HORA)));
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
    });

    test('«cambiar» a secas en el paso de confirmar sigue siendo «otras horas», no un retroceso', async () => {
        // COMANDO.NO incluye «cambiar». Si el detector de retroceso se quedara con esa palabra
        // suelta, robaría el «no» del paso de confirmar. Por eso exige un destino además de la
        // pista de cambio.
        const d = await manejador(gateCompleto())(entrada('cambiar', todoElegido(PASO.CONFIRMAR)));
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
    });

    test('elegir un servicio NO se lee como retroceso estando en el menú de servicios', async () => {
        // El falso positivo que más caro saldría: quedarse en bucle en el primer paso.
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO, ofrecidos: SERVICIOS_OFRECIDOS } });
        const d = await manejador(gateCompleto())(entrada('Corte', conv));
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
        expect(d.tarea.datos.id_servicio).toBe(1);
    });

    test('pedir el paso en el que ya se está no hace nada raro', async () => {
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.FECHA, id_servicio: 1 } });
        const d = await manejador(gateCompleto())(entrada('otro día', conv));
        // Se queda pidiendo la fecha, que es lo que ya hacía: no se reinicia la tarea.
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
        expect(d.tarea.datos.id_servicio).toBe(1);
    });

    test('volver a las horas sin día guardado pide la fecha en vez de romperse', async () => {
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.NOMBRE, id_servicio: 1 } });
        const d = await manejador(gateCompleto())(entrada('otra hora', conv));
        expect(d.tarea.datos.paso).toBe(PASO.FECHA);
    });

    test('un día vacío con profesional elegido ofrece cambiar de persona', async () => {
        const gate = gateFalso({
            consultar_servicios: SERVICIOS,
            consultar_profesionales: PROFESIONALES,
            consultar_disponibilidad: { fecha: '2026-08-20', horas: [] },
        });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.FECHA, id_servicio: 1, id_profesional_preferido: 5 },
        });
        const d = await manejador(gate)(entrada('2026-08-20', conv));

        expect(d.respuestas[0].texto).toMatch(/con quien elegiste/i);
        expect(d.respuestas[0].opciones.map((o) => o.id)).toContain('volver_profesional');
    });

    test('un día vacío SIN profesional elegido no ofrece cambiar de persona', async () => {
        // Sería una opción que no lleva a ninguna parte: no había preferencia que cambiar.
        const gate = gateFalso({
            consultar_servicios: SERVICIOS,
            consultar_profesionales: PROFESIONALES,
            consultar_disponibilidad: { fecha: '2026-08-20', horas: [] },
        });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.FECHA, id_servicio: 1 } });
        const d = await manejador(gate)(entrada('2026-08-20', conv));

        expect(d.respuestas[0].opciones.map((o) => o.id)).not.toContain('volver_profesional');
    });
});


// ── Catálogo largo: primero el tipo, después el servicio (2026-09-29) ───────────────────

describe('catálogo largo en categorías', () => {
    const CABELLO = { id_categoria: 10, nombre: 'Cabello', orden: 0 };
    const UNAS = { id_categoria: 20, nombre: 'Uñas', orden: 1 };

    /** 12 servicios: 9 de cabello, 2 de uñas y uno sin categoría. */
    const CATALOGO = {
        servicios: [
            ...Array.from({ length: 9 }, (_, i) => ({
                id_servicio: 100 + i, nombre: `Cabello ${i + 1}`, duracion_min: 30, precio: 20000, categoria: CABELLO,
            })),
            { id_servicio: 200, nombre: 'Manicure', duracion_min: 40, precio: 25000, categoria: UNAS },
            { id_servicio: 201, nombre: 'Pedicure', duracion_min: 50, precio: 30000, categoria: UNAS },
            { id_servicio: 300, nombre: 'Masaje', duracion_min: 60, precio: 80000, categoria: null },
        ],
    };

    function manejador(gate) {
        return crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() });
    }
    const gateCatalogo = () => gateFalso({
        consultar_servicios: CATALOGO,
        consultar_profesionales: PROFESIONALES,
        consultar_disponibilidad: DISPONIBILIDAD,
    });

    /** 28 servicios: 25 de cabello, 2 de uñas y uno sin categoría. Ni enumerado se lee. */
    const CATALOGO_ENORME = {
        servicios: [
            ...Array.from({ length: 25 }, (_, i) => ({
                id_servicio: 100 + i, nombre: `Cabello ${i + 1}`, duracion_min: 30, precio: 20000, categoria: CABELLO,
            })),
            { id_servicio: 200, nombre: 'Manicure', duracion_min: 40, precio: 25000, categoria: UNAS },
            { id_servicio: 201, nombre: 'Pedicure', duracion_min: 50, precio: 30000, categoria: UNAS },
            { id_servicio: 300, nombre: 'Masaje', duracion_min: 60, precio: 80000, categoria: null },
        ],
    };
    const gateEnorme = () => gateFalso({
        consultar_servicios: CATALOGO_ENORME,
        consultar_profesionales: PROFESIONALES,
        consultar_disponibilidad: DISPONIBILIDAD,
    });

    test('12 servicios caben enumerados en UN mensaje: no se pregunta el tipo', async () => {
        const d = await manejador(gateCatalogo())(entrada('buenas, qué precios manejan?', conversacion()));

        // Antes esto preguntaba la categoría y costaba un mensaje de más para llegar al mismo
        // sitio. Enumerado, el cliente ve el catálogo entero con precios de una sola vez.
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/Te saluda \*Barbería Don Nico\*/);
        expect(d.respuestas[0].texto).toMatch(/Respóndeme con el número/);
        const opciones = d.respuestas[0].opciones;
        expect(opciones).toHaveLength(12);
        expect(opciones.map((o) => o.atajo)).toEqual(
            ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
        );
        expect(d.tarea.datos).toMatchObject({ enumerado: true, atajos_de: PASO.SERVICIO });
    });

    test('el número de un listado de servicios elige ese servicio', async () => {
        const manejar = manejador(gateCatalogo());
        const d0 = await manejar(entrada('hola', conversacion()));
        // El décimo del catálogo es Manicure (200).
        const d = await manejar(entrada('10', conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos })));

        expect(d.tarea.datos).toMatchObject({ id_servicio: 200, servicio_nombre: 'Manicure' });
    });

    test('un número que no está en el listado se repregunta, no se inventa', async () => {
        const manejar = manejador(gateCatalogo());
        const d0 = await manejar(entrada('hola', conversacion()));
        const d = await manejar(entrada('99', conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos })));

        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.pasos.some((p) => p.decision === 'entrada_no_entendida')).toBe(true);
    });

    test('la numeración no sobrevive al paso que la ofreció', async () => {
        const manejar = manejador(gateCatalogo());
        const d0 = await manejar(entrada('hola', conversacion()));
        const d1 = await manejar(entrada('10', conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos })));

        // Se avanzó al paso de la fecha arrastrando `atajos` del menú de servicios. Un «3» aquí
        // es el día 3, nunca el tercer servicio de un menú de hace dos mensajes.
        expect(d1.tarea.datos.paso).toBe(PASO.FECHA);
        expect(d1.tarea.datos.atajos_de).not.toBe(PASO.FECHA);
    });

    test('28 servicios sí se agrupan: el primer mensaje enseña los TIPOS', async () => {
        const d = await manejador(gateEnorme())(entrada('buenas, qué precios manejan?', conversacion()));

        expect(d.tarea.datos.paso).toBe(PASO.CATEGORIA);
        expect(d.respuestas[0].opciones.map((o) => o.etiqueta)).toEqual(['Cabello', 'Uñas', 'Otros']);
        expect(d.respuestas[0].opciones[1].detalle).toBe('2 servicios');
    });

    test('elegir un tipo enseña solo sus servicios, con «Otro tipo» para volver', async () => {
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.CATEGORIA, categorias_ofrecidas: [{ id: 'cat_10', nombre: 'Cabello' }, { id: 'cat_20', nombre: 'Uñas' }] },
        });
        const d = await manejador(gateEnorme())(entrada('cat_20', conv));

        expect(d.tarea.datos).toMatchObject({ paso: PASO.SERVICIO, categoria: 'cat_20' });
        const opciones = d.respuestas[0].opciones;
        expect(opciones.map((o) => o.id)).toEqual(['200', '201', 'volver_categoria']);
        expect(opciones[2]).toMatchObject({ etiqueta: '← Otro tipo', detalle: 'Elegir otro tipo de servicio' });
    });

    test('«Otro tipo» vuelve al menú de tipos', async () => {
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.SERVICIO, categoria: 'cat_20', ofrecidos: [{ id: 200, nombre: 'Manicure' }] },
        });
        const d = await manejador(gateEnorme())(entrada('volver_categoria', conv));
        expect(d.tarea.datos.paso).toBe(PASO.CATEGORIA);

        // Y escrito a mano también.
        const e = await manejador(gateEnorme())(entrada('elegir otro tipo de servicio', conv));
        expect(e.tarea.datos.paso).toBe(PASO.CATEGORIA);
    });

    test('una categoría que no cabe ni enumerada se pagina con «Ver más»', async () => {
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.CATEGORIA, categorias_ofrecidas: [{ id: 'cat_10', nombre: 'Cabello' }] },
        });
        let d = await manejador(gateEnorme())(entrada('Cabello', conv));
        let ids = d.respuestas[0].opciones.map((o) => o.id);
        // 8 servicios + Ver más + Otro tipo = 10 filas, el máximo de una lista de WhatsApp.
        expect(ids).toHaveLength(10);
        expect(ids.slice(-2)).toEqual(['mas_servicios', 'volver_categoria']);

        d = await manejador(gateEnorme())(entrada('mas_servicios', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));
        ids = d.respuestas[0].opciones.map((o) => o.id);
        expect(ids.slice(0, 8)).toEqual(['108', '109', '110', '111', '112', '113', '114', '115']);
    });

    test('con pocos servicios la lista es pulsable, sin numerar', async () => {
        const gate = gateFalso({
            consultar_servicios: { servicios: CATALOGO.servicios.slice(8) },
        });
        const d = await manejador(gate)(entrada('hola', conversacion()));
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.respuestas[0].opciones.map((o) => o.id)).not.toContain('volver_categoria');
        expect(d.respuestas[0].opciones.every((o) => o.atajo === undefined)).toBe(true);
        expect(d.tarea.datos.enumerado).toBe(false);
    });
});

describe('«¿qué citas tengo?» se contesta gratis, en el Nivel 1', () => {
    const CITAS = { citas: [
        { codigo_cita: 'CITA-1', inicio: '2026-10-06T10:00:00', fin: '2026-10-06T10:30:00',
          estado: 'confirmada', servicio: 'Corte de cabello', profesional: 'Dilan Torres' },
        { codigo_cita: 'CITA-2', inicio: '2026-10-20T16:30:00', fin: '2026-10-20T17:15:00',
          estado: 'pendiente', servicio: 'Corte y barba', profesional: null },
    ]};
    const manejar = (respuesta) => crearManejadorDeterminista({
        gate: gateFalso({ consultar_mis_citas: respuesta, consultar_servicios: SERVICIOS }),
        contextoNegocio: NEGOCIO_FALSO,
        identidad: identidadFalsa({ nombre: 'Ana', telefono: '+573001112233' }),
    });

    test('las enseña por día y hora, nunca por código', async () => {
        const d = await manejar(CITAS)(entrada('qué citas tengo?', conversacion()));

        // Antes esto caía en «intencion_agendar» —la palabra «cita» está en las dos cosas— y el
        // cliente recibía el menú de servicios cuando preguntaba por la cita que ya tenía.
        expect(d.nivel).toBe('determinista');
        expect(d.respuestas).toHaveLength(1);
        const texto = typeof d.respuestas[0] === 'string' ? d.respuestas[0] : d.respuestas[0].texto;
        expect(texto).toMatch(/Tienes 2 citas/);
        expect(texto).toMatch(/martes 6 de octubre a las 10:00 AM/);
        expect(texto).toMatch(/Corte de cabello · con Dilan Torres/);
        expect(texto).toMatch(/martes 20 de octubre a las 4:30 PM/);
        // Un código no le dice nada a nadie y ocupa la línea que debería decir el día.
        expect(texto).not.toMatch(/CITA-1|CITA-2/);
    });

    test('el código queda a mano para cancelar, aunque no se diga', async () => {
        const d = await manejar(CITAS)(entrada('mis citas', conversacion()));
        expect(d.variables.ultima_cita).toBe('CITA-1');
    });

    test('sin citas próximas lo dice y ofrece agendar, en un solo mensaje', async () => {
        const d = await manejar({ citas: [] })(entrada('tengo alguna cita?', conversacion()));

        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/No veo ninguna cita próxima/);
        expect(d.respuestas[0].opciones).toHaveLength(1);
    });

    test('«no puedo comprobar tu número» no se confunde con «no tienes citas»', async () => {
        const d = await manejar({ citas: [], motivo: 'no puedo comprobar desde qué número escribes' })(
            entrada('mis citas', conversacion())
        );
        expect(d.respuestas[0].texto).toMatch(/No puedo ver tus citas ahora mismo/);
        expect(d.respuestas[0].texto).not.toMatch(/No veo ninguna/);
    });

    test('«quiero una cita» NO es una consulta: sigue siendo agendar', async () => {
        const d = await manejar(CITAS)(entrada('quiero una cita', conversacion()));
        expect(d.tarea?.datos.paso).toBe(PASO.SERVICIO);
    });

    test('«quiero reservar mi turno» es agendar; «quiero ver mis citas» es consultar', async () => {
        // Las dos frases tienen posesivo y palabra de cita. Lo que las separa es si además pide
        // algo nuevo o pregunta — y «quiero cancelar mi cita» pide las dos cosas, así que la lista
        // sigue siendo la respuesta útil.
        const agendar = await manejar(CITAS)(entrada('quiero reservar mi turno', conversacion()));
        expect(agendar.tarea?.datos.paso).toBe(PASO.SERVICIO);

        const consultar = await manejar(CITAS)(entrada('quiero ver mis citas', conversacion()));
        expect(consultar.pasos.some((p) => p.decision === 'mis_citas')).toBe(true);

        const anular = await manejar(CITAS)(entrada('quiero cancelar mi cita', conversacion()));
        expect(anular.pasos.some((p) => p.decision === 'mis_citas')).toBe(true);
    });

    test('«cambiar mi cita» tampoco: eso es un retroceso o una mutación', async () => {
        const d = await manejar(CITAS)(entrada('quiero cambiar mi cita', conversacion()));
        expect(d.pasos.some((p) => p.decision === 'mis_citas')).toBe(false);
    });

    test('a mitad de un agendamiento, «mi cita» es la que se está armando', async () => {
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.NOMBRE, id_servicio: 1, fecha: '2026-08-20', hora: '10:00' },
        });
        const d = await manejar(CITAS)(entrada('a nombre de mi cita', conv));
        expect(d.pasos.some((p) => p.decision === 'mis_citas')).toBe(false);
    });
});

describe('el atajo: usar lo que el cliente ya escribió', () => {
    const CATALOGO_BARBERIA = {
        servicios: [
            { id_servicio: 1, nombre: 'Corte de cabello', duracion_min: 30, precio: 35000 },
            { id_servicio: 2, nombre: 'Corte y barba', duracion_min: 45, precio: 50000 },
            { id_servicio: 3, nombre: 'Arreglo de barba', duracion_min: 20, precio: 22000 },
            { id_servicio: 4, nombre: 'Tinte', duracion_min: 90, precio: 120000 },
        ],
    };
    const ahora = () => new Date('2026-08-19T10:00:00-05:00'); // un miércoles
    const gateAtajo = () => gateFalso({
        consultar_servicios: CATALOGO_BARBERIA,
        consultar_dias_con_horas: { dias: [{ fecha: '2026-08-20', primera_hora: '09:00' }] },
        consultar_disponibilidad: DISPONIBILIDAD,
        consultar_profesionales: UN_SOLO_PROFESIONAL,
        proponer_turno: HOLD,
    });
    const manejar = (gate, identidad = identidadFalsa({ nombre: 'Ana' })) =>
        crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad, ahora });

    test('servicio + día + hora en un mensaje llegan directos al resumen', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(
            entrada('hola, quiero un corte de cabello mañana a las 10 am', conversacion())
        );

        // Antes esto contestaba el menú de servicios y hacían falta cinco mensajes más.
        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/Te saluda \*Barbería Don Nico\*/);
        expect(d.respuestas[0].texto).toMatch(/Anoto \*Corte de cabello\*/);
        expect(d.respuestas[0].texto).toMatch(/Estos son los datos de tu cita/);
        expect(gate.llamadas.find((l) => l.capacidad === 'proponer_turno').args.inicio)
            .toBe('2026-08-20T10:00:00');
    });

    test('solo el servicio: se salta el menú y pregunta el día', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('quiero agendar un tinte', conversacion()));

        expect(d.tarea.datos).toMatchObject({ paso: PASO.FECHA, id_servicio: 4 });
        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/Anoto \*Tinte\*/);
        expect(d.respuestas[0].texto).toMatch(/Qué día te queda bien/);
    });

    test('el nombre más largo gana: «corte y barba» no es «corte de cabello»', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('me hago corte y barba', conversacion()));
        expect(d.tarea.datos.id_servicio).toBe(2);
    });

    test('palabras sueltas en otro orden también valen', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('necesito arreglo barba', conversacion()));
        expect(d.tarea.datos.id_servicio).toBe(3);
    });

    test('ambiguo o vago: el menú de siempre, y sin pedir el catálogo dos veces', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('quiero un corte', conversacion()));

        // «corte» está en dos servicios: elegir uno sería decidir por el cliente.
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.respuestas[0].opciones).toHaveLength(4);
        expect(gate.llamadas.filter((l) => l.capacidad === 'consultar_servicios')).toHaveLength(1);
    });

    test('un número suelto NO es una fecha fuera del paso de la fecha', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('quiero el tinte, para 2 personas', conversacion()));

        // Antes `interpretarFecha` leía el 2 como «el día 2» y agendaba un mes equivocado.
        expect(d.tarea.datos).toMatchObject({ paso: PASO.FECHA, id_servicio: 4 });
    });

    test('un saludo a secas no ataja nada: menú, como siempre', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('buenas tardes', conversacion()));
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
    });

    test('«menú» pedido a mano enseña la lista, aunque nombre un servicio', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(entrada('menu', conversacion()));
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);
        expect(d.respuestas[0].opciones).toHaveLength(4);
    });

    test('la hora pedida no está libre: se ofrecen las que sí, sin perder el servicio', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate)(
            entrada('un corte de cabello mañana a las 7 pm', conversacion())
        );

        expect(d.tarea.datos).toMatchObject({ paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20' });
        expect(d.respuestas[0].opciones.map((o) => o.etiqueta)).toContain('10:00 AM');
    });

    test('la frase entera vale TAMBIÉN contestando al menú (producción, 2026-10-02)', async () => {
        // Lo que se vio en el WhatsApp de D'ALEX: el cliente saludó dos veces —así que ya había
        // tarea abierta— y en el tercer mensaje escribió la frase completa. El flujo reconocía el
        // servicio y acto seguido le preguntaba el día que acababa de decir.
        const gate = gateAtajo();
        const manejar_ = manejar(gate);

        let d = await manejar_(entrada('Hola buenas tardes', conversacion()));
        expect(d.tarea.datos.paso).toBe(PASO.SERVICIO);

        d = await manejar_(entrada('Hola', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));
        d = await manejar_(entrada(
            'Quiero un corte de cabello para mañana a las 10 am',
            conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos }),
        ));

        // Ni una pregunta por el día: ya lo había dicho.
        expect(d.tarea.datos).toMatchObject({ id_servicio: 1, fecha: '2026-08-20', hora: '10:00' });
        expect(gate.llamadas.find((l) => l.capacidad === 'proponer_turno').args.inicio)
            .toBe('2026-08-20T10:00:00');
    });

    test('pulsar una fila sigue preguntando el día: un id suelto no es una fecha', async () => {
        // El seguro del caso de arriba. Un toque manda «1», y leerlo como «el día 1» agendaría
        // un mes equivocado sin que nadie lo note hasta el resumen.
        const gate = gateAtajo();
        const manejar_ = manejar(gate);
        const d0 = await manejar_(entrada('hola', conversacion()));
        const d = await manejar_(entrada('1', conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos })));

        expect(d.tarea.datos).toMatchObject({ paso: PASO.FECHA, id_servicio: 1 });
        expect(d.tarea.datos.fecha).toBeUndefined();
    });

    test('desde el menú de TIPOS, nombrar un servicio también se entiende', async () => {
        // Antes contestaba «elige uno de los tipos de la lista», que es castigar al cliente por
        // adelantarse. Solo se llega aquí con un catálogo tan grande que haya tipos.
        const muchos = Array.from({ length: 30 }, (_, i) => ({
            id_servicio: 500 + i, nombre: `Relleno ${i + 1}`, duracion_min: 30, precio: 10000,
            categoria: { id_categoria: 9, nombre: 'Otros', orden: 1 },
        }));
        const gate = gateFalso({
            consultar_servicios: { servicios: [...CATALOGO_BARBERIA.servicios.map((s) => ({
                ...s, categoria: { id_categoria: 1, nombre: 'Cortes', orden: 0 },
            })), ...muchos] },
            consultar_dias_con_horas: { dias: [{ fecha: '2026-08-20', primera_hora: '09:00' }] },
            consultar_disponibilidad: DISPONIBILIDAD,
            consultar_profesionales: UN_SOLO_PROFESIONAL,
            proponer_turno: HOLD,
        });
        const manejar_ = manejar(gate);

        const d0 = await manejar_(entrada('hola', conversacion()));
        expect(d0.tarea.datos.paso).toBe(PASO.CATEGORIA);

        const d = await manejar_(entrada(
            'quiero un tinte',
            conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos }),
        ));
        expect(d.tarea.datos.id_servicio).toBe(4);
    });

    test('un nombre de servicio con signos no revienta el atajo', async () => {
        // `new RegExp('\\b+')` no es un regex que no encuentre nada: es un SyntaxError que se
        // llevaría por delante el primer mensaje de cualquier negocio con un «+» en el catálogo.
        const gate = gateFalso({
            consultar_servicios: {
                servicios: [
                    { id_servicio: 9, nombre: 'Corte + barba (combo)', duracion_min: 45, precio: 50000 },
                    { id_servicio: 10, nombre: 'Manicure *premium*', duracion_min: 40, precio: 30000 },
                ],
            },
            consultar_dias_con_horas: { dias: [{ fecha: '2026-08-20', primera_hora: '09:00' }] },
        });
        const d = await manejar(gate)(entrada('quiero el combo', conversacion()));

        // No hace falta que acierte: hace falta que no se caiga y que el cliente reciba algo.
        expect(d.respuestas.length).toBeGreaterThan(0);
        expect([PASO.SERVICIO, PASO.FECHA]).toContain(d.tarea.datos.paso);
    });

    test('si falta el nombre, el atajo lo pide y no se inventa uno', async () => {
        const gate = gateAtajo();
        const d = await manejar(gate, identidadFalsa())(
            entrada('corte de cabello mañana a las 10 am', conversacion())
        );

        expect(d.tarea.datos).toMatchObject({ paso: PASO.NOMBRE, hora: '10:00' });
        expect(d.respuestas[0].texto).toMatch(/A nombre de quién/);
    });
});

describe('el nombre del perfil de WhatsApp', () => {
    const enLaHora = () => conversacion({
        tarea: TAREA_AGENDAR,
        datos: {
            paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20',
            profesional_por_hora: { '09:00': 4 }, libres_por_hora: { '09:00': [4] },
        },
    });
    const manejar = (gate) => crearManejadorDeterminista({
        gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa(),
    });

    test('no se pregunta el nombre si el canal ya lo trae', async () => {
        const gate = gateCompleto();
        const d = await manejar(gate)(entradaConPerfil('09:00', enLaHora(), 'Juan Pérez'));

        // Era un mensaje por cada cliente nuevo para preguntar algo que venía en el webhook.
        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(d.respuestas[0].texto).toMatch(/A nombre de:\* Juan Pérez/);
    });

    test('al venir del perfil se ofrece «Otro nombre», que no vuelve a apartar la hora', async () => {
        const gate = gateCompleto();
        const manejarlo = manejar(gate);
        let d = await manejarlo(entradaConPerfil('09:00', enLaHora(), 'Juan Pérez'));
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['si', 'no', 'otro_nombre']);
        // Y el nombre del perfil NO se guarda todavía: guardarlo le quitaría la corrección.
        expect(d.variables.nombre).toBeNull();

        d = await manejarlo(entrada('otro_nombre', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));
        expect(d.tarea.datos.paso).toBe(PASO.NOMBRE);

        const holdsAntes = gate.llamadas.filter((l) => l.capacidad === 'proponer_turno').length;
        d = await manejarlo(entrada('Juan Camilo', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));

        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(d.respuestas[0].texto).toMatch(/A nombre de:\* Juan Camilo/);
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['si', 'no']);
        expect(gate.llamadas.filter((l) => l.capacidad === 'proponer_turno')).toHaveLength(holdsAntes);
    });

    test('un nombre dicho antes manda sobre el del perfil, y no ofrece corregirlo', async () => {
        const gate = gateCompleto();
        const manejarlo = crearManejadorDeterminista({
            gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Nicolás' }),
        });
        const d = await manejarlo(entradaConPerfil('09:00', enLaHora(), 'Mamá'));

        expect(d.respuestas[0].texto).toMatch(/A nombre de:\* Nicolás/);
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['si', 'no']);
    });

    test('un perfil que no sirve como nombre se trata como si no hubiera', async () => {
        const gate = gateCompleto();
        const d = await manejar(gate)(entradaConPerfil('09:00', enLaHora(), '🔥'));

        expect(d.tarea.datos.paso).toBe(PASO.NOMBRE);
        expect(d.respuestas[0]).toMatch(/A nombre de quién/);
    });
});

describe('el aviso de consentimiento va DENTRO del resumen', () => {
    test('un servicio que pide consentimiento lo dice en el mismo mensaje', async () => {
        // Antes era un mensaje aparte delante del resumen. Dos mensajes cuestan dos y se leen
        // peor: el aviso llegaba suelto, sin la cita al lado a la que se refería.
        const gate = gateFalso({
            consultar_disponibilidad: DISPONIBILIDAD,
            consultar_profesionales: UN_SOLO_PROFESIONAL,
            proponer_turno: { ...HOLD, requiere_consentimiento: true },
        });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: {
                paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20',
                profesional_por_hora: { '09:00': 4 }, libres_por_hora: { '09:00': [4] },
            },
        });
        const d = await crearManejadorDeterminista({
            gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }),
        })(entrada('09:00', conv));

        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/firmarás un consentimiento/);
        expect(d.respuestas[0].texto).toMatch(/¿Confirmas la cita\?$/);
    });
});

describe('resumen final con Sí / No', () => {
    test('reúne todos los datos y ofrece exactamente «Sí» y «No»', async () => {
        const gate = gateCompleto();
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: {
                paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20',
                profesional_por_hora: { '10:00': 4 }, libres_por_hora: { '10:00': [4] },
            },
        });
        const d = await crearManejadorDeterminista({
            gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Nicolás' }),
        })(entrada('10:00', conv));

        const final = d.respuestas[d.respuestas.length - 1];
        expect(final.opciones).toEqual([{ id: 'si', etiqueta: 'Sí' }, { id: 'no', etiqueta: 'No' }]);
        for (const dato of ['Corte', 'Laura', 'jueves 20 de agosto', '10:00', '30 min', '$25.000', 'Nicolás']) {
            expect(final.texto).toContain(dato);
        }
        expect(final.texto).toMatch(/¿Confirmas la cita\?$/);
    });
});

// ── Producción 2026-09-29: el «Sí» que no contestaba ────────────────────────────────────

describe('un rechazo del dominio nunca deja al cliente sin respuesta', () => {
    const errorDominio = (code, message) => Object.assign(new Error(message), { code, statusCode: 400 });

    test('ANTICIPACION_INSUFICIENTE al confirmar: se explica y se ofrecen las horas de ese día', async () => {
        const gate = gateFalso({
            consultar_disponibilidad: DISPONIBILIDAD,
            reservar_turno: errorDominio('ANTICIPACION_INSUFICIENTE', 'Debe reservar con al menos 1h de anticipación'),
        });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.CONFIRMAR, id_servicio: 1, fecha: '2026-08-20', hora: '16:00', codigo_hold: 'H', nombre: 'Juanda' },
        });
        const d = await crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa() })(
            entrada('Sí', conv)
        );

        // El aviso y las horas van en UN mensaje, no en dos: se lee igual y Meta cobra uno.
        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/No pude agendar esa hora: debe reservar con al menos 1h/);
        expect(d.respuestas[0].texto).toMatch(/Estas son las horas libres/);
        expect(d.respuestas[0].opciones.length).toBeGreaterThan(0);
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        expect(d.tarea.datos.codigo_hold).toBeUndefined();
    });

    test('la hora se ocupó al apartar: se dice y se reofrecen horas', async () => {
        const gate = gateFalso({
            consultar_disponibilidad: DISPONIBILIDAD,
            proponer_turno: errorDominio('SLOT_NO_DISPONIBLE', 'Ocupado'),
        });
        const conv = conversacion({
            tarea: TAREA_AGENDAR,
            datos: { paso: PASO.HORA, id_servicio: 1, fecha: '2026-08-20', profesional_por_hora: { '10:00': 4 } },
        });
        const d = await crearManejadorDeterminista({
            gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }),
        })(entrada('10:00', conv));

        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).toMatch(/^No pude agendar esa hora: esa hora se acaba de ocupar./);
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
    });
});

describe('cómo se leen los días y las horas', () => {
    const ahora = () => new Date('2026-09-29T15:00:00-05:00');

    test('los días llevan el mes, y el de hoy dice «Hoy»', async () => {
        const gate = gateFalso({
            consultar_dias_con_horas: {
                dias: [
                    { fecha: '2026-09-29', primera_hora: '16:00' },
                    { fecha: '2026-09-30', primera_hora: '09:00' },
                    { fecha: '2026-10-01', primera_hora: '09:00' },
                ],
            },
        });
        const conv = conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.SERVICIO, ofrecidos: SERVICIOS_OFRECIDOS } });
        const d = await crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa(), ahora })(
            entrada('1', conv)
        );

        const opciones = d.respuestas[0].opciones;
        expect(opciones.map((o) => o.etiqueta)).toEqual(['Hoy', 'miércoles 30 septiembre', 'jueves 1 octubre']);
        expect(opciones[0].detalle).toBe('Martes 29 septiembre · desde las 4:00 PM');
        expect(opciones[1].detalle).toBe('Desde las 9:00 AM');
    });

    test('las horas se muestran en 12 h y se aceptan escritas así', async () => {
        const gate = gateFalso({
            consultar_disponibilidad: { fecha: '2026-08-20', horas: [{ hora: '09:00', id_profesional: 4 }, { hora: '16:30', id_profesional: 4 }] },
            proponer_turno: HOLD,
        });
        const manejar = crearManejadorDeterminista({ gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }) });

        let d = await manejar(entrada('2026-08-20', conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.FECHA, id_servicio: 1 } })));
        expect(d.respuestas[0].opciones.map((o) => [o.id, o.etiqueta])).toEqual([
            ['09:00', '9:00 AM'], ['16:30', '4:30 PM'], ['volver_fecha', '← Otro día'],
        ]);

        // El WebChat manda la etiqueta: «4:30 PM» son las 16:30, no las 04:30.
        d = await manejar(entrada('4:30 PM', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));
        expect(gate.llamadas.find((l) => l.capacidad === 'proponer_turno').args.inicio).toBe('2026-08-20T16:30:00');
        expect(d.respuestas[d.respuestas.length - 1].texto).toContain('• *Hora:* 4:30 PM');
    });
});

// ── Días con muchas horas: primero la jornada (2026-09-29) ───────────────────────────────

describe('días con más horas de las que caben en una lista', () => {
    const HORAS_DIA = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00',
        '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30']
        .map((hora) => ({ hora, id_profesional: 4, id_profesionales: [4] }));
    /** Un día de verdad lleno: de 8 a 20 cada media hora. 25 horas no se leen en un mensaje. */
    const HORAS_LLENO = Array.from({ length: 25 }, (_, i) => {
        const minutos = 8 * 60 + i * 30;
        const hora = `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${minutos % 60 === 0 ? '00' : '30'}`;
        return { hora, id_profesional: 4, id_profesionales: [4] };
    });
    const gateDia = () => gateFalso({
        consultar_disponibilidad: { fecha: '2026-10-10', horas: HORAS_DIA },
        proponer_turno: HOLD,
    });
    const gateLleno = () => gateFalso({
        consultar_disponibilidad: { fecha: '2026-10-10', horas: HORAS_LLENO },
        proponer_turno: HOLD,
    });
    const manejador = (gate) => crearManejadorDeterminista({
        gate, contextoNegocio: NEGOCIO_FALSO, identidad: identidadFalsa({ nombre: 'Ana' }),
    });
    const alDia = (datos = {}) => conversacion({
        tarea: TAREA_AGENDAR, datos: { paso: PASO.FECHA, id_servicio: 1, ...datos },
    });

    test('17 horas salen enumeradas en UN mensaje, sin preguntar la jornada', async () => {
        const d = await manejador(gateDia())(entrada('2026-10-10', alDia()));

        // El paso de la jornada era un mensaje entero para preguntar algo que el cliente no
        // pidió: él quiere una hora. Enumerarlas se lo ahorra y le enseña el día completo.
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        expect(d.respuestas).toHaveLength(1);
        const opciones = d.respuestas[0].opciones;
        expect(opciones.map((o) => o.id)).toEqual([...HORAS_DIA.map((h) => h.hora), 'volver_fecha']);
        expect(d.respuestas[0].texto).toMatch(/Hay 17 horas libres/);
        expect(d.respuestas[0].texto).toMatch(/Respóndeme con el número/);
        // Numeradas por el núcleo: el canal no inventa el número con el que vuelve la respuesta.
        expect(opciones[0].atajo).toBe('1');
        expect(opciones[16].atajo).toBe('17');
        expect(d.tarea.datos).toMatchObject({ enumerado: true, atajos_de: PASO.HORA });
    });

    test('el número de un listado de horas elige esa hora', async () => {
        const gate = gateDia();
        const manejar = manejador(gate);
        const d0 = await manejar(entrada('2026-10-10', alDia()));
        // La cuarta de la lista es 10:30.
        const d = await manejar(entrada('4', conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos })));

        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(gate.llamadas.find((l) => l.capacidad === 'proponer_turno').args.inicio)
            .toBe('2026-10-10T10:30:00');
    });

    test('un día entero (25 horas) sí pregunta la jornada: un listado así no se lee', async () => {
        const d = await manejador(gateLleno())(entrada('2026-10-10', alDia()));

        expect(d.tarea.datos.paso).toBe(PASO.FRANJA);
        const opciones = d.respuestas[0].opciones;
        expect(opciones.length).toBeLessThanOrEqual(10);
        expect(opciones[0].etiqueta).toBe('Mañana');
        expect(opciones[opciones.length - 1].etiqueta).toBe('← Otro día');
        const todas = d.tarea.datos.franjas_ofrecidas.flatMap((f) => f.horas);
        expect(todas).toEqual(HORAS_LLENO.map((h) => h.hora));
    });

    test('elegir la mañana enseña sus horas con «← Otra jornada»', async () => {
        const manejar = manejador(gateLleno());
        let d = await manejar(entrada('2026-10-10', alDia()));
        const manana = d.respuestas[0].opciones.find((o) => o.etiqueta === 'Mañana');
        d = await manejar(entrada(manana.id, conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));

        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        expect(d.respuestas[0].opciones.map((o) => o.etiqueta)).toEqual([
            '8:00 AM', '8:30 AM', '9:00 AM', '9:30 AM', '10:00 AM', '10:30 AM', '11:00 AM',
            '11:30 AM', '← Otra jornada',
        ]);
        // Y «Otra jornada» vuelve al menú de jornadas.
        d = await manejar(entrada('volver_franja', conversacion({ tarea: TAREA_AGENDAR, datos: d.tarea.datos })));
        expect(d.tarea.datos.paso).toBe(PASO.FRANJA);
    });

    test('escribir la hora en el paso de jornada se salta la jornada', async () => {
        const gate = gateLleno();
        const manejar = manejador(gate);
        const d0 = await manejar(entrada('2026-10-10', conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.FECHA, id_servicio: 1 } })));
        expect(d0.tarea.datos.paso).toBe(PASO.FRANJA);
        const d = await manejar(entrada('a las 3 pm', conversacion({ tarea: TAREA_AGENDAR, datos: d0.tarea.datos })));
        expect(d.tarea.datos.paso).toBe(PASO.CONFIRMAR);
        expect(gate.llamadas.find((l) => l.capacidad === 'proponer_turno').args.inicio).toBe('2026-10-10T15:00:00');
    });

    test('con 9 horas o menos se listan directamente, sin jornadas', async () => {
        const gate = gateFalso({ consultar_disponibilidad: { fecha: '2026-10-10', horas: HORAS_DIA.slice(0, 9) } });
        const d = await manejador(gate)(entrada('2026-10-10', conversacion({ tarea: TAREA_AGENDAR, datos: { paso: PASO.FECHA, id_servicio: 1 } })));
        expect(d.tarea.datos.paso).toBe(PASO.HORA);
        expect(d.respuestas[0].opciones).toHaveLength(10);
    });
});
