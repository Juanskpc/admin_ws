/**
 * Paquetes de mensajes del asistente (2026-10-10).
 *
 *   node scripts/migrar.js cobranza-paquetes-mensajes
 *
 * ## Qué es esto
 *
 * El plan con asistente se vendía **sin techo**: el inquilino pagaba $59.999 y el asistente
 * contestaba lo que hiciera falta. Con el modelo caro eso se comía el 82 % del plan y nadie lo
 * sabía (ver `docs/asistente-economia.md`). Con el modelo barato se come el 8,5 %, así que el
 * problema dejó de ser el cliente medio y pasó a ser **la cola larga**: a 30.000 mensajes al mes
 * la IA se lleva el 47 % del plan, y a 60.000 el 93 %.
 *
 * Esto pone el techo y la forma de ampliarlo.
 *
 * ## Las dos cifras que NO son la misma, y es el error fácil
 *
 *   · **Los 1.000 de Meta.** Mensajes de servicio gratis por número y por mes. Es de Meta, le
 *     llega al cliente en SU tarjeta (somos Tech Provider: `docs/embedded-signup.md` §9.1) y
 *     existe tengamos nosotros techo o no.
 *   · **Los 6.000 nuestros.** Lo que el plan incluye de ASISTENTE. Mide nuestro costo de IA, no
 *     el de Meta.
 *
 * La primera versión de la propuesta las confundía: incluía 1.000 «porque coincide con Meta y
 * así el cliente no paga nada a nadie». Suena limpio y es una trampa — 1.000 son la quinta parte
 * de lo que consume el único cliente real (5.430/mes medidos), así que todo negocio activo
 * necesitaría paquete desde el primer mes y el «incluye 1.000» sería letra pequeña. El techo
 * nuestro lo pone NUESTRO costo, y a 6.000 mensajes son $5.640 COP: el 9 % del plan.
 *
 * ## Por qué un paquete repetible y no tres tamaños
 *
 * `cob_suscripcion_complemento` ya suma `cantidad` por complemento, y de ahí salen el prorrateo,
 * la renovación y el cambio de plan. Un paquete de 6.000 que se contrata 1..5 veces usa esa
 * maquinaria tal cual. Tres complementos S/M/L habrían necesitado saber cuántos mensajes trae
 * cada uno — que es justo lo que resuelve `amplia_cantidad`, pero multiplicado por tres filas y
 * tres precios que mantener.
 *
 * El descuento por volumen se descartó a propósito: con **un** cliente midiendo, una curva de
 * precios es una invención. Precio plano, y se revisa con datos.
 *
 * ## Qué hace
 *
 *   1. `cob_complemento.amplia_cantidad` — cuántas unidades de `amplia` trae CADA unidad del
 *      complemento. 1 para usuarios y cajas (un complemento = un usuario), 6.000 para el paquete
 *      de mensajes. Sin esto, `limitesNegocio` tendría que llevar la cifra en una constante y
 *      desincronizarse de la base el día que alguien cambie el tamaño del paquete.
 *   2. `gener_plan.mensajes_incluidos` — el techo del plan.
 *   3. El CHECK de `amplia` acepta 'mensajes'.
 *   4. El complemento `MENSAJES_ASISTENTE` y sus precios (COP y **CLP**: omitir CLP haría que un
 *      chileno cotizara el precio por defecto, que es el error que se corrigió el 2026-10-08).
 *   5. 6.000 mensajes incluidos en los planes que traen `asistente_ia`; 0 en los que no.
 *
 * Todo por NOMBRE y nunca por id. Idempotente.
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Cuántos mensajes trae cada paquete contratado. */
const MENSAJES_POR_PAQUETE = 6000;

/** Lo que incluye un plan con asistente. Medido: el cliente real gasta 5.430 al mes. */
const MENSAJES_INCLUIDOS = 6000;

const COMPLEMENTO = {
    codigo: 'MENSAJES_ASISTENTE',
    nombre: 'Paquete de mensajes del asistente',
    descripcion:
        '6.000 mensajes más al mes para que el asistente siga atendiendo por WhatsApp '
        + '(unos 700 pedidos). Se puede contratar varias veces.',
    amplia: 'mensajes',
    amplia_cantidad: MENSAJES_POR_PAQUETE,
    // Cinco paquetes son 36.000 mensajes al mes sobre los 6.000 incluidos: cuatro veces lo que
    // gasta hoy el negocio que más lo usa. Pasado eso la conversación es comercial, no un
    // formulario.
    cantidad_maxima: 5,
    orden: 30,
    precios: [
        { moneda: 'COP', precio: 19999 },
        // Misma proporción que guardan los planes entre las dos monedas (8.900 / 27.999).
        { moneda: 'CLP', precio: 5900 },
    ],
};

async function existeColumna(tabla, esquema, columna, t) {
    const [[fila]] = await sequelize.query(
        `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna
         ) AS existe;`,
        { replacements: { esquema, tabla, columna }, transaction: t },
    );
    return fila.existe;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('-> Migracion: paquetes de mensajes del asistente\n');

        // -- 1. amplia_cantidad -----------------------------------------------
        if (!(await existeColumna('cob_complemento', 'cobranza', 'amplia_cantidad', t))) {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_complemento
                   ADD COLUMN amplia_cantidad integer NOT NULL DEFAULT 1;
                 COMMENT ON COLUMN cobranza.cob_complemento.amplia_cantidad IS
                   'Cuantas unidades de amplia trae CADA unidad del complemento. 1 para usuarios y cajas; 6000 para el paquete de mensajes.';`,
                { transaction: t },
            );
            console.log('1. cob_complemento.amplia_cantidad: creada (por defecto 1).');
        } else {
            console.log('1. cob_complemento.amplia_cantidad: ya existe.');
        }

        // -- 2. mensajes_incluidos --------------------------------------------
        if (!(await existeColumna('gener_plan', 'general', 'mensajes_incluidos', t))) {
            await sequelize.query(
                `ALTER TABLE general.gener_plan
                   ADD COLUMN mensajes_incluidos integer NULL;
                 COMMENT ON COLUMN general.gener_plan.mensajes_incluidos IS
                   'Mensajes del asistente que incluye el plan al mes. NULL = el plan no trae asistente.';`,
                { transaction: t },
            );
            console.log('2. gener_plan.mensajes_incluidos: creada.');
        } else {
            console.log('2. gener_plan.mensajes_incluidos: ya existe.');
        }

        // -- 3. El CHECK de amplia acepta 'mensajes' --------------------------
        const [[chk]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'cobranza.cob_complemento'::regclass
                    AND conname = 'chk_cob_complemento_amplia'
                    AND pg_get_constraintdef(oid) LIKE '%mensajes%'
             ) AS listo;`,
            { transaction: t },
        );
        if (!chk.listo) {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_complemento
                   DROP CONSTRAINT IF EXISTS chk_cob_complemento_amplia;
                 ALTER TABLE cobranza.cob_complemento
                   ADD CONSTRAINT chk_cob_complemento_amplia
                   CHECK (amplia IS NULL OR amplia IN ('usuarios','cajas','mensajes'));`,
                { transaction: t },
            );
            console.log("3. CHECK de amplia: acepta 'mensajes'.");
        } else {
            console.log("3. CHECK de amplia: ya aceptaba 'mensajes'.");
        }

        // -- 4. El complemento y sus precios ----------------------------------
        await sequelize.query(
            `INSERT INTO cobranza.cob_complemento
                 (codigo, nombre, descripcion, amplia, amplia_cantidad, cantidad_maxima, orden)
             VALUES (:codigo, :nombre, :descripcion, :amplia, :amplia_cantidad, :cantidad_maxima, :orden)
             ON CONFLICT (codigo) DO UPDATE
                SET nombre          = EXCLUDED.nombre,
                    descripcion     = EXCLUDED.descripcion,
                    amplia          = EXCLUDED.amplia,
                    amplia_cantidad = EXCLUDED.amplia_cantidad,
                    cantidad_maxima = EXCLUDED.cantidad_maxima,
                    orden           = EXCLUDED.orden;`,
            { replacements: COMPLEMENTO, transaction: t },
        );
        console.log(`4. Complemento ${COMPLEMENTO.codigo}: listo.`);

        for (const p of COMPLEMENTO.precios) {
            await sequelize.query(
                `INSERT INTO cobranza.cob_precio_complemento (id_complemento, moneda, ciclo, precio, estado)
                 SELECT c.id_complemento, :moneda, 'mensual', :precio, 'A'
                   FROM cobranza.cob_complemento c
                  WHERE c.codigo = :codigo
                 ON CONFLICT (id_complemento, moneda, ciclo) DO UPDATE
                    SET precio = EXCLUDED.precio, estado = 'A';`,
                { replacements: { ...p, codigo: COMPLEMENTO.codigo }, transaction: t },
            );
            console.log(`   precio ${p.moneda} ${p.precio}: listo.`);
        }

        // -- 5. Cuantos mensajes incluye cada plan ----------------------------
        //
        // Se decide por la FEATURE y no por el nombre del plan (ADR-021): el dia que el asistente
        // cambie de plan o se renombre uno, esto sigue siendo cierto sin tocar nada.
        const [conAsistente] = await sequelize.query(
            `UPDATE general.gener_plan p
                SET mensajes_incluidos = :incluidos
              WHERE p.estado = 'A'
                AND EXISTS (
                    SELECT 1 FROM general.gener_plan_caracteristica c
                     WHERE c.id_plan = p.id_plan AND c.codigo = 'asistente_ia'
                )
                AND COALESCE(p.mensajes_incluidos, -1) <> :incluidos
             RETURNING p.nombre;`,
            { replacements: { incluidos: MENSAJES_INCLUIDOS }, transaction: t },
        );
        console.log(`5. ${conAsistente.length} plan(es) con asistente -> ${MENSAJES_INCLUIDOS} mensajes.`);
        for (const p of conAsistente) console.log(`   · ${p.nombre}`);

        // Un plan sin asistente no incluye mensajes. 0 y no NULL: NULL es «no se sabe», y aqui
        // se sabe — no tiene asistente, no tiene mensajes.
        await sequelize.query(
            `UPDATE general.gener_plan p
                SET mensajes_incluidos = 0
              WHERE p.estado = 'A'
                AND p.mensajes_incluidos IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM general.gener_plan_caracteristica c
                     WHERE c.id_plan = p.id_plan AND c.codigo = 'asistente_ia'
                );`,
            { transaction: t },
        );

        // -- 6. Lo que queda --------------------------------------------------
        const [resumen] = await sequelize.query(
            `SELECT p.nombre, p.mensajes_incluidos
               FROM general.gener_plan p
              WHERE p.estado = 'A' AND COALESCE(p.mensajes_incluidos, 0) > 0
              ORDER BY p.nombre;`,
            { transaction: t },
        );
        console.log('\n   Planes con mensajes incluidos:');
        for (const f of resumen) {
            console.log(`     ${String(f.nombre).padEnd(30)} ${f.mensajes_incluidos}`);
        }

        await t.commit();
        console.log('\nMigracion completada.');
    } catch (err) {
        await t.rollback();
        console.error('Migracion fallida (se revirtio todo):', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
