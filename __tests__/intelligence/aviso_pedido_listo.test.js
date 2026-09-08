/**
 * «Tu pedido ya está listo» — el aviso que dispara una persona desde el despacho.
 *
 * ## Lo que esta suite tiene que dejar clavado
 *
 * Solo hay una promesa que de verdad importa, y no es «se manda el mensaje»: **el botón no puede
 * cobrarse dos veces**. Cada envío de plantilla se le factura al negocio, así que un doble clic
 * son dos cobros y dos mensajes al cliente, y en una pantalla que se mira con la cocina llena el
 * doble clic no es una posibilidad teórica.
 *
 * Lo demás son negativas, y también se prueban una a una, porque un aviso que se manda cuando no
 * debía es más caro que uno que no se manda: escribirle a quien pidió la baja, o estrenar un hilo
 * con alguien que nunca escribió, no son errores de programa sino de política.
 *
 * Corre contra la base de verdad. Todo lo que importa aquí —el `FOR UPDATE`, que la marca y el
 * mensaje vivan en la misma transacción— **es** la base: con dobles se probaría la maqueta.
 *
 * Correr con:  npx jest __tests__/intelligence/aviso_pedido_listo.test.js
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const avisoPedido = require('../../intelligence/adapters/restaurante/avisoPedido');
const plantillas = require('../../intelligence/core/plantillas');
const repositorio = require('../../intelligence/engine/repositorio');
const features = require('../../intelligence/core/features');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

/**
 * Un celular colombiano de verdad por caso, y cada test el suyo.
 *
 * Tienen que ser **diez dígitos empezando por 3** o `normalizarE164Colombia` los descarta, que es
 * justo lo que hizo la primera versión de esta suite: pegarle un sufijo a un número ya completo
 * daba once dígitos, y todos los casos fallaban por «sin teléfono» en vez de por lo que probaban.
 */
const tel = (n) => `31500000${String(n).padStart(2, '0')}`;
/** Como lo escribe el canal: sin el `+`. Es la clave con la que se busca la conversación. */
const idExternoDe = (n) => `57${tel(n)}`;

let idNegocio;
let idUsuario;
let contador = 0;

const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

/** Los salientes de una conversación, que es lo que se cuenta para saber si se mandó de más. */
const salientesDe = (idConversacion) =>
    consulta(
        `SELECT id_mensaje, contenido, plantilla, estado_entrega
           FROM intelligence.mensaje
          WHERE id_conversacion = :id AND direccion = 'saliente'
          ORDER BY creado_en;`,
        { id: idConversacion }
    );

/** Una orden de despacho recién nacida, sin avisar. */
async function crearOrden({ tipo = 'LLEVAR', telefono, nombre = 'Ana Ruiz' } = {}) {
    return unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_usuario, numero_orden, tipo_pedido, estado,
             contacto_nombre, contacto_telefono)
         VALUES (:idNegocio, :idUsuario, :numero, :tipo, 'ABIERTA', :nombre, :telefono)
         RETURNING id_orden, numero_orden;`,
        {
            idNegocio,
            idUsuario,
            numero: `QA-${Date.now()}-${contador++}`,
            tipo,
            nombre,
            telefono,
        }
    );
}

/** La conversación de WhatsApp de esa persona con este negocio. */
async function crearConversacion({ idExterno, estado = 'activa' } = {}) {
    const t = await sequelize.transaction();
    const conv = await repositorio.asegurarConversacion(
        { idNegocio, canal: 'whatsapp', idExterno },
        { transaction: t }
    );
    await t.commit();
    if (estado !== 'activa') {
        await repositorio.cambiarEstadoConversacion(conv.id_conversacion, estado);
    }
    return conv;
}

const avisar = (orden) => avisoPedido.avisarListo({ idNegocio, idOrden: orden.id_orden });

const marcaDe = (orden) =>
    unaFila(`SELECT aviso_listo_en FROM restaurante.pedid_orden WHERE id_orden = :id;`, {
        id: orden.id_orden,
    });

beforeAll(async () => {
    // Negocio propio: la conversación se busca por `(negocio, canal, id_externo)`, y sobre un
    // negocio compartido lo que dejen otras suites convertiría cada aserción en una lotería.
    const negocio = await unaFila(
        `INSERT INTO general.gener_negocio (nombre, estado) VALUES ('QA Aviso Pedido', 'A')
         RETURNING id_negocio;`
    );
    idNegocio = negocio.id_negocio;
    // El aviso es una función de pago: sin «Plan Avanzado» —el único que incluye `asistente_ia`—
    // todos los casos de esta suite se caerían por la puerta comercial antes de llegar a lo que
    // prueban. Se contrata de verdad, no se simula: lo que se quiere ejercitar es `features`.
    await sequelize.query(
        `INSERT INTO general.gener_negocio_plan (id_negocio, id_plan, fecha_inicio, estado)
         SELECT :n, id_plan, CURRENT_DATE, 'A' FROM general.gener_plan
          WHERE nombre = 'Plan Avanzado' AND estado = 'A' LIMIT 1;`,
        { replacements: { n: idNegocio }, logging: false }
    );
    // `pedid_orden.id_usuario` es NOT NULL: una orden siempre la toma alguien.
    idUsuario = (await unaFila(`SELECT id_usuario FROM general.gener_usuario ORDER BY id_usuario LIMIT 1;`))
        .id_usuario;
});

afterAll(async () => {
    const ids = (
        await consulta(`SELECT id_conversacion FROM intelligence.conversacion WHERE id_negocio = :n;`, {
            n: idNegocio,
        })
    ).map((f) => f.id_conversacion);

    if (ids.length > 0) {
        await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
    }
    await sequelize.query(`DELETE FROM restaurante.pedid_orden WHERE id_negocio = :n;`, {
        replacements: { n: idNegocio },
        logging: false,
    });
    await sequelize.query(`DELETE FROM general.gener_negocio_plan WHERE id_negocio = :n;`, {
        replacements: { n: idNegocio },
        logging: false,
    });
    await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :n;`, {
        replacements: { n: idNegocio },
        logging: false,
    });
    await sequelize.close();
});

// ── La plantilla ────────────────────────────────────────────────────────────────────────────

describe('la plantilla pedido_listo', () => {
    test('NO termina en variable — es una regla explícita de Meta', () => {
        // Una plantilla cuyo último carácter es un hueco se rechaza en la revisión. Es la clase
        // de detalle que se descubre una semana después, cuando ya no se sabe por qué fue.
        expect(plantillas.obtener('pedido_listo').texto.trim()).not.toMatch(/\{\{\d+\}\}$/);
    });

    test('es UTILITY, no MARKETING', () => {
        // La categoría decide el precio y también si Meta la aprueba: el mismo texto presentado
        // como marketing cuesta más y se rechaza más.
        expect(plantillas.obtener('pedido_listo').categoria).toBe('UTILITY');
    });

    test('un hueco sin valor no escribe «undefined»', () => {
        const texto = plantillas.renderizarTexto('pedido_listo', { cliente: 'Ana' });
        expect(texto).not.toMatch(/undefined/);
        expect(texto).toContain('Ana');
    });
});

// ── El aviso ────────────────────────────────────────────────────────────────────────────────

describe('avisarListo', () => {
    test('deja un saliente pendiente CON plantilla, y marca la orden', async () => {
        const conv = await crearConversacion({ idExterno: idExternoDe(1) });
        const orden = await crearOrden({ telefono: tel(1) });

        const r = await avisar(orden);

        expect(r.id_mensaje).toBeTruthy();
        const salientes = await salientesDe(conv.id_conversacion);
        expect(salientes).toHaveLength(1);
        // `pendiente` a propósito: quien entrega es el Channel Gateway, con sus reintentos.
        expect(salientes[0].estado_entrega).toBe('pendiente');
        // La plantilla es lo que le permite salir con la ventana de 24 h cerrada, que es
        // exactamente lo que pasa cuando el pedido tarda dos horas.
        expect(salientes[0].plantilla.nombre).toBe('pedido_listo');
        // Y el contenido va compuesto: es lo que un humano lee en la Consola para saber qué
        // recibió el cliente, y lo que entregaría un canal sin plantillas.
        expect(salientes[0].contenido).toContain(orden.numero_orden);
        expect(salientes[0].contenido).toContain('Ana');

        expect((await marcaDe(orden)).aviso_listo_en).toBeTruthy();
    });

    test('EL CANDADO: dos veces seguidas mandan UN mensaje, no dos', async () => {
        // Es la promesa que justifica toda la columna. Cada plantilla se le cobra al negocio.
        const conv = await crearConversacion({ idExterno: idExternoDe(2) });
        const orden = await crearOrden({ telefono: tel(2) });

        await avisar(orden);
        await expect(avisar(orden)).rejects.toMatchObject({ code: 'PEDIDO_YA_AVISADO' });

        expect(await salientesDe(conv.id_conversacion)).toHaveLength(1);
    });

    test('a la vez, tampoco: el FOR UPDATE los pone en fila', async () => {
        // El doble clic real no son dos peticiones ordenadas, son dos simultáneas. Sin el
        // `FOR UPDATE` en la primera lectura las dos verían `aviso_listo_en` nulo y las dos
        // mandarían: el hueco cabe entero entre un SELECT normal y su UPDATE.
        const conv = await crearConversacion({ idExterno: idExternoDe(3) });
        const orden = await crearOrden({ telefono: tel(3) });

        const resultados = await Promise.allSettled([avisar(orden), avisar(orden)]);

        expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await salientesDe(conv.id_conversacion)).toHaveLength(1);
    });

    test('sin conversación no se escribe: no se estrena un hilo desde un botón', async () => {
        // Escribirle a un número que apareció en una casilla no es lo mismo que contestarle a
        // alguien que nos escribió, y la diferencia no es técnica.
        const orden = await crearOrden({ telefono: tel(9) });

        await expect(avisar(orden)).rejects.toMatchObject({ code: 'SIN_CONVERSACION' });
        // Y no queda marcada: tiene que poder reintentarse si la conversación aparece.
        expect((await marcaDe(orden)).aviso_listo_en).toBeNull();
    });

    test('a quien pidió la baja no se le escribe, ni siquiera algo que le interesa', async () => {
        const conv = await crearConversacion({ idExterno: idExternoDe(4), estado: 'bloqueada' });
        const orden = await crearOrden({ telefono: tel(4) });

        await expect(avisar(orden)).rejects.toMatchObject({ code: 'CONVERSACION_BLOQUEADA' });
        // Ni siquiera se crea el mensaje: si se creara, se quedaría pendiente hasta caducar,
        // ensuciando la cola con algo que el entregador nunca va a dejar salir.
        expect(await salientesDe(conv.id_conversacion)).toHaveLength(0);
    });

    test('un domicilio no lleva este aviso', async () => {
        // Lo que le llega a un domicilio es el domiciliario. El «va en camino» será otra
        // plantilla el día que alguien la pida, no ésta con otro texto.
        await crearConversacion({ idExterno: idExternoDe(5) });
        const orden = await crearOrden({ tipo: 'DOMICILIO', telefono: tel(5) });

        await expect(avisar(orden)).rejects.toMatchObject({ code: 'PEDIDO_NO_ES_PARA_RECOGER' });
    });

    test('un pedido sin teléfono lo dice, en vez de fallar más abajo', async () => {
        const orden = await crearOrden({ telefono: null });
        await expect(avisar(orden)).rejects.toMatchObject({ code: 'PEDIDO_SIN_TELEFONO' });
    });

    test('EL PLAN: sin el asistente contratado no se manda nada', async () => {
        // El aviso es una función de pago. Que la pantalla esconda el botón no basta: quien
        // llega por `curl`, con una pestaña vieja abierta o después de una baja de plan, llega
        // hasta aquí — y aquí es donde se le dice que no.
        const otro = await unaFila(
            `INSERT INTO general.gener_negocio (nombre, estado) VALUES ('QA Plan Básico', 'A')
             RETURNING id_negocio;`
        );
        try {
            await expect(
                avisoPedido.avisarListo({ idNegocio: otro.id_negocio, idOrden: 1 })
            ).rejects.toMatchObject({ code: 'FEATURE_NO_HABILITADA', statusCode: 403 });

            // Y se comprueba lo que de verdad importa del mapeo: hoy `asistente_ia` NO está en
            // Básico. Si alguien la mueve ahí, este test lo dice antes que la factura.
            expect(features.FEATURES_POR_PLAN['Plan Básico']).not.toContain(
                features.FEATURE.ASISTENTE_IA
            );
            expect(features.FEATURES_POR_PLAN['Plan Avanzado']).toContain(
                features.FEATURE.ASISTENTE_IA
            );
        } finally {
            await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :n;`, {
                replacements: { n: otro.id_negocio },
                logging: false,
            });
        }
    });

    test('un pedido de otro negocio no existe para éste', async () => {
        // Misma frontera que en todo lo demás: el aislamiento entre inquilinos no es un filtro
        // de la pantalla, es una condición de la consulta.
        //
        // El vecino tiene que estar **también en Plan Avanzado**, o el rechazo vendría de la
        // puerta comercial —que se mira antes— y este test estaría probando la otra cosa. Es lo
        // que pasó al escribirlo: el aislamiento se probaba solo porque el vecino no pagaba.
        const vecino = await unaFila(
            `INSERT INTO general.gener_negocio (nombre, estado) VALUES ('QA Vecino Avanzado', 'A')
             RETURNING id_negocio;`
        );
        await sequelize.query(
            `INSERT INTO general.gener_negocio_plan (id_negocio, id_plan, fecha_inicio, estado)
             SELECT :n, id_plan, CURRENT_DATE, 'A' FROM general.gener_plan
              WHERE nombre = 'Plan Avanzado' AND estado = 'A' LIMIT 1;`,
            { replacements: { n: vecino.id_negocio }, logging: false }
        );
        const mia = await crearOrden({ telefono: tel(8) });

        try {
            await expect(
                avisoPedido.avisarListo({ idNegocio: vecino.id_negocio, idOrden: mia.id_orden })
            ).rejects.toMatchObject({ code: 'PEDIDO_NO_ENCONTRADO' });
        } finally {
            await sequelize.query(`DELETE FROM general.gener_negocio_plan WHERE id_negocio = :n;`, {
                replacements: { n: vecino.id_negocio },
                logging: false,
            });
            await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :n;`, {
                replacements: { n: vecino.id_negocio },
                logging: false,
            });
        }
    });
});
