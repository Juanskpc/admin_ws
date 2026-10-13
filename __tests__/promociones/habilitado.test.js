/**
 * La lista blanca: ¿de verdad la mira **toda** la API de promociones?
 *
 * ## Qué se está protegiendo aquí
 *
 * El módulo se le encendió a un solo negocio. Lo que esconde el menú es el frontend, y lo que
 * esconde el frontend no cierra nada: la pregunta que importa es si un token válido de **otro**
 * restaurante —cuyo administrador tiene el permiso puesto, porque la matriz lo siembra sola— puede
 * llamar a `/admin/promociones/*` y mandar publicidad a su clientela.
 *
 * Por eso esta prueba no comprueba una ruta: recorre **todos** los handlers que exporta el
 * controlador y exige que ninguno pase. Una ruta nueva que se olvide de la compuerta sale aquí el
 * día que se escribe, y no el día que un cliente que no pagó esto manda 400 mensajes.
 *
 * Sin base y sin red: `habilitado` se sustituye entero y lo que se verifica es la decisión.
 */
'use strict';

jest.mock('../../app_core/promociones/habilitado', () => ({
    CODE_NO_HABILITADO: 'PROMOS_NO_HABILITADO',
    MENSAJE_NO_HABILITADO: 'Las promociones masivas todavía no están habilitadas para este negocio.',
    estaHabilitado: jest.fn(),
    errorNoHabilitado: jest.fn(),
}));

const habilitado = require('../../app_core/promociones/habilitado');
const Alcance = require('../../app_core/authz/alcanceAdmin');
const controlador = require('../../app_admin_api/controllers/promocionController');

/** Un `res` que solo recuerda con qué lo llamaron. */
function resFalso() {
    const res = {
        statusCode: null,
        cuerpo: null,
        status(codigo) {
            this.statusCode = codigo;
            return this;
        },
        json(cuerpo) {
            this.cuerpo = cuerpo;
            return this;
        },
    };
    return res;
}

function reqFalso() {
    return {
        query: { id_negocio: '7' },
        body: { id_negocio: 7 },
        params: { id: '11111111-1111-4111-8111-111111111111', id_negocio: '7' },
        usuario: { id_usuario: 1 },
        file: null,
    };
}

/** Los handlers de verdad: lo demás que exporta el controlador son los validadores. */
function handlers() {
    return Object.entries(controlador).filter(([, valor]) => typeof valor === 'function');
}

describe('la lista blanca de promociones', () => {
    let alcanceOriginal;

    beforeEach(() => {
        // El alcance por negocio es otra comprobación y tiene sus propias pruebas: aquí se deja
        // pasar a propósito, para que lo único que pueda detener la petición sea la lista blanca.
        alcanceOriginal = Alcance.negarSiNegocioFuera;
        Alcance.negarSiNegocioFuera = () => false;
        habilitado.estaHabilitado.mockReset();
    });

    afterEach(() => {
        Alcance.negarSiNegocioFuera = alcanceOriginal;
    });

    test('exporta los 18 handlers que montan las rutas', () => {
        // Si este número cambia, la prueba de abajo recorre más (o menos) de lo que cree.
        expect(handlers()).toHaveLength(18);
    });

    test('⚠️ ningún handler trabaja para un negocio que no está en la lista', async () => {
        habilitado.estaHabilitado.mockResolvedValue(false);

        for (const [nombre, handler] of handlers()) {
            const res = resFalso();
            await handler(reqFalso(), res);

            if (nombre === 'getDisponible') {
                // La excepción razonada: su trabajo es CONTESTAR si está disponible. Un endpoint de
                // diagnóstico que responde 403 no diagnostica nada.
                expect(res.statusCode).toBe(200);
                expect(res.cuerpo?.data?.disponible).toBe(false);
                expect(res.cuerpo?.data?.motivo).toBe('PROMOS_NO_HABILITADO');
                continue;
            }

            expect([nombre, res.statusCode]).toEqual([nombre, 403]);
            expect(res.cuerpo?.errors?.code ?? res.cuerpo?.data?.code).toBe('PROMOS_NO_HABILITADO');
        }
    });

    test('y a todos se les preguntó: la compuerta no se salta en ninguna ruta', async () => {
        habilitado.estaHabilitado.mockResolvedValue(false);

        for (const [nombre, handler] of handlers()) {
            habilitado.estaHabilitado.mockClear();
            await handler(reqFalso(), resFalso());
            expect([nombre, habilitado.estaHabilitado.mock.calls.length]).toEqual([nombre, 1]);
            expect(habilitado.estaHabilitado).toHaveBeenCalledWith(7);
        }
    });
});
