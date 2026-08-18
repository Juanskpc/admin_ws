/**
 * Arranque de Intelligence: la lista de adaptadores vive AQUÍ y en ningún otro sitio.
 *
 * Es deliberado. `intelligence/core/` no puede nombrar a `reserva` ni a `restaurante`: el
 * día que lo haga, añadir una vertical vuelve a costar cirugía en el núcleo y se pierde el
 * `git diff = 0` que persigue F9 (ADR-009). Toda la mención a verticales concretas está
 * concentrada en este archivo, que es un archivo de composición, no de núcleo.
 *
 * ## El test del apagón
 *
 * Nada de esto se monta en `app.js`. Las verticales no importan Intelligence y no saben que
 * existe (ADR-005): borrar este directorio entero debe dejar el backend funcionando igual.
 * Desde F4 los únicos clientes son las CLI (`scripts/capacidad.js`, `scripts/conversacion.js`)
 * y la suite de tests.
 */
'use strict';
const registry = require('./core/registry');
const motor = require('./engine/motor');
const gateway = require('./channels/gateway');

const ADAPTADORES = [require('./adapters/reserva')];

/** Los canales, por el mismo motivo y con la misma regla que los adaptadores de vertical. */
const CANALES = [require('./channels/webchat/adaptador')];

let arrancado = false;

/**
 * Registra el catálogo. Idempotente: llamarlo dos veces no duplica ni revienta, porque la
 * CLI y los tests lo invocan sin coordinarse.
 */
function arrancar() {
    if (arrancado) return registry.listar();

    for (const adaptador of ADAPTADORES) {
        adaptador.registrarCapacidades();
    }
    arrancado = true;
    return registry.listar();
}

/** Solo para tests: vuelve al estado previo al arranque. */
function _reiniciar() {
    registry._limpiar();
    require('./model/puerto')._limpiar();
    motor._reiniciar();
    gateway.detener();
    gateway.limpiar();
    arrancado = false;
}

/**
 * Arranca el Conversation Engine (F5-B).
 *
 * Va aparte de `arrancar()` a propósito: el catálogo de capacidades es un registro en memoria
 * y no cuesta nada, mientras que esto instala un manejador, recupera trabajo de la base y
 * empieza a abrir turnos. Quien no quiera motor —la CLI de capacidades, los tests de F4— no
 * debe pagarlo por importar este archivo.
 *
 * El manejador se pasa desde fuera porque **el motor no decide qué se contesta**: hoy solo
 * existe el andamio de eco; la FSM llega en F5-D y el LLM en F6, y ninguno de los dos debería
 * obligar a tocar el motor.
 *
 * @param {Function} manejador — ver el contrato en `engine/motor.js#registrarManejador`.
 * @param {Object}  [opciones]
 * @param {boolean} [opciones.recuperar=true] — retomar el trabajo que dejó un proceso muerto.
 */
async function arrancarMotor(manejador, { recuperar = true } = {}) {
    motor.registrarManejador(manejador);
    if (recuperar) return motor.recuperar();
    return { colgados: 0, reencoladas: 0 };
}

/**
 * Monta la escalera de costo con su Nivel 4, si hay con qué (F6, ADR-018).
 *
 * ## Por qué esto vive aquí y no en el manejador
 *
 * Es composición: elegir proveedor es exactamente lo que el resto del núcleo no puede hacer. El
 * manejador de Nivel 4 recibe un adaptador ya construido y no sabe de quién es; `orquestador.js`
 * decide niveles sin saber qué modelo los sirve. La única línea del proyecto que dice
 * «Anthropic» fuera del propio adaptador está aquí abajo.
 *
 * ## Degrada, no revienta
 *
 * Sin `ANTHROPIC_API_KEY` —o con `LLM_HABILITADO=false`— devuelve la escalera **de un solo
 * peldaño**, que es literalmente el sistema de F5 y sigue siendo correcto: se contesta con la
 * FSM, gratis, y el Ledger lo registra como determinista. Un backend que no arranca porque falta
 * una clave de un modelo convertiría una capacidad opcional (ADR-005) en un requisito.
 *
 * @returns {{manejador: Function, nivel4: string|null}}
 */
function montarEscalera({ adaptador = null } = {}) {
    const { crearManejadorEscalera } = require('./engine/manejadorEscalera');
    const { manejarDeterminista } = require('./engine/manejadorDeterminista');

    const habilitado = process.env.LLM_HABILITADO !== 'false';
    const hayCredencial = Boolean(process.env.ANTHROPIC_API_KEY);

    if (!adaptador && (!habilitado || !hayCredencial)) {
        console.log(
            `[intelligence] Nivel 4 apagado (${!habilitado ? 'LLM_HABILITADO=false' : 'sin ANTHROPIC_API_KEY'}). ` +
                'La escalera se queda en el Nivel 1 determinista: $0.00 por turno.'
        );
        return { manejador: crearManejadorEscalera({ determinista: manejarDeterminista }), nivel4: null };
    }

    const { crearAdaptadorAnthropic } = require('./model/adaptadores/anthropic');
    const { crearManejadorLlm, CONFIG } = require('./engine/manejadorLlm');
    const puerto = require('./model/puerto');
    const precios = require('./model/precios');

    const elegido = adaptador || crearAdaptadorAnthropic();

    // Un modelo que se puede ejecutar y no se puede facturar es peor que uno que no se puede
    // ejecutar: el turno sale, el costo no, y la pregunta 1 del Ledger empieza a mentir sin que
    // nadie lo note. Se comprueba al arrancar y no en el primer turno.
    for (const modelo of elegido.modelos) {
        if (!precios.modelosConocidos().includes(modelo)) {
            throw new Error(
                `El adaptador "${elegido.nombre}" sirve el modelo "${modelo}" y precios.js no ` +
                    'tiene su tarifa. Un turno ejecutable y no facturable rompe ADR-022.'
            );
        }
    }

    puerto.registrarAdaptador(elegido);
    const llm = crearManejadorLlm({ adaptador: elegido });

    console.log(
        `[intelligence] Nivel 4 montado: ${elegido.nombre}/${CONFIG.modelo} ` +
            `(esfuerzo ${CONFIG.esfuerzo}, tope ${CONFIG.maxCentavosPorTurno} centavos por turno). ` +
            'Solo capacidades de CONSULTA.'
    );

    return {
        manejador: crearManejadorEscalera({ determinista: manejarDeterminista, llm }),
        nivel4: `${elegido.nombre}/${CONFIG.modelo}`,
    };
}

/**
 * Arranca los canales (F5-C): registra los adaptadores y pone en marcha el entregador.
 *
 * La lista de canales vive **aquí y en ningún otro sitio**, por la misma razón que la de
 * adaptadores de vertical: el día que `channels/gateway.js` nombre a `webchat`, añadir
 * WhatsApp volverá a costar cirugía en el núcleo.
 *
 * Va aparte de `arrancarMotor()` porque son dos cosas que se pueden querer por separado: los
 * tests del motor no necesitan entregador, y un proceso que solo entregue mensajes de salida
 * (un worker dedicado, el día que haga falta) no necesita motor.
 */
function arrancarCanales({ iniciarEntrega = true } = {}) {
    for (const adaptador of CANALES) gateway.registrar(adaptador);
    if (iniciarEntrega) gateway.iniciar();
    return CANALES.map((c) => c.nombre);
}

module.exports = {
    arrancar,
    arrancarMotor,
    arrancarCanales,
    montarEscalera,
    _reiniciar,
    registry,
    policyGate: require('./core/policyGate'),
    features: require('./core/features'),
    motor,
    gateway,
    mensajeCanonico: require('./core/mensajeCanonico'),
    /** El andamio de F5-B. Se queda como manejador de pruebas del motor, no como producto. */
    manejadorEco: require('./engine/manejadorEco'),
    /** El motor determinista de F5-D (ADR-015). Es el manejador de verdad. */
    manejadorDeterminista: require('./engine/manejadorDeterminista'),
    identidad: require('./engine/identidad'),
    /** El `ModelPort` y su alrededor (F6). El núcleo nunca importa el SDK de un proveedor. */
    modelPort: require('./model/puerto'),
    orquestador: require('./model/orquestador'),
    promptBuilder: require('./model/promptBuilder'),
    precios: require('./model/precios'),
};
