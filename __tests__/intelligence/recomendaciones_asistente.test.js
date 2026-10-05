/**
 * Recomendaciones con IA sobre la carta (fase 2 del diagnóstico, 2026-10-05).
 * El modelo se inyecta: aquí se prueba lo que NO depende de él — qué se le deja decir, qué se
 * descarta, y que no se paga dos veces por la misma carta.
 *
 * Correr con:  npx jest __tests__/intelligence/recomendaciones_asistente.test.js
 */
'use strict';

jest.mock('../../app_admin_api/services/diagnosticoAsistenteService', () => ({
    leerCarta: jest.fn(),
    diagnosticar: jest.fn(),
}));
jest.mock('../../app_core/helpers/auditHelper', () => ({ registrarEvento: jest.fn(async () => {}) }));

const diagnostico = require('../../app_admin_api/services/diagnosticoAsistenteService');
const Audit = require('../../app_core/helpers/auditHelper');
const rec = require('../../app_admin_api/services/recomendacionesAsistenteService');

const CARTA = [
    {
        nombre: 'GASEOSAS', visible: true,
        productos: [
            { nombre: 'cuatro', precio: 5000, descripcion: '', visible: true, disponible: true },
            { nombre: 'Cigarra 400ml', precio: 1, descripcion: '', visible: true, disponible: true },
        ],
    },
    { nombre: 'EMPAQUES', visible: false, productos: [{ nombre: 'pequeño', precio: 500, visible: true }] },
];
const USO = { tokensEntrada: 2000, tokensSalida: 900, tokensCacheLectura: 0, tokensCacheEscritura: 0 };
const respuestaDelModelo = (objeto) => ({ texto: '```json\n' + JSON.stringify(objeto) + '\n```', uso: USO });

beforeEach(() => {
    rec._vaciarCache();
    jest.clearAllMocks();
    diagnostico.leerCarta.mockResolvedValue(CARTA);
    diagnostico.diagnosticar.mockResolvedValue({ aplica: true, hallazgos: [] });
});

describe('depurar — lo que se le deja decir al modelo', () => {
    const depurar = (cambios, extra = {}) => rec.depurar({ resumen: 'r', cambios, preguntas: [], ...extra }, CARTA);

    test('un cambio sobre un producto que existe se conserva (sin importar mayúsculas ni tildes)', () => {
        const d = depurar([{ accion: 'renombrar', producto: 'CUATRO', propuesta: 'Gaseosa Cuatro personal', motivo: 'm', prioridad: 'alta' }]);
        expect(d.cambios).toHaveLength(1);
        expect(d.cambios[0]).toMatchObject({ accion: 'renombrar', propuesta: 'Gaseosa Cuatro personal', prioridad: 'alta' });
    });
    test('un producto INVENTADO se descarta', () => {
        const d = depurar([{ accion: 'renombrar', producto: 'Pepsi 2 L', propuesta: 'Gaseosa Pepsi 2 L', motivo: 'm' }]);
        expect(d.cambios).toEqual([]);
        expect(d.descartados).toBe(1);
    });
    test('una propuesta que trae un PRECIO que no estaba en la carta se descarta', () => {
        const d = depurar([
            { accion: 'revisar_precio', producto: 'Cigarra 400ml', propuesta: 'Ponerla a $4.000', motivo: 'm' },
            { accion: 'revisar_precio', producto: 'Cigarra 400ml', propuesta: 'Confirmar el precio real', motivo: 'm' },
        ]);
        expect(d.cambios.map((c) => c.propuesta)).toEqual(['Confirmar el precio real']);
    });
    test('una acción desconocida pasa como «otro»; la prioridad por defecto es media; primero las altas', () => {
        const d = depurar([
            { accion: 'borrar_todo', producto: 'cuatro', propuesta: 'x', motivo: 'm' },
            { accion: 'renombrar', producto: 'cuatro', propuesta: 'y', motivo: 'm', prioridad: 'alta' },
        ]);
        expect(d.cambios.map((c) => [c.accion, c.prioridad])).toEqual([['renombrar', 'alta'], ['otro', 'media']]);
    });
    test('se puede opinar de una categoría', () => {
        expect(depurar([{ accion: 'ocultar', producto: 'GASEOSAS', propuesta: 'Ocultarla', motivo: 'm' }]).cambios).toHaveLength(1);
    });
});

describe('leerJson y cartaComoTexto', () => {
    test('lee el JSON aunque venga entre ``` o con texto alrededor', () => {
        expect(rec.leerJson('Claro:\n```json\n{"resumen":"ok"}\n```')).toEqual({ resumen: 'ok' });
        expect(rec.leerJson('no hay json')).toBeNull();
        expect(rec.leerJson('')).toBeNull();
    });
    test('lo oculto no viaja al modelo', () => {
        const t = rec.cartaComoTexto(CARTA);
        expect(t).toContain('- cuatro | $5000 | sin descripción');
        expect(t).not.toContain('EMPAQUES');
    });
});

describe('recomendar', () => {
    const generar = jest.fn(async () =>
        respuestaDelModelo({
            resumen: 'Hay nombres que no dicen qué son.',
            cambios: [{ accion: 'renombrar', producto: 'cuatro', propuesta: 'Gaseosa Cuatro personal', motivo: 'm', prioridad: 'alta' }],
            preguntas: ['¿Cuál es el precio real de la Cigarra?'],
        })
    );

    test('devuelve lo depurado, y el costo queda en la auditoría', async () => {
        const r = await rec.recomendar(6, { generar, idUsuario: 9 });
        expect(r.aplica).toBe(true);
        expect(r.cambios).toHaveLength(1);
        expect(r.preguntas).toEqual(['¿Cuál es el precio real de la Cigarra?']);
        expect(r.de_cache).toBe(false);
        expect(Audit.registrarEvento).toHaveBeenCalledWith(
            expect.objectContaining({ accion: 'diagnostico_ia', idNegocio: 6, idUsuario: 9 })
        );
        // Al modelo le llegan la carta y la instrucción de no inventar.
        const peticion = generar.mock.calls[0][0];
        expect(peticion.historial[0].texto).toContain('- cuatro | $5000');
        expect(peticion.instrucciones[0].texto).toContain('No inventes precios');
    });

    test('la misma carta no se paga dos veces; `forzar` sí vuelve a preguntar', async () => {
        generar.mockClear();
        await rec.recomendar(6, { generar });
        const segunda = await rec.recomendar(6, { generar });
        expect(generar).toHaveBeenCalledTimes(1);
        expect(segunda.de_cache).toBe(true);
        await rec.recomendar(6, { generar, forzar: true });
        expect(generar).toHaveBeenCalledTimes(2);
    });

    test('si la carta cambia, se vuelve a preguntar', async () => {
        generar.mockClear();
        await rec.recomendar(6, { generar });
        diagnostico.leerCarta.mockResolvedValue([{ ...CARTA[0], productos: [{ ...CARTA[0].productos[0], nombre: 'Gaseosa Cuatro personal' }] }]);
        await rec.recomendar(6, { generar });
        expect(generar).toHaveBeenCalledTimes(2);
    });

    test('una respuesta que no es JSON es un error claro, no una lista vacía', async () => {
        await expect(rec.recomendar(6, { generar: async () => ({ texto: '', uso: USO }) })).rejects.toMatchObject({
            code: 'DIAGNOSTICO_IA_ILEGIBLE',
            statusCode: 502,
        });
    });

    test('una vertical que el diagnóstico no cubre no llama al modelo', async () => {
        generar.mockClear();
        diagnostico.diagnosticar.mockResolvedValue({ aplica: false, hallazgos: [] });
        const r = await rec.recomendar(6, { generar });
        expect(r.aplica).toBe(false);
        expect(generar).not.toHaveBeenCalled();
    });
});
