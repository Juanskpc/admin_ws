/**
 * Esquema de emisión (FE-2, R1.1/R1.2 de `docs/plan-fe-restaurante.md`).
 *
 * Requiere la migración:  npm run migrate:facturacion-emision
 *
 * Correr con:  npx jest __tests__/facturacion/esquema_emision.test.js --forceExit
 *
 * Lo que se comprueba no es que las tablas existan, sino las dos promesas que están en la base y
 * no en el código: **una venta se factura una sola vez** y **un documento aceptado no se toca**.
 * Crea su propio negocio de usar y tirar y lo borra al terminar; no depende de tiempos.
 */
'use strict';
require('dotenv').config();

const db = require('../../app_core/models/conection');

const sequelize = db.sequelize;

let idNegocio;
let idDocumento;

const insertar = (origenId, referencia) =>
    sequelize.query(
        `INSERT INTO facturacion.fe_documento
             (id_negocio, tipo, ambiente, origen_vertical, origen_tipo, origen_id,
              codigo_referencia, emisor, adquiriente)
         VALUES (:idNegocio, 'FV', 'PRUEBAS', 'RESTAURANTE', 'PEDIDO', :origenId,
                 :referencia, '{}', '{}')
         RETURNING id_documento;`,
        { replacements: { idNegocio, origenId, referencia }, type: sequelize.QueryTypes.SELECT }
    );

const actualizar = (campos, valores) =>
    sequelize.query(`UPDATE facturacion.fe_documento SET ${campos} WHERE id_documento = :idDocumento;`, {
        replacements: { idDocumento, ...valores },
    });

beforeAll(async () => {
    const filas = await sequelize.query(
        `INSERT INTO general.gener_negocio (nombre, estado)
         VALUES ('TEST FE-2 (borrar)', 'A')
         RETURNING id_negocio;`,
        { type: sequelize.QueryTypes.INSERT }
    );
    idNegocio = filas[0][0].id_negocio;
});

afterAll(async () => {
    if (idNegocio) {
        // El trigger protege los aceptados: la única puerta es este ajuste, y solo dentro de una
        // transacción. `fe_documento` no cae por CASCADE a propósito (D18).
        await sequelize.transaction(async (t) => {
            await sequelize.query(`SET LOCAL facturacion.permitir_borrado_pruebas = 'on';`, { transaction: t });
            for (const tabla of ['fe_intento', 'fe_documento_linea']) {
                await sequelize.query(`DELETE FROM facturacion.${tabla} WHERE id_negocio = :idNegocio;`, {
                    replacements: { idNegocio },
                    transaction: t,
                });
            }
            await sequelize.query(
                `DELETE FROM facturacion.fe_documento_archivo a USING facturacion.fe_documento d
                  WHERE d.id_documento = a.id_documento AND d.id_negocio = :idNegocio;`,
                { replacements: { idNegocio }, transaction: t }
            );
            await sequelize.query(`DELETE FROM facturacion.fe_documento WHERE id_negocio = :idNegocio;`, {
                replacements: { idNegocio },
                transaction: t,
            });
            await sequelize.query(`DELETE FROM general.gener_negocio_fiscal WHERE id_negocio = :idNegocio;`, {
                replacements: { idNegocio },
                transaction: t,
            });
            await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :idNegocio;`, {
                replacements: { idNegocio },
                transaction: t,
            });
        });
    }
    await sequelize.close();
});

describe('una venta se factura una sola vez', () => {
    test('el primer documento de un pedido entra, en cola', async () => {
        const filas = await insertar('1001', `TEST-FE2-${idNegocio}-1001`);
        idDocumento = filas[0].id_documento;
        expect(idDocumento).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('un segundo documento del mismo pedido choca con uq_fedoc_origen', async () => {
        await expect(insertar('1001', `TEST-FE2-${idNegocio}-1001-bis`)).rejects.toThrow(/uq_fedoc_origen/);
    });

    test('la misma referencia para otro pedido choca con uq_fedoc_referencia', async () => {
        await expect(insertar('1002', `TEST-FE2-${idNegocio}-1001`)).rejects.toThrow(/uq_fedoc_referencia/);
    });
});

describe('un documento aceptado no se toca', () => {
    test('mientras no esté aceptado se puede corregir', async () => {
        await actualizar(`total = 46000, estado = 'ACEPTADO', numero = 'SETP1', cufe = 'abc'`);
    });

    test('ya aceptado, cambiarle el total falla', async () => {
        await expect(actualizar('total = 1')).rejects.toThrow(/FE_DOCUMENTO_INMUTABLE/);
    });

    test('ni el estado, ni el comprador', async () => {
        await expect(actualizar(`estado = 'ANULADO'`)).rejects.toThrow(/FE_DOCUMENTO_INMUTABLE/);
        await expect(actualizar(`adquiriente = '{"nombres":"otro"}'`)).rejects.toThrow(/FE_DOCUMENTO_INMUTABLE/);
    });

    test('lo que no es fiscal sí se puede mover', async () => {
        await actualizar(`proximo_intento_en = now(), avisos = '[{"codigo":"RUT01"}]'`);
    });

    test('no se puede borrar…', async () => {
        await expect(
            sequelize.query(`DELETE FROM facturacion.fe_documento WHERE id_documento = :idDocumento;`, {
                replacements: { idDocumento },
            })
        ).rejects.toThrow(/FE_DOCUMENTO_INMUTABLE/);
    });

    test('…salvo con la puerta de pruebas, que solo vive dentro de su transacción', async () => {
        await sequelize.transaction(async (t) => {
            await sequelize.query(`SET LOCAL facturacion.permitir_borrado_pruebas = 'on';`, { transaction: t });
            await sequelize.query(`DELETE FROM facturacion.fe_documento WHERE id_documento = :idDocumento;`, {
                replacements: { idDocumento },
                transaction: t,
            });
        });
        const quedan = await sequelize.query(
            `SELECT count(*)::int AS n FROM facturacion.fe_documento WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
        );
        expect(quedan[0].n).toBe(0);
    });
});

describe('un solo rango en uso por negocio y tipo', () => {
    const rango = (idRango, enUso) =>
        sequelize.query(
            `INSERT INTO facturacion.fe_resolucion (id_negocio, id_rango_proveedor, tipo_documento, en_uso)
             VALUES (:idNegocio, :idRango, 'FV', :enUso);`,
            { replacements: { idNegocio, idRango, enUso } }
        );

    afterAll(() =>
        sequelize.query(`DELETE FROM facturacion.fe_resolucion WHERE id_negocio = :idNegocio;`, {
            replacements: { idNegocio },
        })
    );

    test('dos rangos de factura no pueden estar en uso a la vez', async () => {
        await rango(1, true);
        await rango(2, false);
        await expect(rango(3, true)).rejects.toThrow(/uq_feres_en_uso/);
    });
});
