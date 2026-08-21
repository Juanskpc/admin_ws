/**
 * F7 — mutaciones vía IA con confirmación humana (ADR-010).
 *
 * Lo que hay que probar aquí no es que el camino feliz funcione: es que **el camino que se salta
 * la confirmación no exista**. Así que la mitad de esta suite intenta romperla — pedir la
 * mutación y no contestar, contestar otra cosa, dejar pasar el tiempo, decir «cancelar» cuando lo
 * que se estaba confirmando *era* una cancelación — y la otra mitad comprueba que el paso de la
 * pelota entre los dos niveles no pierde nada.
 *
 * Corre **sin Postgres**: el Gate se inyecta. El Gate de verdad se prueba contra la base en
 * `__tests__/platform/capacidades_mutaciones.test.js`, que es donde vive su setup.
 */
'use strict';

const confirmacion = require('../../intelligence/engine/confirmacion');
const { crearManejadorDeterminista, TAREA_AGENDAR } = require('../../intelligence/engine/manejadorDeterminista');
const { crearManejadorLlm } = require('../../intelligence/engine/manejadorLlm');
const { crearManejadorEscalera } = require('../../intelligence/engine/manejadorEscalera');
const puerto = require('../../intelligence/model/puerto');
const orquestador = require('../../intelligence/model/orquestador');
const intelligence = require('../../intelligence');
const registry = require('../../intelligence/core/registry');

// ── Dobles ──────────────────────────────────────────────────────────────────────────────

const NEGOCIO = { id: 7, nombre: 'Barbería Don Nico', tratamiento: 'Barbería Don Nico' };

const CATALOGO = [
    { nombre: 'consultar_servicios', tipo: 'consulta', requiere_confirmacion: false, parametros: {} },
    {
        nombre: 'proponer_turno',
        tipo: 'mutacion',
        requiere_confirmacion: false,
        parametros: { inicio: { tipo: 'string', requerido: true } },
    },
    {
        nombre: 'cancelar_cita',
        tipo: 'mutacion',
        requiere_confirmacion: true,
        parametros: { codigo_cita: { tipo: 'string', requerido: true } },
    },
].map((c) => ({ descripcion: `Capacidad de prueba: ${c.nombre}.`, vertical: 'reserva', ...c }));

/**
 * Gate de mentira que **hace cumplir la regla de F7**, igual que el de verdad.
 *
 * Es lo que hace que estos tests prueben algo: un doble permisivo dejaría pasar exactamente el
 * fallo que la suite existe para cazar.
 */
function gateFalso({ resultados = {}, errores = {} } = {}) {
    const llamadas = [];
    return {
        llamadas,
        async capacidadesDisponibles() {
            return CATALOGO;
        },
        async ejecutar(invocacion) {
            llamadas.push(invocacion);
            const exige = CATALOGO.find((c) => c.nombre === invocacion.capacidad)?.requiere_confirmacion;
            if (exige && !invocacion.confirmadoPor) {
                const e = new Error('Esa capacidad exige confirmación humana explícita.');
                e.code = 'CONFIRMACION_REQUERIDA';
                e.statusCode = 403;
                throw e;
            }
            if (errores[invocacion.capacidad]) throw errores[invocacion.capacidad];
            return {
                capacidad: invocacion.capacidad,
                vertical: 'reserva',
                resultado: resultados[invocacion.capacidad] ?? { ok: true },
            };
        },
    };
}

function adaptadorFalso(guion) {
    const peticiones = [];
    let i = 0;
    return {
        nombre: 'falso',
        modelos: ['claude-opus-5'],
        capacidades: { invocarCapacidades: true, cachePrefijo: true, esfuerzo: true },
        peticiones,
        async generar(peticion) {
            peticiones.push(peticion);
            const paso = guion[Math.min(i, guion.length - 1)];
            i += 1;
            return {
                uso: { tokensEntrada: 100, tokensSalida: 20, tokensCacheLectura: 0, tokensCacheEscritura: 0 },
                latenciaMs: 1,
                ...paso,
            };
        },
    };
}

const DEPS_LLM = {
    contextoNegocio: { obtener: async () => NEGOCIO },
    identidad: { resolver: async () => ({ principal: { tipo: 'contacto' }, nombre: null }) },
    repositorio: { historialReciente: async () => [] },
};

const IDENTIDAD_FSM = {
    async resolver() {
        return { principal: { tipo: 'contacto', puedeOperarEn: () => true }, persona: null, nombre: 'Nico', telefono: null };
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
    return { conversacion: conv, mensajes: [{ contenido: texto }], turno, texto, consumo: { costos: [] } };
}

/** El guion del modelo pidiendo cancelar. Dos respuestas: la petición y, si vuelve, prosa. */
const GUION_CANCELA = [
    {
        razonFin: puerto.FIN.CAPACIDADES,
        texto: '',
        invocacionesSolicitadas: [
            { id: 't1', capacidad: 'cancelar_cita', argumentos: { codigo_cita: 'CITA-999' } },
        ],
    },
    { razonFin: puerto.FIN.TURNO, texto: 'Ya la cancelé, listo.' },
];

const CANCELADA = { codigo_cita: 'CITA-999', estado: 'cancelada' };

// ── El manifiesto ───────────────────────────────────────────────────────────────────────

describe('el manifiesto declara quién exige confirmación', () => {
    beforeAll(() => intelligence.arrancar());

    test('las tres que comprometen al negocio la exigen; el hold no', () => {
        expect(registry.describir('reservar_turno').requiere_confirmacion).toBe(true);
        expect(registry.describir('reagendar_cita').requiere_confirmacion).toBe(true);
        expect(registry.describir('cancelar_cita').requiere_confirmacion).toBe(true);
        // La mitad *propose* de ADR-010: su efecto es un hold que caduca solo, y preguntar por él
        // obligaría a preguntar dos veces por una sola decisión.
        expect(registry.describir('proponer_turno').requiere_confirmacion).toBe(false);
    });

    test('el texto de la pregunta lo escribe el adaptador, no el modelo', () => {
        const texto = confirmacion.textoDePregunta('cancelar_cita', { codigo_cita: 'CITA-42' });
        expect(texto).toContain('CITA-42');
        expect(texto).toMatch(/confirmo/i);
    });
});

// ── El Nivel 4 pide, pero no dispara ────────────────────────────────────────────────────

describe('el modelo pide la mutación y NO se ejecuta', () => {
    test('el turno acaba en una pregunta, con la mutación guardada como tarea', async () => {
        const gate = gateFalso();
        const manejar = crearManejadorLlm({ ...DEPS_LLM, gate, adaptador: adaptadorFalso(GUION_CANCELA) });

        const d = await manejar(entrada('cancélame la cita CITA-999', conversacion()));

        // El Gate se llamó —para que valide argumentos, plan y pertenencia— y denegó.
        expect(gate.llamadas).toHaveLength(1);
        expect(gate.llamadas[0].confirmadoPor).toBeUndefined();

        expect(d.tarea.nombre).toBe(confirmacion.TAREA);
        expect(d.tarea.datos).toMatchObject({ capacidad: 'cancelar_cita', args: { codigo_cita: 'CITA-999' } });
        expect(d.respuestas[0].texto).toContain('CITA-999');
        expect(d.respuestas[0].opciones.map((o) => o.id)).toEqual(['si', 'no']);
        expect(d.pasos.some((p) => p.decision === 'confirmacion_solicitada')).toBe(true);
    });

    test('el modelo no llega a decir «ya la cancelé»: el turno termina en la pregunta', async () => {
        const adaptador = adaptadorFalso(GUION_CANCELA);
        const manejar = crearManejadorLlm({ ...DEPS_LLM, gate: gateFalso(), adaptador });

        const d = await manejar(entrada('cancélame la cita', conversacion()));

        // Una sola llamada al modelo. La segunda del guion —la frase que da por hecha la
        // cancelación— no se pide nunca, porque el turno se cierra con la pregunta. Es la razón
        // de que la confirmación no vuelva al bucle: ahorra tokens y cierra la boca del modelo
        // justo donde podría mentir.
        expect(adaptador.peticiones).toHaveLength(1);
        expect(d.respuestas).toHaveLength(1);
        expect(d.respuestas[0].texto).not.toMatch(/cancelé/i);
    });

    test('una mutación reversible por sí sola SÍ se ejecuta, y con clave de idempotencia', async () => {
        const gate = gateFalso({ resultados: { proponer_turno: { codigo_hold: 'H-1' } } });
        const manejar = crearManejadorLlm({
            ...DEPS_LLM,
            gate,
            adaptador: adaptadorFalso([
                {
                    razonFin: puerto.FIN.CAPACIDADES,
                    texto: '',
                    invocacionesSolicitadas: [
                        { id: 't1', capacidad: 'proponer_turno', argumentos: { inicio: '2026-09-01T10:00:00' } },
                    ],
                },
                { razonFin: puerto.FIN.TURNO, texto: 'Te aparté las 10:00, ¿te va bien?' },
            ]),
        });

        const d = await manejar(entrada('mírame el martes a las 10', conversacion()));

        expect(gate.llamadas[0].capacidad).toBe('proponer_turno');
        // Obligatoria en toda mutación, y con contador: dos holds en el mismo turno no pueden
        // compartir clave o el segundo recibiría el resultado del primero.
        expect(gate.llamadas[0].claveIdempotencia).toBe('turno-1:proponer_turno:1');
        expect(d.tarea).toBeUndefined();
        expect(d.resultado).toBe('resuelto');
    });
});

// ── El sí, el no y todo lo demás ────────────────────────────────────────────────────────

describe('resolver el pendiente', () => {
    const pendiente = (extra = {}) =>
        conversacion({
            tarea: confirmacion.TAREA,
            datos: {
                capacidad: 'cancelar_cita',
                args: { codigo_cita: 'CITA-999' },
                preguntado_en: new Date().toISOString(),
                repreguntas: 0,
                ...extra,
            },
        });

    const fsm = (gate) =>
        crearManejadorDeterminista({
            gate,
            identidad: IDENTIDAD_FSM,
            contextoNegocio: { obtener: async () => NEGOCIO },
        });

    test('«sí» ejecuta, con la prueba y la clave, y cierra la tarea', async () => {
        const gate = gateFalso({ resultados: { cancelar_cita: CANCELADA } });
        const d = await fsm(gate)(entrada('sí', pendiente()));

        expect(gate.llamadas).toHaveLength(1);
        expect(gate.llamadas[0]).toMatchObject({
            capacidad: 'cancelar_cita',
            args: { codigo_cita: 'CITA-999' },
            claveIdempotencia: 'turno-1',
            confirmadoPor: { idTurno: 'turno-1', texto: 'sí' },
        });
        expect(d.respuestas[0]).toContain('CITA-999');
        expect(d.tarea).toBeNull();
        expect(d.nivel).toBe('determinista');
        expect(d.invocaciones[0].resultado).toBe('ok');
    });

    test('el «sí» no gasta un solo token: lo resuelve el Nivel 1', async () => {
        const gate = gateFalso({ resultados: { cancelar_cita: CANCELADA } });
        const llm = async () => {
            throw new Error('el Nivel 4 no debería tocarse para leer un «sí»');
        };
        const escalera = crearManejadorEscalera({ determinista: fsm(gate), llm });

        const d = await escalera(entrada('sí', pendiente()));

        expect(d.pasos[0].decision).toBe('confirmacion_pendiente');
        expect(gate.llamadas).toHaveLength(1);
    });

    test('«no» no ejecuta nada y suelta la tarea', async () => {
        const gate = gateFalso();
        const d = await fsm(gate)(entrada('no', pendiente()));

        expect(gate.llamadas).toHaveLength(0);
        expect(d.tarea).toBeNull();
        expect(d.pasos[0].decision).toBe('confirmacion_rechazada');
    });

    test('«cancelar» sobre una cancelación pendiente significa NO ejecutarla', async () => {
        // La trampa: la palabra con la que se sale de un flujo es la misma que el nombre de lo
        // que se está confirmando. Las dos lecturas tienen que acabar en el mismo sitio — sin
        // cancelar la cita — y por eso el pendiente se mira antes que el comando de salida.
        const gate = gateFalso();
        const d = await fsm(gate)(entrada('cancelar', pendiente()));

        expect(gate.llamadas).toHaveLength(0);
        expect(d.pasos[0].decision).toBe('confirmacion_rechazada');
    });

    test('otra cosa: se repregunta una vez, sin regalar tiempo nuevo', async () => {
        const gate = gateFalso();
        const hace5min = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const d = await fsm(gate)(entrada('¿y cuánto cuesta?', pendiente({ preguntado_en: hace5min })));

        expect(gate.llamadas).toHaveLength(0);
        expect(d.tarea.datos.repreguntas).toBe(1);
        expect(d.tarea.datos.preguntado_en).toBe(hace5min);
        expect(d.respuestas[0].texto).toMatch(/sí o no/i);
    });

    test('a la segunda se suelta el tema, y sigue sin ejecutarse nada', async () => {
        const gate = gateFalso();
        const d = await fsm(gate)(entrada('¿tienen parqueadero?', pendiente({ repreguntas: 1 })));

        expect(gate.llamadas).toHaveLength(0);
        expect(d.tarea).toBeNull();
        expect(d.pasos[0].decision).toBe('confirmacion_descartada');
    });

    test('caducado NO ejecuta, aunque el cliente diga sí', async () => {
        // Es la regla que no se negocia: el silencio no autoriza, y un sí que llega media hora
        // después es un sí a una pregunta que el cliente ya no recuerda.
        const gate = gateFalso({ resultados: { cancelar_cita: CANCELADA } });
        const viejo = new Date(Date.now() - (confirmacion.VIDA_MS + 1000)).toISOString();
        const d = await fsm(gate)(entrada('sí', pendiente({ preguntado_en: viejo })));

        expect(gate.llamadas).toHaveLength(0);
        expect(d.pasos[0].decision).toBe('confirmacion_caducada');
        expect(d.respuestas[0]).toMatch(/no hice nada/i);
    });

    test('un pendiente sin hora legible se trata como caducado', async () => {
        const gate = gateFalso();
        const d = await fsm(gate)(entrada('sí', pendiente({ preguntado_en: null })));

        expect(gate.llamadas).toHaveLength(0);
        expect(d.pasos[0].decision).toBe('confirmacion_caducada');
    });

    test('si el dominio rechaza, el cliente oye el motivo y no una frase genérica', async () => {
        const fuera = new Error('Ya pasó la ventana de cancelación; llama al negocio.');
        fuera.code = 'FUERA_DE_VENTANA';
        fuera.statusCode = 409;
        const gate = gateFalso({ errores: { cancelar_cita: fuera } });

        const d = await fsm(gate)(entrada('sí', pendiente()));

        expect(d.respuestas[0]).toContain('ventana de cancelación');
        expect(d.tarea).toBeNull();
        expect(d.invocaciones[0].errorCodigo).toBe('FUERA_DE_VENTANA');
    });

    test('un fallo que no es del dominio sube: el turno es un error, no una respuesta amable', async () => {
        const roto = new Error('connection terminated unexpectedly');
        const gate = gateFalso({ errores: { cancelar_cita: roto } });

        await expect(fsm(gate)(entrada('sí', pendiente()))).rejects.toThrow(/connection terminated/);
    });

    test('el código de la cita creada se recuerda en variables', async () => {
        const gate = gateFalso({ resultados: { cancelar_cita: { codigo_cita: 'CITA-777' } } });
        const d = await fsm(gate)(entrada('sí', pendiente({ args: { codigo_cita: 'CITA-777' } })));

        // Sin `consultar_mis_citas`, este código es la única forma de volver a tocar la cita.
        expect(d.variables.ultima_cita).toBe('CITA-777');
    });
});

// ── El paso de la pelota entre los dos niveles ──────────────────────────────────────────

describe('los dos turnos, de punta a punta', () => {
    test('pide cancelar → pregunta → sí → cancelada', async () => {
        const gate = gateFalso({ resultados: { cancelar_cita: CANCELADA } });
        const llm = crearManejadorLlm({ ...DEPS_LLM, gate, adaptador: adaptadorFalso(GUION_CANCELA) });
        const determinista = crearManejadorDeterminista({
            gate,
            identidad: IDENTIDAD_FSM,
            contextoNegocio: { obtener: async () => NEGOCIO },
        });
        const escalera = crearManejadorEscalera({ determinista, llm });

        // Turno 1: lo enruta al Nivel 4 porque la FSM no sabe cancelar.
        const uno = await escalera(entrada('quiero cancelar mi cita CITA-999', conversacion()));
        expect(uno.pasos[0].decision).toBe('intencion_mutacion');
        expect(uno.tarea.nombre).toBe(confirmacion.TAREA);
        expect(gate.llamadas.filter((l) => l.confirmadoPor)).toHaveLength(0);

        // Turno 2: con el pendiente puesto, el mismo mensaje ya no va al modelo.
        const conv = conversacion({ tarea: uno.tarea.nombre, datos: uno.tarea.datos });
        const dos = await escalera(entrada('sí', conv));

        expect(dos.pasos[0].decision).toBe('confirmacion_pendiente');
        expect(gate.llamadas.filter((l) => l.confirmadoPor)).toHaveLength(1);
        expect(dos.respuestas[0]).toContain('cancelada');
        expect(dos.tarea).toBeNull();
    });

    test('un agendamiento a medias no lo secuestra la palabra «cancelar»', async () => {
        // El orden de la tabla importa: `confirmacion_pendiente` va antes que `tarea_en_curso`,
        // pero si no hay pendiente la FSM sigue mandando, y ahí «cancelar» sale del flujo.
        const r = orquestador.enrutar({
            texto: 'cancelar',
            tareaEnCurso: true,
            confirmacionPendiente: false,
            llmDisponible: true,
        });
        expect(r.regla).toBe('tarea_en_curso');
    });

    test('la tarea de agendar y la de confirmar no se confunden', () => {
        expect(confirmacion.TAREA).not.toBe(TAREA_AGENDAR);
        expect(confirmacion.pendiente(conversacion({ tarea: TAREA_AGENDAR, datos: { paso: 'hora' } }))).toBeNull();
    });
});
