/**
 * Migración: cómo se paga, dicho por el negocio, según el tipo de pedido.
 *
 *  - general.gener_negocio.pago_texto_domicilio   varchar(500) NULL
 *  - general.gener_negocio.pago_texto_local       varchar(500) NULL   (para llevar y en mesa)
 *
 * Zona Burger (2026-10-03): el cliente pregunta «¿me das el Nequi?», «¿cómo pago?» o dice
 * «cancelo» (en Colombia, pagar) y la respuesta correcta depende del pedido: a domicilio se paga
 * al domiciliario (transferencia o efectivo, al llegar); para llevar o en mesa, se transfiere a la
 * llave BreB / al Nequi del local. Son dos frases que decide el negocio, así que van en su ficha y
 * no en el código. NULL = el negocio no dijo nada y el asistente sigue como antes.
 *
 * Carga además el texto de Zona Burger (negocio 6) si todavía no lo tiene. Idempotente. Registrada
 * como `npm run migrate:negocio-texto-pago`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const ZONA_BURGER = {
    id: 6,
    domicilio:
        'En los domicilios el pago es por transferencia o en efectivo, y lo haces cuando el ' +
        'domiciliario llegue con tu pedido 🛵',
    local:
        'Puedes pagar por transferencia a la llave BreB o al Nequi 3236388196. En los dos te ' +
        'aparece como «Bra*** Mej**»: confírmalo antes de enviar 🙌 Cuando pagues, mándanos el ' +
        'comprobante por aquí.',
};

async function agregar(t, columna) {
    const [existe] = await Models.sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = 'general' AND table_name = 'gener_negocio' AND column_name = :columna;`,
        { replacements: { columna }, type: Models.sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (existe) return console.log(`   ${columna}: ya existía.`);
    await Models.sequelize.query(`ALTER TABLE general.gener_negocio ADD COLUMN ${columna} varchar(500);`, {
        transaction: t,
    });
    console.log(`   ${columna}: añadida (NULL = sin texto).`);
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. Columnas de texto de pago ...');
        await agregar(t, 'pago_texto_domicilio');
        await agregar(t, 'pago_texto_local');

        console.log('2. Texto de Zona Burger (solo si está vacío) ...');
        const [, meta] = await Models.sequelize.query(
            `UPDATE general.gener_negocio
                SET pago_texto_domicilio = COALESCE(pago_texto_domicilio, :domicilio),
                    pago_texto_local = COALESCE(pago_texto_local, :local)
              WHERE id_negocio = :id
                AND (pago_texto_domicilio IS NULL OR pago_texto_local IS NULL);`,
            { replacements: ZONA_BURGER, transaction: t }
        );
        console.log(`   ${meta?.rowCount ?? 0} negocio(s) actualizado(s).`);

        await t.commit();
        console.log('✓ Migración texto de pago completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
