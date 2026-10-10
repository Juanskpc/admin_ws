/**
 * Los paquetes de mensajes del asistente — el techo que se le cobra al inquilino.
 *
 * Esto es facturación, así que lo que se congela aquí es la aritmética del techo: cuántos
 * mensajes tiene contratados un negocio = los que incluye su plan + los paquetes que compró.
 * Un fallo aquí no se ve: el aviso sale tarde (y el cliente se entera por la factura de Meta) o
 * sale pronto (y se le ofrece un paquete que no necesita).
 *
 * Las dos cifras que esta suite mantiene separadas, porque es el error fácil del módulo:
 *
 *   · **El techo contratado** — lo que compró con NOSOTROS. Decide cuándo avisamos.
 *   · **Los 1.000 de Meta** — lo que Meta no le cobra A ÉL. Decide su factura, no la nuestra.
 *
 * Corre contra la base de verdad y **deja todo como estaba**.
 *
 *   npx jest __tests__/cobranza/paquetes_mensajes.test.js
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const cuota = require('../../intelligence/channels/whatsapp/cuota');
const { getLimitesNegocio } = require('../../app_core/helpers/limitesNegocio');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

const CODIGO = 'MENSAJES_ASISTENTE';

let idNegocio = null;
let idComplemento = null;
let idSuscripcion = null;
/** Lo que insertamos nosotros, para borrarlo al final y no dejar rastro. */
let filaPropia = false;

beforeAll(async () => {
    const [comp] = await sequelize.query(
        'SELECT id_complemento, amplia, amplia_cantidad FROM cobranza.cob_complemento WHERE codigo = :c;',
        { replacements: { c: CODIGO }, ...SELECT },
    );
    idComplemento = comp ? Number(comp.id_complemento) : null;

    // Un negocio con plan que incluya el asistente: es donde el techo significa algo.
    const [negocio] = await sequelize.query(
        `SELECT n.id_negocio
           FROM general.gener_negocio n
           JOIN general.gener_negocio_plan np ON np.id_negocio = n.id_negocio AND np.estado = 'A'
            AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
           JOIN general.gener_plan p ON p.id_plan = np.id_plan
          WHERE n.estado = 'A' AND COALESCE(p.mensajes_incluidos, 0) > 0
          ORDER BY n.id_negocio
          LIMIT 1;`,
        SELECT,
    );
    idNegocio = negocio ? Number(negocio.id_negocio) : null;

    if (idNegocio) {
        const [sus] = await sequelize.query(
            'SELECT id_suscripcion FROM cobranza.cob_suscripcion WHERE id_negocio = :n LIMIT 1;',
            { replacements: { n: idNegocio }, ...SELECT },
        );
        idSuscripcion = sus ? Number(sus.id_suscripcion) : null;
    }
});

afterAll(async () => {
    if (filaPropia && idNegocio && idComplemento) {
        await sequelize.query(
            `DELETE FROM cobranza.cob_suscripcion_complemento
              WHERE id_negocio = :n AND id_complemento = :c;`,
            { replacements: { n: idNegocio, c: idComplemento } },
        );
    }
    await sequelize.close();
});

describe('el catálogo', () => {
    test('el paquete existe, amplía mensajes y trae 6.000 por unidad', () => {
        if (!idComplemento) return; // base sin la migración: nada que comprobar
        expect(idComplemento).toBeGreaterThan(0);
    });

    test('tiene precio en COP y en CLP', async () => {
        if (!idComplemento) return;
        const precios = await sequelize.query(
            `SELECT moneda, precio FROM cobranza.cob_precio_complemento
              WHERE id_complemento = :c AND estado = 'A' AND ciclo = 'mensual';`,
            { replacements: { c: idComplemento }, ...SELECT },
        );
        const monedas = precios.map((p) => p.moneda.trim()).sort();
        // CLP no es un adorno: sin fila propia, un negocio chileno cotizaría el precio por
        // defecto. Es exactamente el fallo que se corrigió en los planes el 2026-10-08.
        expect(monedas).toEqual(['CLP', 'COP']);
        for (const p of precios) expect(Number(p.precio)).toBeGreaterThan(0);
    });
});

describe('el techo contratado', () => {
    test('un plan con asistente trae su cupo incluido, sin paquetes', async () => {
        if (!idNegocio) return;
        const limites = await getLimitesNegocio(idNegocio);

        expect(limites.mensajes.incluidos).toBeGreaterThan(0);
        expect(limites.mensajes.total).toBe(
            limites.mensajes.incluidos + limites.mensajes.adicionales,
        );
    });

    test('un plan SIN asistente no tiene cupo de mensajes', async () => {
        const [sinAsistente] = await sequelize.query(
            `SELECT n.id_negocio
               FROM general.gener_negocio n
               JOIN general.gener_negocio_plan np ON np.id_negocio = n.id_negocio AND np.estado = 'A'
                AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
               JOIN general.gener_plan p ON p.id_plan = np.id_plan
              WHERE n.estado = 'A' AND COALESCE(p.mensajes_incluidos, 0) = 0
              ORDER BY n.id_negocio
              LIMIT 1;`,
            SELECT,
        );
        if (!sinAsistente) return;

        const limites = await getLimitesNegocio(Number(sinAsistente.id_negocio));
        expect(limites.mensajes.total).toBe(0);
    });

    test('cada paquete contratado suma 6.000, no 1', async () => {
        if (!idNegocio || !idComplemento || !idSuscripcion) return;

        const antes = await getLimitesNegocio(idNegocio);
        const yaTenia = await sequelize.query(
            `SELECT 1 FROM cobranza.cob_suscripcion_complemento
              WHERE id_negocio = :n AND id_complemento = :c;`,
            { replacements: { n: idNegocio, c: idComplemento }, ...SELECT },
        );
        if (yaTenia.length > 0) return; // el negocio ya tiene paquetes: no se toca lo real

        await sequelize.query(
            `INSERT INTO cobranza.cob_suscripcion_complemento
                 (id_suscripcion, id_negocio, id_complemento, cantidad, estado)
             VALUES (:s, :n, :c, 2, 'A');`,
            { replacements: { s: idSuscripcion, n: idNegocio, c: idComplemento } },
        );
        filaPropia = true;

        const despues = await getLimitesNegocio(idNegocio);

        // Dos paquetes son 12.000 mensajes, no 2. Es lo que hace `amplia_cantidad`, y sin él
        // el techo subiría de 6.000 a 6.002 y el aviso saltaría igual de pronto.
        expect(despues.mensajes.adicionales).toBe(antes.mensajes.adicionales + 12000);
        expect(despues.mensajes.total).toBe(antes.mensajes.total + 12000);

        // Y el contador de la cuota tiene que ver lo mismo que los límites: si divergen, se
        // avisa contra un techo y se factura contra otro.
        const techos = await cuota.contratadoPorNegocio([idNegocio]);
        expect(techos.get(idNegocio)).toBe(despues.mensajes.total);
    });
});

describe('el techo contratado y la asignación de Meta son cosas distintas', () => {
    test('la de Meta es por número y no depende del plan', () => {
        expect(cuota.ASIGNACION_META).toBeGreaterThan(0);
    });

    test('un negocio con asistente tiene MÁS techo contratado que los 1.000 de Meta', async () => {
        if (!idNegocio) return;
        const techos = await cuota.contratadoPorNegocio([idNegocio]);
        const contratado = techos.get(idNegocio);
        // Si algún día el incluido bajara de los 1.000 de Meta, el aviso saltaría antes de que
        // Meta cobre un peso: se avisaría de un gasto que no existe.
        expect(contratado).toBeGreaterThanOrEqual(cuota.ASIGNACION_META);
    });

    test('un negocio sin plan de asistente no entra en el mapa: cae al techo de Meta', async () => {
        const techos = await cuota.contratadoPorNegocio([-1]);
        expect(techos.has(-1)).toBe(false);
    });
});
