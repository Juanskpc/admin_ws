/**
 * Reinicio de la conversación tras mucha inactividad.
 *
 * ## El síntoma en producción
 *
 * Tras varias horas sin escribir, el cliente mandaba un mensaje y el bot contestaba «Pasó un
 * rato y no me confirmaste, así que no hice nada. Si lo quieres, dímelo otra vez.» — el mensaje
 * de `confirmacion.js` cuando su hold de 10 minutos caducó. La confirmación caducaba bien (nunca
 * se ejecutaba: eso es ADR-010/023), pero seguía siendo LO PRIMERO que el flujo miraba
 * (`confirmacion.pendiente` es la primera rama tanto en `manejarRestaurante` como en
 * `manejarDeterminista`), así que el cliente recibía ese texto en vez de un saludo normal — un
 * mensaje sobre algo que ya no le importaba, dicho a alguien que había vuelto por otra cosa.
 *
 * ## La solución que se prueba aquí
 *
 * `repositorio.reiniciarSiInactivaMucho` (llamada desde `asegurarConversacion`, y solo desde el
 * único sitio donde entra un mensaje del CLIENTE: `motor.recibir`) mira el SILENCIO de la
 * conversación completa —no el de una tarea en concreto— y, si pasó más de
 * `CONVERSACION_INACTIVIDAD_RESET_MIN` (60 por defecto), limpia `tarea_actual`/`tarea_datos`/
 * `variables` ANTES de que el flujo vea el mensaje. Con eso limpio, el flujo de cada vertical
 * saluda por su cuenta —es la misma condición («sin tarea, sin turnos previos») que ya lo hace
 * saludar en la primera conversación de siempre—, y este archivo no necesita saber nada de
 * saludos ni de enlaces.
 *
 * ⚠️ Contra la base LOCAL (DB_PORT=5432). Ejecutar:
 *   npx jest __tests__/intelligence/reinicio_por_inactividad.test.js --forceExit
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const repositorio = require('../../intelligence/engine/repositorio');
const motor = require('../../intelligence/engine/motor');
const confirmacion = require('../../intelligence/engine/confirmacion');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const CANAL = 'whatsapp';
const CORRIDA = String(Date.now()).slice(-7);
let contador = 0;
let idNegocio;
const conversacionesCreadas = [];

beforeAll(async () => {
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    )).id_negocio;
});

afterAll(async () => {
    for (const id of conversacionesCreadas) {
        await sequelize.query(
            `DELETE FROM auditoria.audit_evento
              WHERE modulo = 'intelligence' AND (detalle->>'id_conversacion')::uuid = :id;`,
            { replacements: { id } },
        );
        await sequelize.query('DELETE FROM intelligence.mensaje WHERE id_conversacion = :id;', {
            replacements: { id },
        });
        await sequelize.query('DELETE FROM intelligence.conversacion WHERE id_conversacion = :id;', {
            replacements: { id },
        });
    }
    await sequelize.query(
        `DELETE FROM intelligence.ingesta_recibida WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo LIKE :patron;`,
        { replacements: { idNegocio, canal: CANAL, patron: `573${CORRIDA}%` } },
    );
    await sequelize.close();
});

function nuevoExterno() {
    return `573${CORRIDA}${String(contador++).padStart(2, '0')}`;
}

/** Una conversación con una tarea abierta, con el sello de silencio que se quiera fijar. */
async function conTarea({ haceMin, tarea = 'agendar_cita', datos = { paso: 'SERVICIO' }, estado = 'activa' }) {
    const idExterno = nuevoExterno();
    const t = await sequelize.transaction();
    let conversacion;
    try {
        conversacion = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno },
            { transaction: t },
        );
        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    await sequelize.query(
        `UPDATE intelligence.conversacion
            SET tarea_actual = :tarea,
                tarea_datos = CAST(:datos AS jsonb),
                variables = '{"turnos": 3, "nombre": "Ana"}'::jsonb,
                estado = :estado,
                ultimo_mensaje_en = now() - (:haceMin::numeric * interval '1 minute')
          WHERE id_conversacion = :id;`,
        { replacements: { id: conversacion.id_conversacion, tarea, datos: JSON.stringify(datos), estado, haceMin } },
    );
    conversacionesCreadas.push(conversacion.id_conversacion);
    return { ...conversacion, idExterno };
}

/** Lo que hace el motor cuando entra un mensaje del cliente: la vía real, de punta a punta. */
async function llegaMensajeDelCliente(idExterno, texto = 'hola') {
    return motor.recibir({
        idNegocio, canal: CANAL, idExterno, texto,
        idExternoMensaje: `msg-${idExterno}-${contador++}`,
        enviadoEn: new Date(), crudo: { texto },
        despertar: false, // el turno no importa aquí: solo el efecto de la ingesta sobre la conversación
    });
}

const filaDe = (id) => unaFila(
    `SELECT estado, tarea_actual, tarea_datos, variables FROM intelligence.conversacion WHERE id_conversacion = :id;`,
    { id },
);

const eventosDe = (idConversacion) => consulta(
    `SELECT detalle FROM auditoria.audit_evento
      WHERE modulo = 'intelligence' AND accion = 'conversacion_reiniciada_por_inactividad'
        AND (detalle->>'id_conversacion')::uuid = :id;`,
    { id: idConversacion },
);

describe('antes del umbral: continúa donde estaba', () => {
    test('59 minutos de silencio (umbral 60) no reinicia nada', async () => {
        const c = await conTarea({ haceMin: 59 });
        await llegaMensajeDelCliente(c.idExterno);

        const fila = await filaDe(c.id_conversacion);
        expect(fila.tarea_actual).toBe('agendar_cita');
        expect(fila.tarea_datos).toEqual({ paso: 'SERVICIO' });
        expect(fila.variables).toMatchObject({ turnos: 3, nombre: 'Ana' });
        expect(await eventosDe(c.id_conversacion)).toHaveLength(0);
    });

    test('sin tarea abierta, aunque lleve días en silencio, no hay nada que reiniciar (ni ruido en auditoría)', async () => {
        const c = await conTarea({ haceMin: 60 * 24 * 5, tarea: null, datos: {} });
        await llegaMensajeDelCliente(c.idExterno);

        expect(await eventosDe(c.id_conversacion)).toHaveLength(0);
    });
});

describe('pasado el umbral: conversación limpia', () => {
    test('61 minutos de silencio abandona la tarea (sin ejecutarla) y descarta la memoria', async () => {
        const c = await conTarea({ haceMin: 61, datos: { paso: 'FECHA', servicio: 5 } });
        await llegaMensajeDelCliente(c.idExterno);

        const fila = await filaDe(c.id_conversacion);
        expect(fila.tarea_actual).toBeNull();
        expect(fila.tarea_datos).toEqual({});
        expect(fila.variables).toEqual({});

        const eventos = await eventosDe(c.id_conversacion);
        expect(eventos).toHaveLength(1);
        expect(eventos[0].detalle).toMatchObject({
            tarea_abandonada: 'agendar_cita',
            datos_abandonados: { paso: 'FECHA', servicio: 5 },
            umbral_min: 60,
        });
        expect(eventos[0].detalle.minutos_inactiva).toBeGreaterThanOrEqual(61);
    });

    test('una CONFIRMACIÓN pendiente (el «sí» a medio contestar) también se abandona: nunca se ejecuta', async () => {
        // El mismo caso que reportó el dueño: una mutación esperando el sí, con horas de silencio.
        const c = await conTarea({
            haceMin: 90,
            tarea: confirmacion.TAREA,
            datos: { capacidad: 'cancelar_cita', args: { id_cita: 42 }, preguntado_en: new Date().toISOString() },
        });

        await llegaMensajeDelCliente(c.idExterno, 'hola, otra cosa');

        const fila = await filaDe(c.id_conversacion);
        expect(fila.tarea_actual).toBeNull();
        // Con la tarea ya limpia, `confirmacion.pendiente` no encuentra nada que resolver: no hay
        // manera de que el «cancelar_cita» pendiente llegue a ejecutarse por esta vía.
        expect(confirmacion.pendiente({ tarea_actual: fila.tarea_actual, tarea_datos: fila.tarea_datos })).toBeNull();
    });

    test('justo en el umbral (60 min exactos) todavía no reinicia: hace falta pasarlo', async () => {
        const c = await conTarea({ haceMin: 60 });
        await llegaMensajeDelCliente(c.idExterno);

        expect((await filaDe(c.id_conversacion)).tarea_actual).toBe('agendar_cita');
    });
});

describe('handoff_humano: no se reinicia solo', () => {
    test('una conversación en manos de una persona no se toca, aunque lleve días de silencio', async () => {
        const c = await conTarea({ haceMin: 60 * 24 * 3, estado: 'handoff_humano' });
        await llegaMensajeDelCliente(c.idExterno);

        const fila = await filaDe(c.id_conversacion);
        expect(fila.estado).toBe('handoff_humano');
        expect(fila.tarea_actual).toBe('agendar_cita'); // intacta: la regla de handoff es otra (reactivar_asistente_min)
        expect(await eventosDe(c.id_conversacion)).toHaveLength(0);
    });
});

describe('quién pide la opción', () => {
    test('una reentrega duplicada (mismo id_externo_mensaje) no reinicia nada', async () => {
        const c = await conTarea({ haceMin: 120 });
        const idExternoMensaje = `msg-dup-${c.idExterno}`;

        await motor.recibir({
            idNegocio, canal: CANAL, idExterno: c.idExterno, texto: 'hola',
            idExternoMensaje, enviadoEn: new Date(), crudo: {}, despertar: false,
        });
        // La primera entrega YA reinició (pasaron 120 min); se repite la MISMA entrega para
        // comprobar que una reentrega no vuelve a escribir un segundo evento de auditoría.
        await motor.recibir({
            idNegocio, canal: CANAL, idExterno: c.idExterno, texto: 'hola',
            idExternoMensaje, enviadoEn: new Date(), crudo: {}, despertar: false,
        });

        expect(await eventosDe(c.id_conversacion)).toHaveLength(1);
    });

    test('sin la opción (recordatorios/avisos) no reinicia, aunque el silencio sea enorme', async () => {
        const c = await conTarea({ haceMin: 60 * 24 * 30 });
        const t = await sequelize.transaction();
        try {
            // Igual que llaman `recordatorios/index.js` y los avisos: sin `reiniciarPorInactividad`.
            await repositorio.asegurarConversacion({ idNegocio, canal: CANAL, idExterno: c.idExterno }, { transaction: t });
            await t.commit();
        } catch (error) {
            await t.rollback();
            throw error;
        }

        expect((await filaDe(c.id_conversacion)).tarea_actual).toBe('agendar_cita');
        expect(await eventosDe(c.id_conversacion)).toHaveLength(0);
    });
});
