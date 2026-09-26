/**
 * Reportar a quien usa el asistente para nada.
 *
 * ## Qué se prueba de verdad
 *
 * El camino feliz («reporté y salió un 1») se lee en el código. Lo que no se lee, y es lo que
 * rompe en producción, son estas cuatro:
 *
 *   1. **Un clic repetido no son dos reportes.** La bandeja se refresca sola cada cinco segundos
 *      y el botón está al lado del de responder: pulsar dos veces es lo normal, no lo raro. Lo
 *      garantiza una UNIQUE parcial en la base, así que se prueba contra la base.
 *   2. **La frontera entre inquilinos también aquí.** Reportar es escribir, y una escritura nueva
 *      sobre una superficie compartida es exactamente donde F2 encontró una fuga.
 *   3. **Retirar quita el mío y solo el mío.** El del asistente no lo borra una persona.
 *   4. **Reportar no toca la conversación.** Ni el estado, ni `atendida_en`, ni el asistente. Si
 *      esto se rompiera, marcar a alguien tendría efectos que quien pulsa no pidió — y el peor
 *      de ellos sería dejar de contestarle a un cliente por error.
 *
 * Y las reglas del reporte automático se prueban **sin base de datos**: son producto, van a
 * cambiar con lo que se vea en producción, y tienen que poder cambiarse sin montar un fixture.
 *
 * ⚠️ Contra la base de desarrollo, igual que `bandeja.test.js`.
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const repositorio = require('../../intelligence/engine/repositorio');
const reporteAutomatico = require('../../intelligence/engine/reporteAutomatico');
const Bandeja = require('../../app_admin_api/controllers/intelligenceBandejaController');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });

const CANAL = 'whatsapp';
const CORRIDA = String(Date.now()).slice(-7);
let contador = 0;

let negocioA;
let negocioB;
let usuarioA;
let usuarioB;

function resFalso() {
    const capturado = { statusCode: 200, cuerpo: null };
    return {
        capturado,
        status(code) {
            capturado.statusCode = code;
            return this;
        },
        json(payload) {
            capturado.cuerpo = payload;
            return this;
        },
    };
}

async function llamar(controlador, { idUsuario, query = {}, params = {}, body = {} } = {}) {
    const res = resFalso();
    await controlador({ query, params, body, usuario: { id_usuario: idUsuario } }, res);
    return res.capturado;
}

/** Una conversación con un entrante reciente, que es lo que la deja en un estado normal. */
async function nuevaConversacion(idNegocio) {
    const idExterno = `573${CORRIDA}${String(contador++).padStart(2, '0')}`;
    const t = await sequelize.transaction();
    let conversacion;
    try {
        conversacion = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno },
            { transaction: t }
        );
        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    await sequelize.query(
        `
        INSERT INTO intelligence.mensaje
            (id_conversacion, id_negocio, direccion, canal, contenido, enviado_en, creado_en)
        VALUES (:id, :idNegocio, 'entrante', :canal, 'hola', now() - interval '1 hour',
                now() - interval '1 hour');
        `,
        {
            replacements: { id: conversacion.id_conversacion, idNegocio, canal: CANAL },
            logging: false,
        }
    );
    return conversacion;
}

const reportesDeLaConversacion = (id) =>
    consulta(
        `SELECT origen, motivo, estado, id_usuario FROM intelligence.reporte
          WHERE id_conversacion = :id ORDER BY creado_en;`,
        { id }
    );

beforeAll(async () => {
    // Dos negocios con un usuario propio cada uno: es la frontera que se va a empujar. Mismo
    // criterio que `bandeja.test.js` — si el seed cambia, el test lo dice en vez de fallar raro.
    const pares = await consulta(
        `
        SELECT nu.id_negocio, nu.id_usuario
          FROM general.gener_negocio_usuario nu
          JOIN general.gener_negocio n ON n.id_negocio = nu.id_negocio AND n.estado = 'A'
         WHERE nu.estado = 'A'
           AND NOT EXISTS (
               SELECT 1 FROM general.gener_usuario_rol ur
                 JOIN general.gener_rol r ON r.id_rol = ur.id_rol
                WHERE ur.id_usuario = nu.id_usuario AND ur.estado = 'A'
                  AND UPPER(TRIM(r.descripcion)) = 'SUPER ADMINISTRADOR')
         ORDER BY nu.id_negocio;
        `
    );

    for (const p of pares) {
        if (pares.filter((x) => x.id_usuario === p.id_usuario).length !== 1) continue;
        if (negocioA == null) {
            negocioA = p.id_negocio;
            usuarioA = p.id_usuario;
        } else if (p.id_negocio !== negocioA) {
            negocioB = p.id_negocio;
            usuarioB = p.id_usuario;
            break;
        }
    }

    if (negocioB == null) {
        throw new Error(
            'Hacen falta dos negocios con un usuario propio cada uno. Corre scripts/seed_dev_local.js.'
        );
    }
});

afterAll(async () => {
    await sequelize.close();
});

describe('reportar desde la bandeja', () => {
    test('deja el conteo en uno y dice que el reporte es mío', async () => {
        const c = await nuevaConversacion(negocioA);

        const r = await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { motivo: 'spam', nota: 'escribe lo mismo todo el día' },
        });

        expect(r.statusCode).toBe(200);
        expect(r.cuerpo.data.reportes.persona).toBe(1);
        expect(r.cuerpo.data.reportes.conversacion).toBe(1);
        expect(r.cuerpo.data.reportes.mio).toBe('spam');
    });

    test('dos clics son un reporte, no dos', async () => {
        const c = await nuevaConversacion(negocioA);
        const body = { motivo: 'fuera_de_tema' };

        await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body,
        });
        const segundo = await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body,
        });

        // 200 y no 409: lo que el usuario pidió ya está hecho — la conversación está reportada.
        expect(segundo.statusCode).toBe(200);
        expect(segundo.cuerpo.data.reportes.persona).toBe(1);
        expect(await reportesDeLaConversacion(c.id_conversacion)).toHaveLength(1);
    });

    test('no cambia el estado de la conversación ni la da por atendida', async () => {
        const c = await nuevaConversacion(negocioA);

        await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { motivo: 'abuso' },
        });

        const [fila] = await consulta(
            `SELECT estado, atendida_en FROM intelligence.conversacion WHERE id_conversacion = :id;`,
            { id: c.id_conversacion }
        );
        expect(fila.estado).toBe('activa');
        expect(fila.atendida_en).toBeNull();
    });

    test('no se puede reportar una conversación de otro negocio', async () => {
        const ajena = await nuevaConversacion(negocioB);

        const r = await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: ajena.id_conversacion },
            body: { motivo: 'spam' },
        });

        // 404 y no 403, como el resto de la bandeja: un 403 confirmaría que ese UUID existe.
        expect(r.statusCode).toBe(404);
        expect(await reportesDeLaConversacion(ajena.id_conversacion)).toHaveLength(0);
    });

    test('el detalle trae el conteo y el catálogo de motivos', async () => {
        const c = await nuevaConversacion(negocioA);
        await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { motivo: 'otro' },
        });

        const r = await llamar(Bandeja.detalleConversacion, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
        });

        expect(r.cuerpo.data.reportes.persona).toBe(1);
        expect(r.cuerpo.data.motivos).toContain('spam');
    });

    test('la lista trae el contador del contacto', async () => {
        const c = await nuevaConversacion(negocioA);
        await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { motivo: 'spam' },
        });

        const r = await llamar(Bandeja.listarConversaciones, { idUsuario: usuarioA });
        const fila = r.cuerpo.data.conversaciones.find(
            (x) => x.id_conversacion === c.id_conversacion
        );
        expect(Number(fila.reportes)).toBe(1);
    });
});

describe('retirar el reporte', () => {
    test('deja el conteo en cero y la fila queda descartada, no borrada', async () => {
        const c = await nuevaConversacion(negocioA);
        await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { motivo: 'spam' },
        });

        const r = await llamar(Bandeja.retirarReporte, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
        });

        expect(r.cuerpo.data.reportes.persona).toBe(0);
        expect(r.cuerpo.data.reportes.mio).toBeNull();

        // El histórico de quién marcó a quién es justo lo que hará falta si se discute un
        // bloqueo: la fila sigue ahí, descartada.
        const filas = await reportesDeLaConversacion(c.id_conversacion);
        expect(filas).toHaveLength(1);
        expect(filas[0].estado).toBe('descartado');
    });

    test('una persona no retira el reporte del asistente', async () => {
        const c = await nuevaConversacion(negocioA);
        await repositorio.reportarAutomaticamente({
            conversacion: c,
            motivo: 'sin_avance',
            senales: { turnos: 40 },
        });

        const r = await llamar(Bandeja.retirarReporte, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
        });

        // El del bot se revisa, no se borra de un clic: sigue contando.
        expect(r.cuerpo.data.reportes.persona).toBe(1);
        expect(r.cuerpo.data.reportes.del_asistente).toBe(1);
    });
});

describe('el reporte del asistente', () => {
    test('no insiste: mientras el suyo siga abierto no pone otro', async () => {
        const c = await nuevaConversacion(negocioA);

        const primero = await repositorio.reportarAutomaticamente({
            conversacion: c,
            motivo: 'automatizado',
            senales: { repeticion_maxima: 12 },
        });
        const segundo = await repositorio.reportarAutomaticamente({
            conversacion: c,
            motivo: 'sin_avance',
            senales: { turnos: 40 },
        });

        expect(primero).toBe(true);
        expect(segundo).toBe(false);
        expect(await reportesDeLaConversacion(c.id_conversacion)).toHaveLength(1);
    });

    test('convive con el de una persona: son dos opiniones, no una', async () => {
        const c = await nuevaConversacion(negocioA);

        await repositorio.reportarAutomaticamente({
            conversacion: c,
            motivo: 'sin_avance',
            senales: {},
        });
        const r = await llamar(Bandeja.reportar, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { motivo: 'abuso' },
        });

        expect(r.cuerpo.data.reportes.persona).toBe(2);
        expect(r.cuerpo.data.reportes.del_asistente).toBe(1);
        expect(r.cuerpo.data.reportes.mio).toBe('abuso');
    });

    test('un turno determinista no mira nada: es gratis y no hay nada que vigilar', async () => {
        const c = await nuevaConversacion(negocioA);

        const r = await reporteAutomatico.evaluar({
            conversacion: c,
            nivel: 'determinista',
        });

        expect(r.reportado).toBe(false);
        expect(await reportesDeLaConversacion(c.id_conversacion)).toHaveLength(0);
    });
});

describe('las reglas del reporte automático', () => {
    const { turnosMinimos, repeticiones, costoUsd } = reporteAutomatico.CONFIG;
    const base = {
        turnos: 0,
        turnos_llm: 0,
        resueltos: 0,
        costo_usd: 0,
        capacidades_ok: 0,
        entrantes: 0,
        repeticion_maxima: 0,
    };

    test('una conversación normal no se reporta', () => {
        expect(reporteAutomatico.motivoPara({ ...base, turnos: 12, resueltos: 3 })).toBeNull();
    });

    test('el mismo texto una y otra vez es automatizado', () => {
        expect(
            reporteAutomatico.motivoPara({ ...base, repeticion_maxima: repeticiones })
        ).toBe('automatizado');
    });

    test('mucho turno sin que pase nada es sin_avance', () => {
        expect(reporteAutomatico.motivoPara({ ...base, turnos: turnosMinimos })).toBe('sin_avance');
    });

    test('gastar en el modelo sin hacer nada es spam', () => {
        expect(reporteAutomatico.motivoPara({ ...base, costo_usd: costoUsd })).toBe('spam');
    });

    test('un cliente pesado que SÍ compra no se reporta nunca', () => {
        // La señal que separa al cliente indeciso del que juega: llegó a hacer algo.
        expect(
            reporteAutomatico.motivoPara({
                ...base,
                turnos: turnosMinimos * 2,
                costo_usd: costoUsd * 3,
                capacidades_ok: 1,
            })
        ).toBeNull();
    });
});
