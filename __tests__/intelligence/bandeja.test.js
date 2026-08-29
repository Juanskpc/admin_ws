/**
 * La Bandeja del inquilino — ver las conversaciones propias, y responder.
 *
 * ## Qué se está probando de verdad
 *
 * La Consola de super admin ya estaba probada (`consola.test.js`) y esto reutiliza sus consultas,
 * así que lo interesante no es que la lista salga: es lo que **cambia** al abrirla a un inquilino.
 * Dos cosas, y las dos son de las que no se ven leyendo el código:
 *
 *   1. **El aislamiento entre negocios.** Un inquilino no puede leer la conversación de otro ni
 *      escribir en ella, aunque acierte el UUID. F2 cerró una fuga real por aquí, y el patrón que
 *      la causó —creerse el `id_negocio` que venía en la petición— es exactamente el que esta
 *      superficie vuelve a tener a mano.
 *   2. **Que responder tome la conversación.** Si el bot siguiera contestando después de que una
 *      persona escribe, el cliente final recibiría dos voces distintas: es peor que el problema
 *      que la bandeja resuelve.
 *
 * Y una tercera que es de honestidad: fuera de la ventana de 24 h **se rechaza aquí**, no se
 * acepta para que falle en silencio tres capas más abajo.
 *
 * Las conversaciones se montan con fixtures y no conversando de verdad —al revés que
 * `consola.test.js`— porque lo que se mide es el instante del último entrante y la frontera entre
 * dos negocios, y las dos cosas hay que **controlarlas**, no observarlas. Es el mismo criterio de
 * `ventana.test.js`.
 *
 * ⚠️ Contra la base LOCAL (DB_PORT=5432).
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const repositorio = require('../../intelligence/engine/repositorio');
const Bandeja = require('../../app_admin_api/controllers/intelligenceBandejaController');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const CANAL = 'whatsapp';
let contador = 0;

/**
 * Prefijo único por ejecución.
 *
 * Sin él, `asegurarConversacion` reencuentra la conversación que dejó la corrida anterior con el
 * mismo teléfono ficticio: las afirmaciones sobre el estado inicial y sobre «cuántos salientes
 * hay» miden entonces la historia acumulada, no lo que hizo este test. Costó dos fallos
 * entender que el código estaba bien y el fixture mal.
 */
const CORRIDA = String(Date.now()).slice(-7);

/** Dos inquilinos distintos, y el usuario que pertenece a cada uno. */
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

/**
 * Una conversación con un entrante colocado en el instante que interesa.
 *
 * `haceHoras` es la palanca de la ventana: 1 la deja abierta, 30 la deja cerrada sin depender de
 * cuándo se corra la suite.
 */
async function nuevaConversacion({ idNegocio, haceHoras = 1 }) {
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

    if (haceHoras !== null) {
        await sequelize.query(
            `
            INSERT INTO intelligence.mensaje
                (id_conversacion, id_negocio, direccion, canal, contenido, enviado_en, creado_en)
            VALUES (:id, :idNegocio, 'entrante', :canal, 'hola',
                    now() - (:horas || ' hours')::interval,
                    now() - (:horas || ' hours')::interval);
            `,
            {
                replacements: {
                    id: conversacion.id_conversacion,
                    idNegocio,
                    canal: CANAL,
                    horas: String(haceHoras),
                },
                logging: false,
            }
        );
    }
    return conversacion;
}

beforeAll(async () => {
    // Se buscan dos negocios que tengan cada uno un usuario que NO esté en el otro. Si el seed
    // cambia, el test lo dice en vez de fallar de una forma que parezca un bug del código.
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
        const negociosDelUsuario = pares.filter((x) => x.id_usuario === p.id_usuario);
        if (negociosDelUsuario.length !== 1) continue; // pertenece a varios: no sirve de frontera
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

describe('un inquilino solo ve lo suyo', () => {
    test('la lista no trae conversaciones de otro negocio', async () => {
        await nuevaConversacion({ idNegocio: negocioB });

        const r = await llamar(Bandeja.listarConversaciones, { idUsuario: usuarioA });

        expect(r.cuerpo.success).toBe(true);
        const ajenas = r.cuerpo.data.conversaciones.filter((c) => c.id_negocio !== negocioA);
        expect(ajenas).toEqual([]);
    });

    test('pedir el id_negocio de otro no lo abre', async () => {
        await nuevaConversacion({ idNegocio: negocioB });

        // El intento evidente: mandar en la URL el negocio del vecino. No se cree el parámetro,
        // se cruza contra los negocios del usuario.
        const r = await llamar(Bandeja.listarConversaciones, {
            idUsuario: usuarioA,
            query: { id_negocio: String(negocioB) },
        });

        expect(r.cuerpo.data.conversaciones).toEqual([]);
    });

    test('el detalle de una conversación ajena responde 404, no 403', async () => {
        // 403 confirmaría que ese UUID existe. Entre inquilinos, eso ya es filtrar.
        const ajena = await nuevaConversacion({ idNegocio: negocioB });

        const r = await llamar(Bandeja.detalleConversacion, {
            idUsuario: usuarioA,
            params: { id: ajena.id_conversacion },
        });

        expect(r.statusCode).toBe(404);
    });

    test('tampoco se puede responder en una conversación ajena', async () => {
        const ajena = await nuevaConversacion({ idNegocio: negocioB });

        const r = await llamar(Bandeja.responder, {
            idUsuario: usuarioA,
            params: { id: ajena.id_conversacion },
            body: { texto: 'hola desde otro negocio' },
        });

        expect(r.statusCode).toBe(404);

        const salientes = await consulta(
            `SELECT 1 FROM intelligence.mensaje
              WHERE id_conversacion = :id AND direccion = 'saliente';`,
            { id: ajena.id_conversacion }
        );
        expect(salientes).toEqual([]);
    });

    test('la suya sí la ve, con el hilo y el estado de la ventana', async () => {
        const propia = await nuevaConversacion({ idNegocio: negocioA });

        const r = await llamar(Bandeja.detalleConversacion, {
            idUsuario: usuarioA,
            params: { id: propia.id_conversacion },
        });

        expect(r.cuerpo.success).toBe(true);
        expect(r.cuerpo.data.mensajes.length).toBeGreaterThan(0);
        expect(r.cuerpo.data.ventana.abierta).toBe(true);
    });
});

describe('responder', () => {
    test('encola el saliente y calla al bot', async () => {
        const c = await nuevaConversacion({ idNegocio: negocioA });
        expect(c.estado).not.toBe('handoff_humano');

        const r = await llamar(Bandeja.responder, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { texto: 'Buenas, te atiendo yo. ¿Qué necesitabas?' },
        });

        expect(r.cuerpo.success).toBe(true);

        // Nace pendiente: quien entrega es el Channel Gateway, no este endpoint.
        const saliente = await unaFila(
            `SELECT contenido, estado_entrega FROM intelligence.mensaje
              WHERE id_conversacion = :id AND direccion = 'saliente';`,
            { id: c.id_conversacion }
        );
        expect(saliente.estado_entrega).toBe('pendiente');
        expect(saliente.contenido).toContain('te atiendo yo');

        // Y la conversación queda tomada por la persona: el bot no vuelve (ADR-023).
        const despues = await unaFila(
            `SELECT estado FROM intelligence.conversacion WHERE id_conversacion = :id;`,
            { id: c.id_conversacion }
        );
        expect(despues.estado).toBe('handoff_humano');
    });

    test('fuera de la ventana de 24 h se rechaza aquí, no al entregar', async () => {
        // Aceptarlo sería mentirle a quien escribe: la Cloud API lo rechazaría después, de forma
        // asíncrona, y nadie volvería a mirar.
        const c = await nuevaConversacion({ idNegocio: negocioA, haceHoras: 30 });

        const r = await llamar(Bandeja.responder, {
            idUsuario: usuarioA,
            params: { id: c.id_conversacion },
            body: { texto: 'Perdona la tardanza' },
        });

        expect(r.statusCode).toBe(409);
        expect(r.cuerpo.errors[0].codigo).toBe('VENTANA_CERRADA');

        const salientes = await consulta(
            `SELECT 1 FROM intelligence.mensaje
              WHERE id_conversacion = :id AND direccion = 'saliente';`,
            { id: c.id_conversacion }
        );
        expect(salientes).toEqual([]);
    });

    test('no se envía si el número configurado es de OTRO negocio', async () => {
        // Hasta F8-C hay un solo número global y `entregar()` no mira de quién es la
        // conversación: responderle al cliente del negocio B saldría por el número del A. Ya
        // pasó con un recordatorio el 2026-08-28. La bandeja no puede arreglarlo, pero sí
        // negarse a causarlo.
        const c = await nuevaConversacion({ idNegocio: negocioA });
        const previo = {
            negocio: process.env.WHATSAPP_NEGOCIO_ID,
            numero: process.env.WHATSAPP_PHONE_NUMBER_ID,
        };
        process.env.WHATSAPP_NEGOCIO_ID = String(negocioB);
        process.env.WHATSAPP_PHONE_NUMBER_ID = 'NUM_DE_OTRO';

        try {
            const r = await llamar(Bandeja.responder, {
                idUsuario: usuarioA,
                params: { id: c.id_conversacion },
                body: { texto: 'esto no debe salir' },
            });

            expect(r.statusCode).toBe(409);
            expect(r.cuerpo.errors[0].codigo).toBe('NUMERO_DE_OTRO_NEGOCIO');

            const salientes = await consulta(
                `SELECT 1 FROM intelligence.mensaje
                  WHERE id_conversacion = :id AND direccion = 'saliente';`,
                { id: c.id_conversacion }
            );
            expect(salientes).toEqual([]);
        } finally {
            if (previo.negocio === undefined) delete process.env.WHATSAPP_NEGOCIO_ID;
            else process.env.WHATSAPP_NEGOCIO_ID = previo.negocio;
            if (previo.numero === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
            else process.env.WHATSAPP_PHONE_NUMBER_ID = previo.numero;
        }
    });

    test('responder dos veces no rompe nada', async () => {
        const c = await nuevaConversacion({ idNegocio: negocioA });
        const uno = { idUsuario: usuarioA, params: { id: c.id_conversacion }, body: { texto: 'una' } };
        await llamar(Bandeja.responder, uno);
        const r = await llamar(Bandeja.responder, { ...uno, body: { texto: 'dos' } });

        expect(r.cuerpo.success).toBe(true);
        const salientes = await consulta(
            `SELECT 1 FROM intelligence.mensaje
              WHERE id_conversacion = :id AND direccion = 'saliente';`,
            { id: c.id_conversacion }
        );
        expect(salientes.length).toBe(2);
    });
});

afterAll(async () => {
    await sequelize.close();
});
