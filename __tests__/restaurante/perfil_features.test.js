/**
 * El perfil de restaurante lleva las `features` del plan.
 *
 * Esta suite existe porque el campo es nuevo (2026-10-08) y **nadie lo nota cuando falta**.
 * `negocio_app` lo usa para decidir entre dos pantallas que se parecen: «tu plan no incluye el
 * asistente» y «lo incluye pero no has conectado el número». Si `features` llega vacío por un
 * error —un negocio sin fila de plan, un cambio en `featuresDeNegocios`— la app enseña la
 * invitación a mejorar el plan a un cliente que YA pagó por el asistente, y eso no revienta
 * nada: solo le dice al cliente que compre lo que ya tiene.
 *
 * Se entra por el SERVICIO (`verificarAccesoRestaurante`) y no por el controlador: lo que se
 * comprueba es la forma del perfil, y el controlador solo le añade el estado del plan.
 *
 * Corre contra la base de verdad y **no escribe nada**.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const DashboardService = require('../../app_restaurante_api/services/dashboardService');
const { featuresDeNegocios, FEATURE } = require('../../intelligence/core/features');

const sequelize = Models.sequelize;

/** Un usuario con acceso a algún negocio de restaurante, para no inventar datos. */
async function unUsuarioDeRestaurante() {
    const [fila] = await sequelize.query(
        `SELECT nu.id_usuario, nu.id_negocio
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_negocio n ON n.id_negocio = nu.id_negocio AND n.estado = 'A'
           JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
          WHERE nu.estado = 'A' AND UPPER(TRIM(t.nombre)) = 'RESTAURANTE'
          ORDER BY nu.id_negocio
          LIMIT 1;`,
        { type: sequelize.QueryTypes.SELECT },
    );
    return fila || null;
}

describe('perfil de restaurante — features del plan', () => {
    let usuario;
    let perfil;

    beforeAll(async () => {
        usuario = await unUsuarioDeRestaurante();
        if (usuario) {
            perfil = await DashboardService.verificarAccesoRestaurante(usuario.id_usuario);
        }
    });

    afterAll(async () => {
        await sequelize.close();
    });

    test('cada negocio del perfil trae su arreglo de features', () => {
        if (!usuario) return; // base sin negocios de restaurante: no hay nada que comprobar
        expect(perfil).not.toBeNull();
        expect(Array.isArray(perfil.negocios)).toBe(true);
        for (const negocio of perfil.negocios) {
            expect(Array.isArray(negocio.features)).toBe(true);
        }
    });

    test('la raíz del perfil repite las del negocio activo', () => {
        if (!usuario || !perfil?.negocio) return;
        // La app lee `auth.negocio().features`, pero la raíz la usa quien no ha elegido negocio.
        // Que las dos digan lo mismo es lo que evita dos verdades sobre el mismo plan.
        expect(perfil.features).toEqual(perfil.negocio.features);
    });

    test('lo que dice el perfil es lo que dice la fuente de features', async () => {
        if (!usuario || !perfil?.negocios?.length) return;

        const ids = perfil.negocios.map((n) => n.id_negocio);
        const esperado = await featuresDeNegocios(ids);

        for (const negocio of perfil.negocios) {
            // Mismo conjunto, sin depender del orden: `featuresDeNegocios` arma un Set por dentro.
            expect([...negocio.features].sort())
                .toEqual([...(esperado.get(Number(negocio.id_negocio)) ?? [])].sort());
        }
    });

    test('un negocio con Plan Avanzado trae asistente_ia; uno sin plan, nada', async () => {
        const filas = await sequelize.query(
            `SELECT n.id_negocio, p.nombre AS plan
               FROM general.gener_negocio n
               JOIN general.gener_tipo_negocio t
                 ON t.id_tipo_negocio = n.id_tipo_negocio AND UPPER(TRIM(t.nombre)) = 'RESTAURANTE'
               LEFT JOIN general.gener_negocio_plan np
                 ON np.id_negocio = n.id_negocio AND np.estado = 'A'
                AND (np.fecha_fin IS NULL OR np.fecha_fin >= CURRENT_DATE)
               LEFT JOIN general.gener_plan p ON p.id_plan = np.id_plan
              WHERE n.estado = 'A';`,
            { type: sequelize.QueryTypes.SELECT },
        );
        if (filas.length === 0) return;

        const mapa = await featuresDeNegocios(filas.map((f) => f.id_negocio));
        const conAvanzado = filas.find((f) => f.plan === 'Plan Avanzado');
        const sinPlan = filas.find((f) => f.plan === null);

        // Las dos ramas se comprueban solo si la base tiene el caso: una base de desarrollo
        // recién sembrada puede no tener ninguno de los dos, y fallar por eso sería ruido.
        if (conAvanzado) {
            expect(mapa.get(Number(conAvanzado.id_negocio))).toContain(FEATURE.ASISTENTE_IA);
        }
        if (sinPlan) {
            expect(mapa.get(Number(sinPlan.id_negocio))).not.toContain(FEATURE.ASISTENTE_IA);
        }
    });
});
