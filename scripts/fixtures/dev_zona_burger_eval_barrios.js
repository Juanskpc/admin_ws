/**
 * Carga en el restaurante de EVALUACIÓN el catálogo de barrios de Pasto (555 lugares), con precio
 * por comuna —Comuna N = $4.000 + N×500; corregimientos, $12.000—, para la suite
 * `barrios_restaurante` (2026-10-16). Con --quitar lo deja como estaba (rango, sin barrios).
 *
 *   DB_PORT=5432 node scripts/fixtures/dev_zona_burger_eval_barrios.js [--quitar]
 *   FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js barrios_restaurante --negocio <id>
 *
 * Primero `node scripts/fixtures/dev_zona_burger_eval.js` (crea el negocio). Solo datos públicos:
 * el catálogo de la ciudad, sin clientes. ⚠️ Solo contra la base LOCAL: aborta con otro puerto u
 * otro host.
 */
'use strict';
require('dotenv').config();

if (process.env.DB_PORT !== '5432' || !['localhost', '127.0.0.1'].includes(process.env.DB_HOST)) {
    console.error('Solo contra la base LOCAL (DB_HOST=localhost, DB_PORT=5432).');
    process.exit(1);
}
const Models = require('../../app_core/models/conection');
const pasto = require('../../migrations/data/barrios_pasto.json');

const q = (sql, replacements = {}, transaction) => Models.sequelize.query(sql, { replacements, transaction });

(async () => {
    const [[n]] = await q(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'ZONA BURGER (EVALUACIÓN)'`);
    if (!n) throw new Error('Falta el negocio: node scripts/fixtures/dev_zona_burger_eval.js');
    const id = n.id_negocio;
    await Models.sequelize.transaction(async (t) => {
        await q(`DELETE FROM restaurante.rest_barrio_domicilio WHERE id_negocio = :id`, { id }, t);
        await q(`DELETE FROM restaurante.rest_zona_domicilio WHERE id_negocio = :id`, { id }, t);
        if (process.argv.includes('--quitar')) {
            await q(`UPDATE general.gener_negocio SET permite_pago_domicilio = false WHERE id_negocio = :id`, { id }, t);
            return;
        }
        let orden = 0;
        for (const z of pasto.zonas) {
            const comuna = /^Comuna (\d+)$/.exec(z.nombre);
            const [[zona]] = await q(
                `INSERT INTO restaurante.rest_zona_domicilio (id_negocio, tipo, nombre, valor, orden)
                 VALUES (:id, :tipo, :nombre, :valor, :orden) RETURNING id_zona_domicilio`,
                { id, tipo: z.tipo, nombre: z.nombre, valor: comuna ? 4000 + Number(comuna[1]) * 500 : 12000, orden: orden++ },
                t
            );
            for (const l of z.lugares) {
                await q(
                    `INSERT INTO restaurante.rest_barrio_domicilio (id_negocio, nombre, valor, id_zona_domicilio)
                     VALUES (:id, :nombre, NULL, :zona) ON CONFLICT DO NOTHING`,
                    { id, nombre: l.nombre, zona: zona.id_zona_domicilio },
                    t
                );
            }
        }
        await q(`UPDATE general.gener_negocio SET permite_pago_domicilio = true WHERE id_negocio = :id`, { id }, t);
    });
    const [[c]] = await q(`SELECT count(*)::int AS n FROM restaurante.rest_barrio_domicilio WHERE id_negocio = :id`, { id });
    console.log(`✓ negocio ${id}: ${c.n} barrios`);
    await Models.sequelize.close();
})().catch((e) => {
    console.error('ERROR', e.message);
    process.exit(1);
});
