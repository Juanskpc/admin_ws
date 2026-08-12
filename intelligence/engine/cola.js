/**
 * Cola FIFO particionada por clave, con debounce de agregación (ADR-014, mecanismos 1 y 3).
 *
 * No sabe nada de conversaciones, ni de la base de datos, ni de mensajes: recibe una clave y
 * una función `procesar(clave, contexto)`. Eso es lo que la hace comprobable sin Postgres y
 * lo que deja `motor.js` libre de la aritmética de temporizadores.
 *
 * ## Las dos garantías
 *
 * 1. **Una clave nunca se procesa dos veces a la vez.** Es la partición FIFO: los mensajes de
 *    una conversación avanzan en orden, uno detrás de otro.
 * 2. **Claves distintas avanzan en paralelo**, hasta `concurrencia`.
 *
 * ## Por qué en memoria y no BullMQ, teniendo BullMQ instalado
 *
 * ADR-014 y el master-plan nombran BullMQ, y sigue siendo el destino: la interfaz de aquí
 * —`despertar` / `procesar`— es la que un adaptador de BullMQ implementaría sin tocar el
 * motor. Pero hoy no hay Redis en local, no hay más de un proceso, y una cola distribuida
 * cuyo único cliente es un proceso único es un componente que no pasa el test de simplicidad:
 * no se puede probar aquí y no resuelve ningún problema que exista.
 *
 * Lo importante es que **la corrección no depende de esta elección**. Lo que impide que dos
 * procesos pisen la misma conversación no es la cola, es el lock pesimista en la base de
 * datos (`repositorio.bloquear`). Esta cola optimiza —evita el trabajo que el lock rechazaría—
 * pero no es lo que protege. Por eso cambiarla por BullMQ el día que haya varios procesos es
 * un cambio de rendimiento, no de seguridad. El precedente de degradar a una cola en proceso
 * ya está en el `reporteWorker` de parqueadero.
 *
 * ## El debounce tiene un techo, y no es un detalle
 *
 * «Esperar 2-4 s por si llega otro mensaje» implementado literalmente es una inanición:
 * mientras alguien siga escribiendo, el temporizador se reinicia y el turno no arranca nunca.
 * Con una ráfaga —justo lo que ADR-016 promete inyectar con el WebChat hostil— la conversación
 * se congela. Por eso hay dos relojes: la espera se reinicia con cada mensaje, pero nunca se
 * pospone más allá de `maxMs` desde el primero.
 */
'use strict';
const { EventEmitter } = require('events');

/**
 * Lee un número del entorno respetando el **cero**.
 *
 * `Number(process.env.X) || defecto` —el idioma habitual en este repo— convierte un `0`
 * explícito en el valor por defecto, porque cero es falsy. Y aquí el cero es un valor
 * legítimo y útil: «sin debounce» y «da por colgado cualquier turno» son justo lo que un
 * test necesita pedir. Costó un `recuperar` que decía haber revisado y no revisó nada.
 */
function numeroDeEntorno(nombre, defecto) {
    const crudo = process.env[nombre];
    if (crudo === undefined || crudo === '') return defecto;
    const valor = Number(crudo);
    return Number.isFinite(valor) ? valor : defecto;
}

const CONFIG = {
    /** Espera tras el último mensaje. ADR-014 pide 2-4 s. */
    debounceMs: numeroDeEntorno('CONVERSACION_DEBOUNCE_MS', 2500),
    /** Techo absoluto desde el primer mensaje del grupo. Ver el comentario de arriba. */
    debounceMaxMs: numeroDeEntorno('CONVERSACION_DEBOUNCE_MAX_MS', 10000),
    /**
     * Turnos simultáneos (de conversaciones distintas). Cada uno retiene una conexión del
     * pool durante todo el turno, porque el lock es pesimista; con `pool.max = 10` en
     * `conection.js`, pasar de 4 es empezar a competir con el tráfico HTTP del backend.
     */
    concurrencia: Math.max(1, numeroDeEntorno('CONVERSACION_CONCURRENCIA', 4)),
};

/**
 * @typedef {Object} Entrada
 * @property {NodeJS.Timeout|null} temporizador
 * @property {number} primeraLlegada  — marca para el techo del debounce.
 * @property {boolean} enCola
 * @property {boolean} enVuelo
 * @property {boolean} resucitar      — llegó algo mientras se procesaba.
 * @property {Object} contexto        — se acumula entre despertares (p.ej. `intentos`).
 */

class ColaParticionada extends EventEmitter {
    /**
     * @param {Object} opciones
     * @param {Function} opciones.procesar — async (clave, contexto) => void. Si lanza, se
     *        emite `error` y la clave se libera; reintentar es decisión de quien llame.
     * @param {Object} [opciones.config] — sobrescribe `CONFIG` (los tests bajan el debounce).
     */
    constructor({ procesar, config = {} }) {
        super();
        if (typeof procesar !== 'function') {
            throw new Error('La cola necesita una función procesar(clave, contexto).');
        }
        this.procesar = procesar;
        this.config = { ...CONFIG, ...config };
        /** @type {Map<string, Entrada>} */
        this.entradas = new Map();
        /** Orden de llegada: es lo que hace la cola FIFO entre claves distintas. */
        this.listas = [];
        this.enVuelo = 0;
        this.detenida = false;
    }

    _entrada(clave) {
        let entrada = this.entradas.get(clave);
        if (!entrada) {
            entrada = {
                temporizador: null,
                primeraLlegada: 0,
                enCola: false,
                enVuelo: false,
                resucitar: false,
                contexto: {},
            };
            this.entradas.set(clave, entrada);
        }
        return entrada;
    }

    /**
     * Hay trabajo nuevo para esta clave.
     *
     * Llamarlo cinco veces en dos segundos produce **un** procesamiento, no cinco. Es la
     * diferencia entre responder «hola», «quiero cita» y «para mañana» por separado —tres
     * respuestas torpes y tres turnos pagados— y atenderlos juntos.
     *
     * @param {string} clave
     * @param {Object} [contexto] — se fusiona con lo que ya hubiera para esta clave.
     */
    despertar(clave, contexto = {}) {
        if (this.detenida) return;

        const entrada = this._entrada(clave);
        Object.assign(entrada.contexto, contexto);

        // Mientras se procesa no se toca nada: al terminar, quien la soltó vuelve a
        // despertarla. Si se encolara ahora, el trabajo entraría dos veces.
        if (entrada.enVuelo) {
            entrada.resucitar = true;
            return;
        }

        // Ya esperó su debounce y está en la fila: adelantarla sería romper el FIFO.
        if (entrada.enCola) return;

        const ahora = Date.now();
        if (!entrada.temporizador) entrada.primeraLlegada = ahora;

        const restanteHastaElTecho = entrada.primeraLlegada + this.config.debounceMaxMs - ahora;
        const espera = Math.max(0, Math.min(this.config.debounceMs, restanteHastaElTecho));

        if (entrada.temporizador) clearTimeout(entrada.temporizador);
        // Sin `unref()`, a diferencia del temporizador del relay del outbox: aquel es un
        // sondeo y no debe mantener vivo el proceso, mientras que esto es una respuesta que
        // alguien está esperando. Un `unref()` aquí haría que un proceso que termina justo
        // después de recibir un mensaje se fuera sin contestarlo. Para salir, `detener()`.
        entrada.temporizador = setTimeout(() => this._encolar(clave), espera);
    }

    _encolar(clave) {
        const entrada = this.entradas.get(clave);
        if (!entrada || this.detenida) return;
        entrada.temporizador = null;
        entrada.enCola = true;
        this.listas.push(clave);
        this._bombear();
    }

    _bombear() {
        while (!this.detenida && this.enVuelo < this.config.concurrencia && this.listas.length > 0) {
            const clave = this.listas.shift();
            const entrada = this.entradas.get(clave);
            if (!entrada) continue;

            entrada.enCola = false;
            entrada.enVuelo = true;
            this.enVuelo++;

            const contexto = { ...entrada.contexto };
            entrada.contexto = {};

            Promise.resolve()
                .then(() => this.procesar(clave, contexto))
                .catch((error) => this.emit('error', error, clave))
                .finally(() => {
                    this.enVuelo--;
                    entrada.enVuelo = false;

                    if (entrada.resucitar) {
                        entrada.resucitar = false;
                        this.despertar(clave);
                    } else if (!entrada.temporizador && !entrada.enCola) {
                        // Sin trabajo pendiente: se olvida la clave. El Map no puede crecer
                        // con una entrada por conversación vista desde que arrancó el proceso.
                        this.entradas.delete(clave);
                    }

                    this._bombear();
                    if (this.ocioso()) this.emit('ocioso');
                });
        }
    }

    /** Ni procesando, ni en fila, ni esperando un debounce. */
    ocioso() {
        if (this.enVuelo > 0 || this.listas.length > 0) return false;
        for (const entrada of this.entradas.values()) {
            if (entrada.temporizador || entrada.enCola || entrada.enVuelo) return false;
        }
        return true;
    }

    /**
     * Resuelve cuando no queda nada por hacer. Para tests y para el arnés de la CLI, que
     * tiene que esperar al turno antes de imprimir la conversación.
     */
    async drenar({ timeoutMs = 30000 } = {}) {
        if (this.ocioso()) return;
        await new Promise((resolver, rechazar) => {
            const reloj = setTimeout(() => {
                this.off('ocioso', alTerminar);
                rechazar(new Error('La cola no llegó a vaciarse a tiempo.'));
            }, timeoutMs);
            const alTerminar = () => {
                if (!this.ocioso()) return;
                clearTimeout(reloj);
                this.off('ocioso', alTerminar);
                resolver();
            };
            this.on('ocioso', alTerminar);
        });
    }

    /** Salta el debounce y encola ya. Solo para tests y para la CLI en modo síncrono. */
    forzar(clave, contexto = {}) {
        const entrada = this._entrada(clave);
        Object.assign(entrada.contexto, contexto);
        if (entrada.enVuelo) {
            entrada.resucitar = true;
            return;
        }
        if (entrada.temporizador) {
            clearTimeout(entrada.temporizador);
            entrada.temporizador = null;
        }
        if (!entrada.enCola) this._encolar(clave);
    }

    detener() {
        this.detenida = true;
        for (const entrada of this.entradas.values()) {
            if (entrada.temporizador) clearTimeout(entrada.temporizador);
            entrada.temporizador = null;
        }
        this.entradas.clear();
        this.listas.length = 0;
    }
}

module.exports = { ColaParticionada, CONFIG, numeroDeEntorno };
