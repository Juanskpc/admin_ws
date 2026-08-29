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

const ADAPTADORES = [
    require('./adapters/reserva'),
    require('./adapters/restaurante'),
];

/** Los canales, por el mismo motivo y con la misma regla que los adaptadores de vertical. */
const CANALES = [
    require('./channels/webchat/adaptador'),
    require('./channels/whatsapp/adaptador'),
];

let arrancado = false;

/**
 * Registra el catálogo. Idempotente: llamarlo dos veces no duplica ni revienta, porque la
 * CLI y los tests lo invocan sin coordinarse.
 */
function arrancar() {
    if (arrancado) return registry.listar();

    const flujos = require('./engine/flujos');
    for (const adaptador of ADAPTADORES) {
        adaptador.registrarCapacidades();
        // Qué clase de negocio atiende cada vertical. Sin esto el motor da por supuesto de qué
        // va el negocio, y el 2026-08-24 eso dejó a un restaurante sin una sola respuesta.
        adaptador.registrarFlujo?.({ flujos });
    }
    arrancado = true;
    return registry.listar();
}

/** Solo para tests: vuelve al estado previo al arranque. */
function _reiniciar() {
    registry._limpiar();
    require('./engine/flujos')._limpiar();
    require('./model/puerto')._limpiar();
    motor._reiniciar();
    gateway.detener();
    gateway.limpiar();
    const recordatorios = require('./recordatorios');
    recordatorios.detener();
    recordatorios.limpiarRevisores();
    require('../app_core/outbox/outboxRelay').limpiarConsumidores();
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
 * decide niveles sin saber qué modelo los sirve. Ni una línea del núcleo nombra a un proveedor.
 *
 * ## Degrada, no revienta
 *
 * Sin ninguna credencial —o con `LLM_HABILITADO=false`— devuelve la escalera **de un solo
 * peldaño**, que es literalmente el sistema de F5 y sigue siendo correcto: se contesta con la
 * FSM, gratis, y el Ledger lo registra como determinista. Un backend que no arranca porque falta
 * una clave de un modelo convertiría una capacidad opcional (ADR-005) en un requisito.
 *
 * @param {Object} [opciones]
 * @param {Object} [opciones.adaptador] — adaptador ya construido (los tests).
 * @param {string} [opciones.proveedor] — fuerza proveedor; si no, lo decide la fábrica.
 * @param {string} [opciones.modelo]    — fuerza modelo; su proveedor se deduce del precio.
 * @returns {{manejador: Function, nivel4: string|null}}
 */
function montarEscalera({ adaptador = null, proveedor = null, modelo = null } = {}) {
    const { crearManejadorEscalera } = require('./engine/manejadorEscalera');
    const { manejarDeterminista } = require('./engine/manejadorDeterminista');
    const fabrica = require('./model/adaptadores');

    const soloNivel1 = (motivo) => {
        console.log(
            `[intelligence] Nivel 4 apagado (${motivo}). La escalera se queda en el Nivel 1 ` +
                'determinista: $0.00 por turno.'
        );
        return { manejador: crearManejadorEscalera({ determinista: manejarDeterminista }), nivel4: null };
    };

    if (process.env.LLM_HABILITADO === 'false') return soloNivel1('LLM_HABILITADO=false');

    let elegido = adaptador ? { adaptador, modelo: modelo || fabrica.resolver({ proveedor, modelo })?.modelo } : null;
    if (!elegido) {
        elegido = fabrica.crearAdaptador({ proveedor, modelo });
        if (!elegido) {
            return soloNivel1(
                `sin credencial — se busca ${Object.values(fabrica.CREDENCIAL).join(' o ')}`
            );
        }
    }

    const { crearManejadorLlm, CONFIG } = require('./engine/manejadorLlm');
    const puerto = require('./model/puerto');
    const precios = require('./model/precios');

    // Un modelo que se puede ejecutar y no se puede facturar es peor que uno que no se puede
    // ejecutar: el turno sale, el costo no, y la pregunta 1 del Ledger empieza a mentir sin que
    // nadie lo note. Se comprueba al arrancar y no en el primer turno.
    for (const m of elegido.adaptador.modelos) {
        if (!precios.modelosConocidos().includes(m)) {
            throw new Error(
                `El adaptador "${elegido.adaptador.nombre}" sirve el modelo "${m}" y precios.js ` +
                    'no tiene su tarifa. Un turno ejecutable y no facturable rompe ADR-022.'
            );
        }
    }

    puerto.registrarAdaptador(elegido.adaptador);
    const config = { ...CONFIG, modelo: elegido.modelo };
    const llm = crearManejadorLlm({ adaptador: elegido.adaptador, config });

    const etiqueta = `${elegido.adaptador.nombre}/${config.modelo}`;
    console.log(
        `[intelligence] Nivel 4 montado: ${etiqueta} (esfuerzo ${config.esfuerzo}, tope ` +
            `${config.maxCentavosPorTurno} centavos por turno). Consultas y mutaciones: las que ` +
            'comprometen al negocio no se ejecutan sin el sí del cliente en el canal (F7, ADR-010).'
    );

    return {
        manejador: crearManejadorEscalera({ determinista: manejarDeterminista, llm }),
        nivel4: etiqueta,
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

    // El único punto del sistema donde el motor y los canales se conocen. El motor no importa
    // el gateway a propósito (ver `motor.registrarSenalDeActividad`): si lo hiciera, el núcleo
    // sabría que existen los canales y ADR-017 dejaría de tener quien lo defienda.
    //
    // Quién sabe mostrar algo lo decide cada adaptador declarando `mostrarActividad`; el que no
    // lo declare —el WebChat hoy— no hace nada, que es la degradación con gracia que ADR-017
    // exige a cambio de dejar que un canal aproveche lo que tenga de más.
    motor.registrarSenalDeActividad((sobre) => gateway.senalarActividad(sobre));

    // Qué canales traen una identidad probada. Se lee de la declaración del adaptador y no se
    // nombra a ninguno aquí: añadir un canal no debe obligar a editar la composición ni el motor.
    // De esto cuelga que un cliente pueda cancelar su cita y no la de otro — ver `identidad.js`.
    const identidad = require('./engine/identidad');
    for (const adaptador of CANALES) {
        if (adaptador.idExternoEsIdentidad) identidad.registrarCanalConIdentidad(adaptador.nombre);
    }

    // El de WhatsApp se registra siempre, pero solo **funciona** con sus cinco variables puestas.
    // Se dice al arrancar y no en el primer webhook: un canal a medio configurar recibe mensajes y
    // no contesta, y desde fuera eso es un negocio que ignora a sus clientes.
    //
    // Desde F8-C los números salen de `platform.numero_canal`, así que hay que leerla antes de
    // poder decir qué hay. Se hace sin esperar —esta función es síncrona y volverla asíncrona
    // arrastraría a `app.js`— y la línea se imprime cuando el registro está cargado: unos
    // milisegundos después, que en un arranque no le importa a nadie.
    require('./channels/whatsapp/numeros')
        .asegurarCargado({ forzar: true })
        .then(() => {
            const whatsapp = require('./channels/whatsapp/config').estado();
            console.log(
                whatsapp.habilitado
                    ? `[whatsapp] canal listo: ${whatsapp.resumen}`
                    : `[whatsapp] canal APAGADO (${whatsapp.resumen}). El webhook rechazará todo.`
            );
        })
        .catch((e) => console.error('[whatsapp] no se pudo leer el registro de números:', e.message));

    return CANALES.map((c) => c.nombre);
}

/**
 * Arranca los recordatorios proactivos (F8-B): el relay del outbox y el drenaje.
 *
 * Va aparte de todo lo demás por la misma razón que el motor va aparte del catálogo: esto pone en
 * marcha **dos sondeos** y empieza a escribir mensajes que un cliente real va a recibir. Los tests
 * de F4 y la CLI de capacidades no deben pagarlo por importar este archivo.
 *
 * Y aquí es donde el relay del outbox se enciende por primera vez desde F1. Arrancaba inactivo
 * a propósito —«un evento se define cuando hay productor *y* consumidor»,
 * [ADR-013](../docs/adr/ADR-013-catalogo-eventos.md) regla 4— y hasta hoy no había consumidor.
 *
 * @param {Object} [opciones]
 * @param {boolean} [opciones.iniciarSondeos=true] — false registra sin poner temporizadores, que
 *        es lo que quieren los tests y los guiones que drenan a mano.
 */
function arrancarRecordatorios({ iniciarSondeos = true } = {}) {
    const relay = require('../app_core/outbox/outboxRelay');
    const recordatorios = require('./recordatorios');

    for (const adaptador of ADAPTADORES) adaptador.registrarRecordatorios?.({ relay });

    if (iniciarSondeos) {
        relay.iniciar();
        recordatorios.iniciar();
    }
    return { canal: recordatorios.CONFIG.canal };
}

module.exports = {
    arrancar,
    arrancarMotor,
    arrancarCanales,
    arrancarRecordatorios,
    recordatorios: require('./recordatorios'),
    plantillas: require('./core/plantillas'),
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
