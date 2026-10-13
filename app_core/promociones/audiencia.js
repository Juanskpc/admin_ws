/**
 * A quién se le puede mandar una promoción (F0 de `docs/promociones-masivas.md`).
 *
 * ## El modelo, decidido el 2026-10-12: lista por defecto, con exclusiones
 *
 * **Al cliente final no se le pregunta nada.** La audiencia de un negocio son los clientes que ya
 * están en su base —los que pidieron y dejaron su teléfono, y los que tienen cuenta abierta a
 * mano—, y se les escribe salvo que hayan pedido que no. Es como funciona la publicidad que
 * recibe cualquiera: nadie le preguntó primero, y la ignora o se da de baja.
 *
 * La consecuencia para este módulo es que lo que hay que guardar con cuidado es **la salida**:
 * `promos_excluido`. Es lo único que bloquea un envío, y por eso las dos funciones que lo escriben
 * son las que más comentario llevan.
 *
 * ## Por qué esto es un módulo de `app_core` y no del motor ni de un vertical
 *
 * Porque la misma pregunta —«¿a quién puedo escribirle?»— la hacen cuatro sitios y ninguno manda
 * sobre los otros: el **asistente** (cuando alguien pide la baja por WhatsApp), el **personal**
 * desde la ficha del cliente, la **vista de Promociones** al estimar el tamaño y el costo, y el
 * **envío** en sí. Con la consulta copiada en cada uno, el día que cambie el criterio —y va a
 * cambiar: falta la frecuencia, el país, el tope por campaña— quedarían cuatro criterios y el que
 * de verdad envía no sería necesariamente el que alguien arregló. Es la lección de
 * `unirRespuestas`: una regla de plataforma puesta dentro de un consumidor solo se aplica a ese
 * consumidor.
 *
 * ## ⚠️ `consentimiento_mensajeria` no se mira, y no es un olvido
 *
 * Esa columna es de ADR-006 y significa **el cliente dijo explícitamente que sí**. Nadie la pone
 * en `true` hoy, así que usarla como filtro dejaría la audiencia en cero para siempre — que es
 * exactamente lo que el modelo nuevo descarta. Se conserva intacta: si algún día hay una casilla
 * en la vitrina, volverá a servir y **sumará**, nunca restará.
 *
 * ## Las de lectura no lanzan cuando las llama el asistente
 *
 * `excluirPorTelefono` la llama el motor en medio de un turno que el cliente está esperando: falla
 * devolviendo `false`, nunca lanzando — la misma decisión que `enviarIndicadorEscritura` («una
 * excepción que sube desde aquí se llevaría por delante la respuesta que el cliente sí estaba
 * esperando»). Las que llama un controlador —`excluir`, `readmitir`— sí lanzan errores tipados,
 * porque ahí el fallo hay que contarlo.
 */
'use strict';

const Models = require('../models/conection');
const auditHelper = require('../helpers/auditHelper');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

/**
 * Por dónde llegó la decisión del cliente. Están en el CHECK de la columna, así que esta lista y
 * la de la base **tienen que decir lo mismo**: añadir uno aquí sin migrarlo es un 23514 en
 * producción.
 */
const ORIGEN = {
    /** Lo escribió el cliente por el canal («no promos»). */
    ASISTENTE: 'asistente',
    /** Lo dijo en persona y lo marcó el cajero. */
    MOSTRADOR: 'mostrador',
    /** Lo marcó en la web pública del negocio. */
    VITRINA: 'vitrina',
    /** Venía marcado en una lista que se importó. */
    IMPORTADO: 'importado',
    /** Lo marcó el personal desde la ficha, sin decir dónde lo pidió. */
    NEGOCIO: 'negocio',
};

const ORIGENES = new Set(Object.values(ORIGEN));

const MODULO_AUDITORIA = 'promociones';

function fallo(mensaje, { code, statusCode = 422 }) {
    const error = new Error(mensaje);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function exigirOrigen(origen) {
    if (!ORIGENES.has(origen)) {
        throw fallo(`Origen no válido: "${origen}".`, { code: 'PROMOS_ORIGEN_INVALIDO' });
    }
}

/**
 * La ficha de una persona del negocio por su teléfono, con lo que hace falta para decidir sobre
 * promociones. `null` si no existe (quien nunca pidió no tiene ficha: la crea el camino de
 * escritura, no una conversación — ver `engine/identidad.buscarPersonaPorTelefono`).
 */
async function porTelefono({ idNegocio, telefono, transaction = null } = {}) {
    if (!telefono) return null;
    const filas = await sequelize.query(
        `SELECT pn.id_persona_negocio,
                pn.nombre_mostrado,
                pn.telefono_e164,
                pn.promos_excluido,
                pn.promos_excluido_en,
                pn.consentimiento_origen
           FROM platform.persona_negocio pn
          WHERE pn.id_negocio = :idNegocio
            AND pn.telefono_e164 = :telefono
          LIMIT 1;`,
        { replacements: { idNegocio: Number(idNegocio), telefono }, ...SELECT, transaction }
    );
    return filas?.[0] ?? null;
}

/**
 * Saca a una persona de las promociones.
 *
 * **No borra nada y guarda con qué palabras lo pidió.** Es lo único que hay que poder demostrar
 * si alguien reclama: no que autorizó, sino que cuando dijo «no» se le hizo caso y desde cuándo.
 *
 * Si ya estaba excluida no pasa nada y no se registra evento: una baja repetida es la misma baja.
 */
async function excluir({
    idNegocio,
    idPersonaNegocio,
    origen = ORIGEN.ASISTENTE,
    prueba = null,
    idUsuario = null,
    transaction = null,
} = {}) {
    exigirOrigen(origen);
    if (!idPersonaNegocio) {
        throw fallo('Falta la persona que se saca de las promociones.', {
            code: 'PROMOS_SIN_PERSONA',
        });
    }

    const [filas] = await sequelize.query(
        `UPDATE platform.persona_negocio
            SET promos_excluido       = true,
                promos_excluido_en    = now(),
                consentimiento_origen = :origen,
                consentimiento_prueba = :prueba::jsonb,
                actualizado_en        = now()
          WHERE id_persona_negocio = :id
            AND id_negocio = :idNegocio
            AND NOT promos_excluido
        RETURNING id_persona_negocio;`,
        {
            replacements: {
                id: idPersonaNegocio,
                idNegocio: Number(idNegocio),
                origen,
                prueba: prueba ? JSON.stringify(prueba) : null,
            },
            transaction,
        }
    );

    if (!filas?.[0]) return { excluido: false, yaEstaba: true };

    await auditHelper.registrarEvento({
        modulo: MODULO_AUDITORIA,
        accion: 'baja_promociones',
        idNegocio: Number(idNegocio),
        idUsuario,
        detalle: { id_persona_negocio: idPersonaNegocio, origen, prueba },
        transaction,
    });

    return { excluido: true };
}

/**
 * Vuelve a meter a alguien en las promociones.
 *
 * Existe para deshacer un error —el cajero que marcó la ficha equivocada, o el cliente que pide
 * volver—, **no** para «reactivar» una lista de bajas. Por eso lleva `idUsuario` y deja su propio
 * evento: una readmisión siempre la decide una persona, y tiene que quedar dicho quién.
 */
async function readmitir({
    idNegocio,
    idPersonaNegocio,
    idUsuario = null,
    transaction = null,
} = {}) {
    const [filas] = await sequelize.query(
        `UPDATE platform.persona_negocio
            SET promos_excluido    = false,
                promos_excluido_en = NULL,
                actualizado_en     = now()
          WHERE id_persona_negocio = :id
            AND id_negocio = :idNegocio
            AND promos_excluido
        RETURNING id_persona_negocio;`,
        {
            replacements: { id: idPersonaNegocio, idNegocio: Number(idNegocio) },
            transaction,
        }
    );

    if (!filas?.[0]) return { readmitido: false };

    await auditHelper.registrarEvento({
        modulo: MODULO_AUDITORIA,
        accion: 'readmision_promociones',
        idNegocio: Number(idNegocio),
        idUsuario,
        detalle: { id_persona_negocio: idPersonaNegocio },
        transaction,
    });

    return { readmitido: true };
}

/**
 * La baja por teléfono, que es la forma en que llega desde el canal: el cliente escribe «no
 * promos» y lo único que se sabe de él es su número.
 *
 * **No lanza nunca.** Quien pide la baja tiene que quedar de baja o, como mínimo, no quedarse
 * esperando una respuesta porque la consulta falló.
 */
async function excluirPorTelefono({ idNegocio, telefono, prueba = null, transaction = null } = {}) {
    try {
        const persona = await porTelefono({ idNegocio, telefono, transaction });
        // Sin ficha no hay nada que excluir, y eso NO es un error: a quien no está en la base
        // tampoco se le va a mandar ninguna promoción.
        if (!persona) return { excluido: false, sinFicha: true };
        return await excluir({
            idNegocio,
            idPersonaNegocio: persona.id_persona_negocio,
            origen: ORIGEN.ASISTENTE,
            prueba,
            transaction,
        });
    } catch (error) {
        console.warn('[promociones] no se pudo registrar la baja:', error.message);
        return { excluido: false, error: error.message };
    }
}

/**
 * A cuántos se le puede escribir hoy en este negocio, y quién queda fuera y por qué.
 *
 * Es la cifra que la vista de Promociones enseña antes de dejar armar nada: el tamaño real de la
 * audiencia y el costo que va a tener salen de aquí.
 *
 * ⚠️ **Las conversaciones bloqueadas se descuentan aparte.** Quien escribió `STOP` queda con la
 * conversación `bloqueada` y el motor no vuelve a procesarla (ver `engine/optout.js`). La baja
 * dura marca además `promos_excluido`, pero las bloqueadas **antes** de que esto existiera no lo
 * tienen: por eso se cruza también por el estado de la conversación. Escribirle una promoción a
 * alguien que pidió no recibir nada es la clase de fallo que no se arregla con una disculpa.
 */
async function resumenDeAudiencia({ idNegocio } = {}) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id)) {
        throw fallo('Falta el negocio.', { code: 'NEGOCIO_REQUERIDO', statusCode: 400 });
    }

    const [fila] = await sequelize.query(
        `WITH personas AS (
             SELECT pn.id_persona_negocio,
                    pn.telefono_e164,
                    pn.promos_excluido,
                    EXISTS (
                        -- Se cruza por (negocio, canal, id_externo), que es la UNIQUE de la
                        -- tabla, y NO por conversacion.id_persona_negocio: esa columna existe
                        -- pero hoy nadie la escribe (se lee en reportarAutomaticamente y nada
                        -- más), así que un JOIN por ella no encontraría a nadie. El id_externo
                        -- de WhatsApp es el "from" del webhook: los dígitos sin el «+».
                        SELECT 1
                          FROM intelligence.conversacion c
                         WHERE c.id_negocio = pn.id_negocio
                           AND c.canal = 'whatsapp'
                           AND c.id_externo = ltrim(pn.telefono_e164, '+')
                           AND c.estado = 'bloqueada'
                    ) AS bloqueado
               FROM platform.persona_negocio pn
              WHERE pn.id_negocio = :idNegocio
         )
         SELECT COUNT(*)::int AS personas,
                COUNT(*) FILTER (WHERE telefono_e164 IS NOT NULL)::int AS con_telefono,
                COUNT(*) FILTER (
                    WHERE telefono_e164 IS NOT NULL
                      AND NOT promos_excluido
                      AND NOT bloqueado
                )::int AS contactables,
                COUNT(*) FILTER (WHERE promos_excluido)::int AS de_baja,
                COUNT(*) FILTER (WHERE bloqueado)::int AS bloqueados,
                COUNT(*) FILTER (WHERE telefono_e164 IS NULL)::int AS sin_telefono
           FROM personas;`,
        { replacements: { idNegocio: id }, ...SELECT }
    );

    return {
        personas: Number(fila?.personas || 0),
        con_telefono: Number(fila?.con_telefono || 0),
        /** Los que recibirían una promoción hoy. Es la cifra que manda. */
        contactables: Number(fila?.contactables || 0),
        de_baja: Number(fila?.de_baja || 0),
        bloqueados: Number(fila?.bloqueados || 0),
        sin_telefono: Number(fila?.sin_telefono || 0),
    };
}

/**
 * ¿Se le puede escribir a esta persona? La misma regla que cuenta `resumenDeAudiencia`, para una
 * sola ficha.
 *
 * Existe porque el envío tiene que volver a comprobarlo **por destinatario y en el momento de
 * mandar**, no solo al armar la campaña: entre que el dueño aprieta «enviar» y sale el mensaje
 * número 400 pueden pasar horas, y en esas horas alguien puede haberse dado de baja. Un filtro
 * aplicado solo al principio es un mensaje que sale después de la baja.
 */
async function esContactable({ idNegocio, idPersonaNegocio, transaction = null } = {}) {
    const [fila] = await sequelize.query(
        `SELECT pn.telefono_e164 IS NOT NULL
                AND NOT pn.promos_excluido
                AND NOT EXISTS (
                    SELECT 1
                      FROM intelligence.conversacion c
                     WHERE c.id_negocio = pn.id_negocio
                       AND c.canal = 'whatsapp'
                       AND c.id_externo = ltrim(pn.telefono_e164, '+')
                       AND c.estado = 'bloqueada'
                ) AS contactable
           FROM platform.persona_negocio pn
          WHERE pn.id_persona_negocio = :id
            AND pn.id_negocio = :idNegocio;`,
        {
            replacements: { id: idPersonaNegocio, idNegocio: Number(idNegocio) },
            ...SELECT,
            transaction,
        }
    );
    // Sin fila (otra ficha, otro negocio) la respuesta es no. Falla cerrado a propósito: el error
    // barato es no mandar una promoción; el caro es mandarla a quien no debía.
    return Boolean(fila?.contactable);
}

module.exports = {
    ORIGEN,
    porTelefono,
    excluir,
    readmitir,
    excluirPorTelefono,
    esContactable,
    resumenDeAudiencia,
};
