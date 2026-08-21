/**
 * Recordatorios proactivos (F8-B) — los mensajes que empieza el negocio.
 *
 * Es el primer sitio donde el asistente **habla sin que nadie le haya escrito**, y por eso es
 * también donde se cobra el dividendo del outbox de F1: hasta ahora el outbox transportaba
 * eventos que nadie consumía, deliberadamente ([ADR-013](../../docs/adr/ADR-013-catalogo-eventos.md),
 * regla 4). Aquí aparece el primer consumidor.
 *
 * ```
 *   reserva crea una cita ──emitir()──► platform.outbox        (misma transacción, ADR-012)
 *                                            │
 *                                       outboxRelay
 *                                            ▼
 *                        adapters/reserva/recordatorios.js     (sabe leer una cita)
 *                                            │ programar()
 *                                            ▼
 *                                 intelligence.recordatorio     (una promesa de futuro)
 *                                            │ al vencer: drenarUnaVez()
 *                                            ▼
 *                          intelligence.mensaje (saliente, con plantilla)
 *                                            │
 *                                     Channel Gateway ──► WhatsApp
 * ```
 *
 * ## La decisión que quita la mitad del código: se relee al vencer
 *
 * La forma obvia era escuchar también `cita.cancelada` y `cita.reagendada` para borrar o mover el
 * recordatorio. Se descartó, y no por ahorrar: un recordatorio que se envía **releyendo la cita en
 * el momento de enviarla** es correcto aunque el evento se pierda, aunque la cita se cancele con un
 * `UPDATE` a mano desde el panel, o aunque se mueva dos veces en un minuto. La cadena de eventos
 * solo es correcta si nadie se salta ningún eslabón nunca.
 *
 * Es además lo que [ADR-013](../../docs/adr/ADR-013-catalogo-eventos.md) dice que hay que hacer con
 * los eventos delgados: «un consumidor que necesite detalle lo pide releyendo». El evento sirve para
 * **saber que hay algo que programar**; el estado se pregunta cuando importa, que es al enviar.
 *
 * Quien relee es el **revisor**, y lo pone la vertical: `intelligence/` no sabe qué es una cita ni
 * puede saberlo (ADR-009). Un revisor contesta tres cosas: si sigue vigente, cuándo hay que mandarlo
 * —que puede haber cambiado— y con qué parámetros.
 *
 * ## Por qué esto no es el outbox otra vez
 *
 * Se parecen —una tabla, un sondeo, reintentos— y son opuestos en lo que importa: el outbox
 * transporta **lo que ya pasó** y hay que entregarlo cuanto antes; esto es **una promesa de futuro**
 * que se puede mover y cancelar, y cuyo valor entero está en llegar en el momento justo. Meterlo en
 * el outbox obligaría a que el relay supiera esperar, y un relay que espera deja de ser un relay.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const repositorio = require('../engine/repositorio');
const plantillasCatalogo = require('../core/plantillas');
const { numeroDeEntorno } = require('../engine/cola');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

const CONFIG = {
    intervaloMs: numeroDeEntorno('RECORDATORIO_POLL_MS', 60000),
    lote: numeroDeEntorno('RECORDATORIO_LOTE', 20),
    /** Tras agotarlos el recordatorio queda `fallido` y nadie lo vuelve a mirar. */
    maxIntentos: numeroDeEntorno('RECORDATORIO_MAX_INTENTOS', 3),
    /**
     * Más tarde que esto no se manda. Un recordatorio de una cita que empieza en diez minutos
     * llega tarde para todo: para venir, para avisar y para reagendar. Si el proceso estuvo caído,
     * lo honesto es no mandarlo, no mandarlo a destiempo.
     */
    toleranciaMinutos: numeroDeEntorno('RECORDATORIO_TOLERANCIA_MIN', 120),
    /** El canal por el que se le escribe a un teléfono. Hoy solo hay uno que sepa hacerlo. */
    canal: process.env.RECORDATORIO_CANAL || 'whatsapp',
};

/** Map<prefijo de referencia, revisor>. La llena la composición, nunca el núcleo. */
const revisores = new Map();
let temporizador = null;
let drenando = false;

/**
 * Registra quién sabe releer un tipo de referencia.
 *
 * @param {string} prefijo — lo que va antes de los dos puntos en `referencia` («cita»).
 * @param {Function} revisor — async ({ referencia, idNegocio }, { transaction }) =>
 *        { vigente: boolean, motivo?: string, enviarEn?: Date, parametros?: Object }
 */
function registrarRevisor(prefijo, revisor) {
    if (typeof revisor !== 'function') throw new Error('Un revisor de recordatorios es una función.');
    revisores.set(prefijo, revisor);
}

function limpiarRevisores() {
    revisores.clear();
}

function revisorDe(referencia) {
    return revisores.get(String(referencia).split(':')[0]) || null;
}

// ── Programar ───────────────────────────────────────────────────────────────────────────────

/**
 * Programa —o reprograma— un recordatorio.
 *
 * El `ON CONFLICT` es lo que lo hace idempotente, y no es una precaución teórica: el outbox
 * entrega **al menos una vez** (ADR-012), así que el mismo `cita.creada.v1` puede llegar dos veces
 * en una reentrega y no puede producir dos recordatorios.
 *
 * Reprogramar uno ya `enviado` no lo revive: `WHERE ... estado = 'pendiente'` en el `DO UPDATE`.
 * Mandar dos veces el mismo recordatorio por un evento repetido sería peor que no mandarlo.
 */
async function programar(
    { idNegocio, canal, idExterno, referencia, plantilla, parametros = {}, enviarEn },
    { transaction }
) {
    if (!plantillasCatalogo.obtener(plantilla)) {
        throw new Error(`No existe la plantilla "${plantilla}" en el catálogo.`);
    }

    return (
        await sequelize.query(
            `
            INSERT INTO intelligence.recordatorio
                (id_negocio, canal, id_externo, referencia, plantilla, parametros, enviar_en)
            VALUES
                (:idNegocio, :canal, :idExterno, :referencia, :plantilla,
                 CAST(:parametros AS jsonb), :enviarEn)
            ON CONFLICT (id_negocio, referencia, plantilla) DO UPDATE
               SET enviar_en      = EXCLUDED.enviar_en,
                   parametros     = EXCLUDED.parametros,
                   id_externo     = EXCLUDED.id_externo,
                   actualizado_en = now()
             WHERE recordatorio.estado = 'pendiente'
            RETURNING id_recordatorio, enviar_en;
            `,
            {
                replacements: {
                    idNegocio,
                    canal,
                    idExterno,
                    referencia,
                    plantilla,
                    parametros: JSON.stringify(parametros ?? {}),
                    enviarEn,
                },
                transaction,
                ...SELECT,
            }
        )
    )[0] ?? null;
}

/** Da por muerto un recordatorio. Lo usa el propio drenaje; también sirve desde una CLI. */
async function cancelar({ idNegocio, referencia, motivo }, { transaction = null } = {}) {
    const filas = await sequelize.query(
        `
        UPDATE intelligence.recordatorio
           SET estado = 'cancelado', motivo = :motivo, actualizado_en = now()
         WHERE id_negocio = :idNegocio AND referencia = :referencia AND estado = 'pendiente'
        RETURNING id_recordatorio;
        `,
        { replacements: { idNegocio, referencia, motivo: motivo ?? null }, transaction, ...SELECT }
    );
    return filas.length;
}

// ── Drenar ──────────────────────────────────────────────────────────────────────────────────

/**
 * Reclama los que ya vencieron. `FOR UPDATE SKIP LOCKED` por el mismo motivo que en el outbox y
 * en el entregador: dos procesos drenando no pueden mandar el mismo recordatorio dos veces.
 */
async function reclamarVencidos({ lote, transaction }) {
    return sequelize.query(
        `
        SELECT id_recordatorio, id_negocio, canal, id_externo, referencia, plantilla,
               parametros, enviar_en, intentos
          FROM intelligence.recordatorio
         WHERE estado = 'pendiente'
           AND enviar_en <= now()
         ORDER BY enviar_en
         LIMIT :lote
           FOR UPDATE SKIP LOCKED;
        `,
        { replacements: { lote }, transaction, ...SELECT }
    );
}

async function marcar(id, { estado, motivo = null, idMensaje = null, enviarEn = null }, { transaction }) {
    await sequelize.query(
        `
        UPDATE intelligence.recordatorio
           SET estado         = :estado,
               motivo         = :motivo,
               id_mensaje     = COALESCE(:idMensaje, id_mensaje),
               enviar_en      = COALESCE(:enviarEn, enviar_en),
               intentos       = intentos + 1,
               actualizado_en = now()
         WHERE id_recordatorio = :id;
        `,
        { replacements: { id, estado, motivo, idMensaje, enviarEn }, transaction }
    );
}

/**
 * Convierte un recordatorio vencido en un saliente de verdad.
 *
 * A partir de aquí no hay nada nuevo: es el mismo camino que recorre cualquier respuesta desde
 * F5-C —`intelligence.mensaje` pendiente → entregador → adaptador → canal—. Lo único distinto es
 * que lleva `plantilla`, que es lo que le permite salir con la ventana de 24 h cerrada.
 *
 * El `contenido` va compuesto y no vacío: es lo que un humano lee en la Consola para saber qué
 * recibió el cliente, y lo que entrega un canal que no tenga plantillas.
 */
async function materializar(recordatorio, parametros, { transaction }) {
    const conversacion = await repositorio.asegurarConversacion(
        {
            idNegocio: recordatorio.id_negocio,
            canal: recordatorio.canal,
            idExterno: recordatorio.id_externo,
        },
        { transaction }
    );

    // A quien pidió la baja no se le escribe, y esto es lo único que lo impide aquí: el filtro del
    // entregador mira la conversación, pero para entonces el mensaje ya estaría creado y se
    // quedaría pendiente hasta caducar, ensuciando la cola y el Ledger con algo que no va a salir.
    if (conversacion.estado === 'bloqueada') {
        return { bloqueada: true, idMensaje: null };
    }

    const contenido = plantillasCatalogo.renderizarTexto(recordatorio.plantilla, parametros);
    const definicion = plantillasCatalogo.obtener(recordatorio.plantilla);

    const fila = await repositorio.insertarMensajeSaliente(
        {
            idConversacion: conversacion.id_conversacion,
            idNegocio: recordatorio.id_negocio,
            // Sin turno: no lo decidió una conversación, lo decidió un calendario. Que sea NULL
            // es la respuesta correcta a la pregunta «¿en qué turno se dijo esto?».
            idTurno: null,
            canal: recordatorio.canal,
            contenido,
            plantilla: {
                nombre: definicion.nombre,
                idioma: definicion.idioma,
                parametros,
            },
        },
        { transaction }
    );

    return { bloqueada: false, idMensaje: fila.id_mensaje };
}

/**
 * Un pase. Cada recordatorio va en su propia transacción: uno que falle no puede arrastrar a los
 * demás, y su `SKIP LOCKED` no vale de nada si todos comparten la misma.
 */
async function drenarUnaVez({ ahora = new Date() } = {}) {
    const resumen = { procesados: 0, enviados: 0, cancelados: 0, reprogramados: 0, fallidos: 0 };

    // Uno por transacción, y **reclamado dentro de ella**. La tentación era pedir el lote entero
    // en una transacción corta y luego procesarlos: eso confirma, suelta los locks, y el
    // `SKIP LOCKED` deja de proteger de nada — dos procesos drenando mandarían el mismo
    // recordatorio dos veces. Un lock que no dura tanto como el trabajo que protege no es un lock.
    for (let i = 0; i < CONFIG.lote; i++) {
        const t = await sequelize.transaction();
        const [recordatorio] = await reclamarVencidos({ lote: 1, transaction: t });
        if (!recordatorio) {
            await t.rollback();
            break;
        }
        resumen.procesados++;
        try {
            const revisor = revisorDe(recordatorio.referencia);
            if (!revisor) {
                await marcar(
                    recordatorio.id_recordatorio,
                    { estado: 'fallido', motivo: `sin revisor para "${recordatorio.referencia}"` },
                    { transaction: t }
                );
                resumen.fallidos++;
                await t.commit();
                continue;
            }

            const revision = await revisor(
                { referencia: recordatorio.referencia, idNegocio: recordatorio.id_negocio },
                { transaction: t }
            );

            if (!revision?.vigente) {
                await marcar(
                    recordatorio.id_recordatorio,
                    { estado: 'cancelado', motivo: revision?.motivo || 'ya no procede' },
                    { transaction: t }
                );
                resumen.cancelados++;
                await t.commit();
                continue;
            }

            // La cita se movió: el recordatorio se mueve con ella en vez de salir a destiempo.
            if (revision.enviarEn && new Date(revision.enviarEn) > ahora) {
                await marcar(
                    recordatorio.id_recordatorio,
                    { estado: 'pendiente', motivo: 'reprogramado al releer', enviarEn: revision.enviarEn },
                    { transaction: t }
                );
                resumen.reprogramados++;
                await t.commit();
                continue;
            }

            // Demasiado tarde: ver `toleranciaMinutos`.
            const retrasoMin = (ahora - new Date(recordatorio.enviar_en)) / 60000;
            if (retrasoMin > CONFIG.toleranciaMinutos) {
                await marcar(
                    recordatorio.id_recordatorio,
                    {
                        estado: 'cancelado',
                        motivo: `vencido hace ${Math.round(retrasoMin)} min, más de la tolerancia`,
                    },
                    { transaction: t }
                );
                resumen.cancelados++;
                await t.commit();
                continue;
            }

            const parametros = { ...recordatorio.parametros, ...(revision.parametros || {}) };
            const { bloqueada, idMensaje } = await materializar(recordatorio, parametros, {
                transaction: t,
            });

            if (bloqueada) {
                await marcar(
                    recordatorio.id_recordatorio,
                    { estado: 'cancelado', motivo: 'la conversación está bloqueada (opt-out)' },
                    { transaction: t }
                );
                resumen.cancelados++;
            } else {
                await marcar(
                    recordatorio.id_recordatorio,
                    { estado: 'enviado', motivo: null, idMensaje },
                    { transaction: t }
                );
                resumen.enviados++;
            }
            await t.commit();
        } catch (error) {
            await t.rollback();
            resumen.fallidos++;
            // El fallo se anota fuera de la transacción que acaba de morir: si se intentara
            // dentro, el `UPDATE` reventaría también y el recordatorio se quedaría `pendiente`
            // para siempre, reintentándose cada minuto. Es la misma lección del savepoint de
            // `decidir()` en el motor.
            const agotado = (recordatorio.intentos || 0) + 1 >= CONFIG.maxIntentos;
            try {
                await marcar(
                    recordatorio.id_recordatorio,
                    {
                        estado: agotado ? 'fallido' : 'pendiente',
                        motivo: String(error.message).slice(0, 2000),
                    },
                    { transaction: null }
                );
            } catch (secundario) {
                console.error('[recordatorios] no se pudo anotar el fallo:', secundario.message);
            }
            console.error(
                `[recordatorios] ${recordatorio.referencia} falló` +
                    `${agotado ? ' y agotó los intentos' : ', se reintentará'}: ${error.message}`
            );
        }
    }

    return resumen;
}

async function tick() {
    if (drenando) return;
    drenando = true;
    try {
        await drenarUnaVez();
    } catch (error) {
        console.error('[recordatorios] error drenando:', error.message);
    } finally {
        drenando = false;
    }
}

function iniciar() {
    if (temporizador) return;
    if (revisores.size === 0) {
        console.log('[recordatorios] Sin revisores registrados — no se drena nada.');
        return;
    }
    temporizador = setInterval(tick, CONFIG.intervaloMs);
    temporizador.unref?.();
    console.log(
        `[recordatorios] Iniciado — revisores: ${[...revisores.keys()].join(', ')}, ` +
            `sondeo cada ${CONFIG.intervaloMs}ms.`
    );
}

function detener() {
    if (temporizador) {
        clearInterval(temporizador);
        temporizador = null;
    }
}

module.exports = {
    CONFIG,
    registrarRevisor,
    limpiarRevisores,
    programar,
    cancelar,
    drenarUnaVez,
    iniciar,
    detener,
};
