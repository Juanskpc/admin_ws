/**
 * La lista de una campaña, contra la base de verdad.
 *
 * Existe porque el resto de las pruebas de promociones son puras y ninguna llegaba a la base: la
 * consulta que congela la lista pasaba `:ids::text[]`, Sequelize la expandía como valores sueltos
 * («unnest(unknown) is not unique») y **ninguna promoción se podía preparar**. Se descubrió con la
 * primera en producción, el 2026-10-13.
 *
 * Todo corre dentro de una transacción que se deshace: no deja nada escrito.
 */
'use strict';

require('dotenv').config();
const { sequelize } = require('../../app_core/models/conection');
const campanas = require('../../app_core/promociones/campanas');

/** Para deshacer la transacción a propósito sin confundirlo con un fallo. */
class Deshacer extends Error {}

async function enTransaccionQueSeDeshace(fn) {
    try {
        await sequelize.transaction(async (transaction) => {
            await fn(transaction);
            throw new Deshacer();
        });
    } catch (error) {
        if (!(error instanceof Deshacer)) throw error;
    }
}

afterAll(() => sequelize.close());

describe('congelar la lista de una campaña', () => {
    test('inserta varios destinatarios, con segmento vacío y comillas en el teléfono', async () => {
        await enTransaccionQueSeDeshace(async (transaction) => {
            const [personas] = await sequelize.query(
                `SELECT id_persona_negocio, id_negocio
                   FROM platform.persona_negocio
                  WHERE id_negocio = (SELECT id_negocio FROM platform.persona_negocio
                                       GROUP BY id_negocio ORDER BY count(*) DESC LIMIT 1)
                  LIMIT 3;`,
                { transaction }
            );
            if (personas.length === 0) {
                console.warn('[destinatarios_db] la base no tiene personas: no hay nada que probar');
                return;
            }

            const [[campana]] = await sequelize.query(
                `INSERT INTO platform.campana (id_negocio, vertical, nombre, plantilla)
                 VALUES (:idNegocio, 'restaurante', 'prueba de la lista', 'promocion_texto')
                 RETURNING id_campana;`,
                { replacements: { idNegocio: personas[0].id_negocio }, transaction }
            );

            const destinatarios = personas.map((p, i) => ({
                id_persona_negocio: p.id_persona_negocio,
                telefono: i === 2 ? "+57300'1112233" : `+57300111223${i}`,
                segmento: i === 1 ? null : 'ocasional',
            }));
            await campanas.insertarDestinatarios(campana.id_campana, destinatarios, { transaction });

            const [filas] = await sequelize.query(
                `SELECT id_persona_negocio, telefono_e164, segmento
                   FROM platform.campana_destinatario
                  WHERE id_campana = :idCampana;`,
                { replacements: { idCampana: campana.id_campana }, transaction }
            );
            expect(filas).toHaveLength(personas.length);
            const porPersona = new Map(filas.map((f) => [f.id_persona_negocio, f]));
            for (const d of destinatarios) {
                expect(porPersona.get(d.id_persona_negocio).telefono_e164).toBe(d.telefono);
                expect(porPersona.get(d.id_persona_negocio).segmento).toBe(d.segmento);
            }

            // Repetir no duplica: la lista se congela una vez.
            await campanas.insertarDestinatarios(campana.id_campana, destinatarios, { transaction });
            const [[{ n }]] = await sequelize.query(
                `SELECT count(*)::int AS n FROM platform.campana_destinatario WHERE id_campana = :c;`,
                { replacements: { c: campana.id_campana }, transaction }
            );
            expect(n).toBe(personas.length);
        });
    });

    test('con una lista vacía no hace nada (y no revienta)', async () => {
        await expect(
            campanas.insertarDestinatarios('00000000-0000-0000-0000-000000000000', [])
        ).resolves.toBeUndefined();
    });
});

// Meta rechaza un parámetro vacío (#131008) y la pantalla solo manda la oferta: la primera prueba
// en producción salió con el nombre del negocio en blanco (2026-10-13).
describe('los huecos que el dueño no escribe', () => {
    test('el negocio sale de su ficha y el cliente de la suya, con el primer nombre', async () => {
        const [[p]] = await sequelize.query(
            `SELECT pn.id_persona_negocio, pn.id_negocio, pn.nombre_mostrado, n.nombre AS negocio
               FROM platform.persona_negocio pn
               JOIN general.gener_negocio n ON n.id_negocio = pn.id_negocio
              WHERE coalesce(trim(pn.nombre_mostrado), '') <> ''
              LIMIT 1;`
        );
        if (!p) return console.warn('[destinatarios_db] no hay personas con nombre');

        const r = await campanas.completarParametros({
            idNegocio: p.id_negocio,
            idPersonaNegocio: p.id_persona_negocio,
            parametros: { oferta: '2x1', cliente: '', negocio: '' },
        });
        expect(r.oferta).toBe('2x1');
        expect(r.negocio).toBe(p.negocio.trim());
        const primero = p.nombre_mostrado.trim().split(/\s+/)[0];
        expect(r.cliente.toLowerCase()).toBe(primero.toLowerCase());
    });

    test('sin cliente conocido el saludo no queda vacío, y lo ya escrito se respeta', async () => {
        const [[n]] = await sequelize.query('SELECT id_negocio FROM general.gener_negocio LIMIT 1;');
        const sinNadie = await campanas.completarParametros({
            idNegocio: n.id_negocio,
            parametros: { oferta: 'x', cliente: '', negocio: '' },
        });
        expect(sinNadie.cliente).toBe('de nuevo');
        expect(sinNadie.negocio).not.toBe('');

        const prueba = await campanas.completarParametros({
            idNegocio: n.id_negocio,
            parametros: { oferta: 'x', cliente: 'Prueba', negocio: 'Mi local' },
        });
        expect(prueba.cliente).toBe('Prueba');
        expect(prueba.negocio).toBe('Mi local');
    });
});
