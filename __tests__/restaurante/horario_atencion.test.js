/**
 * Horario de atención — del negocio, y de sus domiciliarios.
 *
 * Misma forma que `reserva.reserva_horario` (franjas semanales, día + hora inicio + hora fin),
 * en tabla propia (`restaurante.rest_horario`) por ADR-005. Dos usos:
 *
 *   1. `estaAbierto` — decide si `tomar_pedido` deja seguir o dice que el negocio está cerrado
 *      (o que ya es hora pero todavía no ha abierto la caja).
 *   2. `usuariosEnTurnoAhora` — decide a quién asigna `elegirDomiciliarioAlAzar` cuando hay más
 *      de un domiciliario: al que esté en turno, y solo si ninguno lo está, al azar.
 *
 * Corre contra la base de verdad. Usa una fecha FIJA (miércoles) para que `dia_semana` sea
 * predecible sin importar cuándo se corra la suite.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const horarioService = require('../../app_restaurante_api/services/horarioService');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario1;
let idUsuario2;

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

// 2026-09-23 es miércoles → dia_semana = 3. 15:00 UTC = 10:00 Bogotá (UTC-5, sin horario de
// verano). El día siguiente a las 04:00 UTC = 23:00 Bogotá del mismo miércoles.
const MIERCOLES_10AM = new Date('2026-09-23T15:00:00.000Z');
const MIERCOLES_11PM = new Date('2026-09-24T04:00:00.000Z');
const DIA_MIERCOLES = 3;

async function limpiarHorarios(idUsuario = null) {
    await horarioService.reemplazar({ idNegocio, idUsuario, bloques: [] });
}

beforeAll(async () => {
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    ))?.id_negocio;

    const usuarios = await sequelize.query(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 2;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    idUsuario1 = usuarios[0]?.id_usuario;
    idUsuario2 = usuarios[1]?.id_usuario ?? usuarios[0]?.id_usuario;
});

afterAll(async () => {
    await limpiarHorarios(null);
    await limpiarHorarios(idUsuario1);
    if (idUsuario2 !== idUsuario1) await limpiarHorarios(idUsuario2);
    await sequelize.close();
});

describe('estaAbierto', () => {
    afterEach(() => limpiarHorarios(null));

    it('sin horario configurado, el negocio se considera siempre abierto', async () => {
        const r = await horarioService.estaAbierto({ idNegocio, ahora: MIERCOLES_10AM });
        expect(r).toEqual({ configurado: false, abierto: true });
    });

    it('dentro del bloque configurado, abierto', async () => {
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '08:00', hora_fin: '20:00' }],
        });
        const r = await horarioService.estaAbierto({ idNegocio, ahora: MIERCOLES_10AM });
        expect(r).toEqual({ configurado: true, abierto: true });
    });

    it('fuera del bloque configurado (de noche), cerrado', async () => {
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '08:00', hora_fin: '20:00' }],
        });
        const r = await horarioService.estaAbierto({ idNegocio, ahora: MIERCOLES_11PM });
        expect(r).toEqual({ configurado: true, abierto: false });
    });

    it('un día sin ningún bloque (aunque otros días sí tengan) cuenta como cerrado', async () => {
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: (DIA_MIERCOLES + 1) % 7, hora_inicio: '00:00', hora_fin: '23:59:59' }],
        });
        const r = await horarioService.estaAbierto({ idNegocio, ahora: MIERCOLES_10AM });
        expect(r).toEqual({ configurado: true, abierto: false });
    });
});

describe('listar / reemplazar', () => {
    afterEach(async () => {
        await limpiarHorarios(null);
        await limpiarHorarios(idUsuario1);
    });

    it('reemplazar borra lo anterior, no lo acumula', async () => {
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: 1, hora_inicio: '08:00', hora_fin: '12:00' }],
        });
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: 2, hora_inicio: '08:00', hora_fin: '12:00' }],
        });
        const lista = await horarioService.listar({ idNegocio, idUsuario: null });
        expect(lista).toHaveLength(1);
        expect(lista[0].dia_semana).toBe(2);
    });

    it('el horario del negocio y el de un usuario no se pisan', async () => {
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '08:00', hora_fin: '20:00' }],
        });
        await horarioService.reemplazar({
            idNegocio, idUsuario: idUsuario1,
            bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '09:00', hora_fin: '13:00' }],
        });

        expect(await horarioService.listar({ idNegocio, idUsuario: null })).toHaveLength(1);
        expect(await horarioService.listar({ idNegocio, idUsuario: idUsuario1 })).toHaveLength(1);
    });
});

describe('usuariosEnTurnoAhora', () => {
    afterEach(async () => {
        await limpiarHorarios(idUsuario1);
        if (idUsuario2 !== idUsuario1) await limpiarHorarios(idUsuario2);
    });

    it('sin nadie con horario cargado, la lista viene vacía', async () => {
        const r = await horarioService.usuariosEnTurnoAhora({ idNegocio, ahora: MIERCOLES_10AM });
        expect(r).toEqual([]);
    });

    it('devuelve solo a quien tiene el bloque que cubre este instante', async () => {
        await horarioService.reemplazar({
            idNegocio, idUsuario: idUsuario1,
            bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '08:00', hora_fin: '12:00' }],
        });
        if (idUsuario2 !== idUsuario1) {
            await horarioService.reemplazar({
                idNegocio, idUsuario: idUsuario2,
                bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '18:00', hora_fin: '23:00' }],
            });
        }

        const r = await horarioService.usuariosEnTurnoAhora({ idNegocio, ahora: MIERCOLES_10AM });
        expect(r).toContain(idUsuario1);
        if (idUsuario2 !== idUsuario1) expect(r).not.toContain(idUsuario2);
    });
});

describe('elegirDomiciliarioAlAzar prefiere a quien está en turno', () => {
    let idRolDomiciliario;

    beforeAll(async () => {
        idRolDomiciliario = (await unaFila(
            `SELECT id_rol FROM general.gener_rol WHERE descripcion = 'DOMICILIARIO' AND id_tipo_negocio = 1;`,
        ))?.id_rol;
        for (const u of new Set([idUsuario1, idUsuario2])) {
            await sequelize.query(
                `INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
                 VALUES (:u, :r, :n, 'A') ON CONFLICT DO NOTHING;`,
                { replacements: { u, r: idRolDomiciliario, n: idNegocio } },
            );
        }
    });

    afterAll(async () => {
        for (const u of new Set([idUsuario1, idUsuario2])) {
            await sequelize.query(
                `DELETE FROM general.gener_usuario_rol
                  WHERE id_usuario = :u AND id_negocio = :n AND id_rol = :r;`,
                { replacements: { u, n: idNegocio, r: idRolDomiciliario } },
            );
        }
    });

    afterEach(async () => {
        await limpiarHorarios(idUsuario1);
        if (idUsuario2 !== idUsuario1) await limpiarHorarios(idUsuario2);
    });

    it('si solo uno está en turno, se le asigna siempre a él', async () => {
        if (idUsuario2 === idUsuario1) return; // hace falta un segundo domiciliario real
        await horarioService.reemplazar({
            idNegocio, idUsuario: idUsuario1,
            bloques: [{ dia_semana: DIA_MIERCOLES, hora_inicio: '00:00', hora_fin: '23:59:59' }],
        });
        // idUsuario2 existe como domiciliario pero sin horario: no está "en turno".

        for (let i = 0; i < 5; i++) {
            const elegido = await pedidoService.elegirDomiciliarioAlAzar(idNegocio, {
                ahora: MIERCOLES_10AM,
            });
            expect(elegido).toBe(idUsuario1);
        }
    });

    it('sin nadie en turno, cae al azar entre todos — nunca deja el pedido sin nadie', async () => {
        const elegido = await pedidoService.elegirDomiciliarioAlAzar(idNegocio, {
            ahora: MIERCOLES_10AM,
        });
        expect([idUsuario1, idUsuario2]).toContain(elegido);
    });
});
