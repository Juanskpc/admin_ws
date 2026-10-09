/**
 * Diseño del tiquete impreso: lo que se guarda, lo que se rechaza y lo que llega a la vista
 * previa.
 *
 * Entra por el CONTROLADOR, como `configuracion_flags.test.js`: una opción que el validador deja
 * pasar y el controlador no copia es el fallo que esta pantalla no puede tener.
 *
 * Corre contra la base de verdad y deja el negocio como estaba (borra la fila si no existía).
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const Controller = require('../../app_restaurante_api/controllers/tiqueteDisenoController');
const { normalizarTipo } = require('../../app_restaurante_api/services/tiqueteDisenoService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let filaOriginal = null;

function resFalso() {
    const capturado = { statusCode: 200, cuerpo: null };
    return {
        capturado,
        status(code) {
            capturado.statusCode = code;
            return this;
        },
        json(payload) {
            capturado.cuerpo = payload;
            return this;
        },
    };
}

async function get() {
    const res = resFalso();
    await Controller.getDiseno(
        { query: { id_negocio: idNegocio }, body: {}, params: {}, usuario: { id_usuario: idUsuario } },
        res,
    );
    return res.capturado;
}

async function put(body) {
    const res = resFalso();
    await Controller.guardar(
        { body: { id_negocio: idNegocio, ...body }, query: {}, params: {}, usuario: { id_usuario: idUsuario } },
        res,
    );
    return res.capturado;
}

beforeAll(async () => {
    const [negocio] = await sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`,
        { type: sequelize.QueryTypes.SELECT },
    );
    idNegocio = negocio.id_negocio;

    const [usuario] = await sequelize.query(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    idUsuario = usuario.id_usuario;

    filaOriginal = await Models.TiqueteDiseno.findOne({ where: { id_negocio: idNegocio }, raw: true });
});

afterAll(async () => {
    if (filaOriginal) {
        await Models.TiqueteDiseno.update(
            { comun: filaOriginal.comun, electronica: filaOriginal.electronica },
            { where: { id_negocio: idNegocio } },
        );
    } else {
        await Models.TiqueteDiseno.destroy({ where: { id_negocio: idNegocio } });
    }
    await sequelize.close();
});

describe('normalizarTipo', () => {
    it('deja pasar lo conocido y recorta los textos', () => {
        expect(
            normalizarTipo(
                { papel: '58', letra: 'grande', pie: '  Gracias  ', campos: { nit: false } },
                'comun',
            ),
        ).toEqual({ papel: '58', letra: 'grande', pie: 'Gracias', campos: { nit: false } });
    });

    it('vacío o nulo es «todo por defecto»', () => {
        expect(normalizarTipo(null, 'comun')).toEqual({});
        expect(normalizarTipo({}, 'comun')).toEqual({});
    });

    it.each([
        [{ papel: '110' }, 'OPCION_INVALIDA'],
        [{ colorido: true }, 'OPCION_DESCONOCIDA'],
        [{ campos: { cufe: false } }, 'CAMPO_DESCONOCIDO'],
        [{ campos: { nit: 'no' } }, 'CAMPOS_INVALIDOS'],
        [{ pie: 'x'.repeat(161) }, 'TEXTO_MUY_LARGO'],
        [[], 'DISENO_INVALIDO'],
    ])('rechaza %j con %s', (valor, code) => {
        expect(() => normalizarTipo(valor, 'comun')).toThrow(expect.objectContaining({ code }));
    });

    it('lo que exige la DIAN no es una opción: no se puede ocultar el CUFE ni el QR', () => {
        for (const campo of ['cufe', 'qr', 'resolucion', 'razon_social']) {
            expect(() => normalizarTipo({ campos: { [campo]: false } }, 'electronica')).toThrow(
                expect.objectContaining({ code: 'CAMPO_DESCONOCIDO' }),
            );
        }
    });
});

describe('GET y PUT /restaurante/tiquete/diseno', () => {
    it('devuelve el diseño y los datos del negocio para la vista previa', async () => {
        const r = await get();
        expect(r.statusCode).toBe(200);
        const d = r.cuerpo.data;
        expect(d.diseno).toHaveProperty('comun');
        expect(d.diseno).toHaveProperty('electronica');
        expect(d.negocio.id_negocio).toBe(idNegocio);
        expect(d.negocio).toHaveProperty('nombre');
        expect(d).toHaveProperty('fiscal');
        expect(d).toHaveProperty('resolucion');
        expect(typeof d.facturacion_habilitada).toBe('boolean');
        expect(typeof d.can_edit).toBe('boolean');
    });

    it('guarda los dos diseños y los devuelve tal cual', async () => {
        const r = await put({
            comun: { papel: '58', encabezado: 'Bienvenidos', campos: { cajero: true } },
            electronica: { letra: 'pequena', campos: { mesa: false } },
        });
        expect(r.statusCode).toBe(200);
        expect(r.cuerpo.data.personalizado).toBe(true);
        expect(r.cuerpo.data.diseno.comun).toEqual({
            papel: '58',
            encabezado: 'Bienvenidos',
            campos: { cajero: true },
        });
        expect(r.cuerpo.data.diseno.electronica).toEqual({ letra: 'pequena', campos: { mesa: false } });

        const leido = await get();
        expect(leido.cuerpo.data.diseno.comun.papel).toBe('58');
    });

    it('una opción inválida no se guarda y contesta 422 con su código', async () => {
        const r = await put({ comun: { papel: '110' } });
        expect(r.statusCode).toBe(422);
        expect(r.cuerpo.errors).toEqual({ code: 'OPCION_INVALIDA' });

        const leido = await get();
        expect(leido.cuerpo.data.diseno.comun.papel).toBe('58');
    });
});
