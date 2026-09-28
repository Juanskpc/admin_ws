/**
 * `GET /restaurante/public/negocios/:id` — el menú digital también dice si se está atendiendo.
 *
 * Reportado el 2026-09-22: el cliente podía armar un carrito y abrir WhatsApp aunque el
 * restaurante estuviera fuera de horario, porque el bot es quien comprobaba eso — nunca el
 * menú público. Esto cierra esa puerta: la misma clasificación que lee el saludo
 * (`horarioService.estadoDeAtencion`) viaja también en la respuesta del negocio público, y es
 * el frontend (`menu-publico.ts`) quien la usa para desactivar "agregar"/"pedir".
 *
 * Los controladores se invocan con `req`/`res` de mentira, como el resto de la suite: el
 * proyecto no tiene supertest.
 *
 * Corre contra la base de verdad (`Restaurante Demo`).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const puntoCajaService = require('../../app_restaurante_api/services/puntoCajaService');
const horarioService = require('../../app_restaurante_api/services/horarioService');
const publicoController = require('../../app_restaurante_api/controllers/publicoController');

const sequelize = Models.sequelize;

let idNegocio;

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

function resFalso() {
    const r = {};
    r.status = (code) => {
        r.statusCode = code;
        return r;
    };
    r.json = (body) => {
        r.body = body;
        return r;
    };
    return r;
}

async function pedirNegocioPublico() {
    const req = { params: { id: String(idNegocio) } };
    const res = resFalso();
    await publicoController.getNegocio(req, res);
    return res.body;
}

async function abrirCaja() {
    // El turno cuelga de un punto de caja (NOT NULL): se resuelve como en producción.
    const { id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio });
    await sequelize.query(
        `INSERT INTO restaurante.rest_caja (id_negocio, id_punto_caja, id_usuario, monto_apertura, estado, fecha_apertura)
         SELECT :n, :p, (SELECT id_usuario FROM general.gener_negocio_usuario WHERE id_negocio = :n AND estado = 'A' LIMIT 1), 0, 'A', now()
          WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A');`,
        { replacements: { n: idNegocio, p: idPunto } },
    );
}

async function cerrarCaja() {
    await sequelize.query(
        `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_negocio = :n AND estado = 'A';`,
        { replacements: { n: idNegocio } },
    );
}

async function limpiarHorarioNegocio() {
    await horarioService.reemplazar({ idNegocio, idUsuario: null, bloques: [] });
}

beforeAll(async () => {
    idNegocio = (await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
    ))?.id_negocio;
});

afterEach(async () => {
    await cerrarCaja();
    await limpiarHorarioNegocio();
});

afterAll(async () => {
    await sequelize.close();
});

describe('el negocio público lleva el estado de atención', () => {
    it('trae "atencion.estado" en la respuesta', async () => {
        await abrirCaja();
        const data = (await pedirNegocioPublico()).data;
        expect(data.atencion).toBeDefined();
        expect(['abierto', 'fuera_de_horario', 'aun_no_abre', 'cerrado_sin_horario']).toContain(
            data.atencion.estado,
        );
    });

    it('fuera de horario configurado, el menú lo refleja', async () => {
        const ahora = new Date();
        const diaLejano = (new Date(ahora.getTime() - 5 * 3600 * 1000).getUTCDay() + 3) % 7;
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: diaLejano, hora_inicio: '00:00', hora_fin: '23:59:59' }],
        });
        await abrirCaja();

        const data = (await pedirNegocioPublico()).data;
        expect(data.atencion.estado).toBe('fuera_de_horario');
    });

    it('sin horario configurado y con caja abierta, "abierto"', async () => {
        await abrirCaja();
        const data = (await pedirNegocioPublico()).data;
        expect(data.atencion.estado).toBe('abierto');
    });
});

describe('proximaApertura — a qué hora abre', () => {
    // Miércoles 30-sep-2026. Bogotá = UTC-5: las 15:00 allá son las 20:00Z.
    const aBogota = (hhmm) => new Date(Date.UTC(2026, 8, 30, Number(hhmm.slice(0, 2)) + 5, Number(hhmm.slice(3))));
    const MIERCOLES = 3;
    const JUEVES = 4;

    async function cargar(bloques) {
        await horarioService.reemplazar({ idNegocio, idUsuario: null, bloques });
    }

    it('sin horario cargado no hay próxima apertura que decir', async () => {
        expect(await horarioService.proximaApertura({ idNegocio, ahora: aBogota('15:00') })).toBeNull();
    });

    it('si hoy abre más tarde, dice la hora de hoy', async () => {
        await cargar([{ dia_semana: MIERCOLES, hora_inicio: '17:00', hora_fin: '22:00' }]);
        expect(await horarioService.proximaApertura({ idNegocio, ahora: aBogota('15:00') })).toEqual({
            dias_adelante: 0, dia_semana: MIERCOLES, hora: '17:00',
        });
    });

    it('con varias franjas en el día, la que sigue y no la que ya pasó', async () => {
        await cargar([
            { dia_semana: MIERCOLES, hora_inicio: '12:00', hora_fin: '14:00' },
            { dia_semana: MIERCOLES, hora_inicio: '18:00', hora_fin: '22:00' },
        ]);
        expect((await horarioService.proximaApertura({ idNegocio, ahora: aBogota('15:00') })).hora).toBe('18:00');
    });

    it('si hoy ya cerró, dice el próximo día con horario', async () => {
        await cargar([
            { dia_semana: MIERCOLES, hora_inicio: '17:00', hora_fin: '22:00' },
            { dia_semana: JUEVES, hora_inicio: '11:30', hora_fin: '22:00' },
        ]);
        expect(await horarioService.proximaApertura({ idNegocio, ahora: aBogota('23:00') })).toEqual({
            dias_adelante: 1, dia_semana: JUEVES, hora: '11:30',
        });
    });

    it('si solo abre este día de la semana y ya cerró, es el de la semana que viene', async () => {
        await cargar([{ dia_semana: MIERCOLES, hora_inicio: '17:00', hora_fin: '22:00' }]);
        expect(await horarioService.proximaApertura({ idNegocio, ahora: aBogota('23:00') })).toEqual({
            dias_adelante: 7, dia_semana: MIERCOLES, hora: '17:00',
        });
    });
});

describe('el negocio público dice cuándo abre', () => {
    it('fuera de horario, "atencion.abre" trae la próxima apertura', async () => {
        const diaLejano = (new Date(Date.now() - 5 * 3600 * 1000).getUTCDay() + 3) % 7;
        await horarioService.reemplazar({
            idNegocio, idUsuario: null,
            bloques: [{ dia_semana: diaLejano, hora_inicio: '17:00', hora_fin: '22:00' }],
        });
        await abrirCaja();

        const { atencion } = (await pedirNegocioPublico()).data;
        expect(atencion.estado).toBe('fuera_de_horario');
        expect(atencion.abre).toMatchObject({ dia_semana: diaLejano, hora: '17:00' });
        expect(atencion.abre.dias_adelante).toBeGreaterThan(0);
    });

    it('abierto no lleva "abre"', async () => {
        await abrirCaja();
        expect((await pedirNegocioPublico()).data.atencion.abre).toBeUndefined();
    });
});
