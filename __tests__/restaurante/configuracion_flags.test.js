/**
 * Los interruptores de Configuración llegan hasta la base.
 *
 * Esta suite existe por un fallo concreto: el controlador copiaba el cuerpo campo por campo a
 * un objeto nuevo, y las dos banderas añadidas después —`permite_cuentas_cliente` y
 * `controla_inventario`— nunca se añadieron a esa copia. El interruptor viajaba, el validador
 * lo daba por bueno, y el servicio contestaba **«No se enviaron cambios para guardar»** con un
 * 400: el campo se perdía en medio, en el único punto donde nadie miraba.
 *
 * Por eso las pruebas entran por el CONTROLADOR y no por el servicio. Contra el servicio, las
 * dos banderas funcionaban perfectamente mientras la pantalla estaba rota — que es exactamente
 * la clase de verde que no sirve para nada.
 *
 * Corre contra la base de verdad y deja el negocio como estaba.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const Configuracion = require('../../app_restaurante_api/controllers/configuracionController');

const sequelize = Models.sequelize;

/** Las banderas que la pantalla de Operación puede encender y apagar. */
const BANDERAS = [
    'permite_multipago',
    'permite_pago_domicilio',
    'permite_descuento',
    'pregunta_cobro_envio',
    'permite_cuentas_cliente',
    'controla_inventario',
];

let idNegocio;
let idUsuario;
let valoresOriginales = {};

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

async function patchConfiguracion(body) {
    const res = resFalso();
    await Configuracion.updateConfiguracion(
        { body: { id_negocio: idNegocio, ...body }, query: {}, params: {}, usuario: { id_usuario: idUsuario } },
        res,
    );
    return res.capturado;
}

async function leerBanderasEnBase() {
    const [fila] = await sequelize.query(
        `SELECT ${BANDERAS.join(', ')} FROM general.gener_negocio WHERE id_negocio = :n;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    return fila;
}

beforeAll(async () => {
    const [negocio] = await sequelize.query(
        `SELECT id_negocio, ${BANDERAS.join(', ')} FROM general.gener_negocio
          WHERE nombre = 'Restaurante Demo';`,
        { type: sequelize.QueryTypes.SELECT },
    );
    idNegocio = negocio.id_negocio;
    valoresOriginales = Object.fromEntries(BANDERAS.map((b) => [b, negocio[b]]));

    const [usuario] = await sequelize.query(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    idUsuario = usuario.id_usuario;
});

afterAll(async () => {
    const asignaciones = BANDERAS.map((b) => `${b} = :${b}`).join(', ');
    await sequelize.query(
        `UPDATE general.gener_negocio SET ${asignaciones} WHERE id_negocio = :n;`,
        { replacements: { ...valoresOriginales, n: idNegocio } },
    );
    await sequelize.close();
});

describe('interruptores de Configuración', () => {
    // Una por bandera: si mañana se añade otra y se olvida en la lista blanca del
    // controlador, este test lo dice con el nombre del campo, no con un 400 genérico.
    for (const bandera of BANDERAS) {
        it(`${bandera} se puede apagar y volver a encender`, async () => {
            const apagado = await patchConfiguracion({ [bandera]: false });
            expect(apagado.statusCode).toBe(200);
            expect(apagado.cuerpo.data[bandera]).toBe(false);
            expect((await leerBanderasEnBase())[bandera]).toBe(false);

            const encendido = await patchConfiguracion({ [bandera]: true });
            expect(encendido.statusCode).toBe(200);
            expect(encendido.cuerpo.data[bandera]).toBe(true);
            expect((await leerBanderasEnBase())[bandera]).toBe(true);
        });
    }

    it('un cuerpo sin ningún cambio sí responde que no hay nada que guardar', async () => {
        const res = await patchConfiguracion({});

        expect(res.statusCode).toBe(400);
        expect(res.cuerpo.message).toMatch(/no se enviaron cambios/i);
    });

    it('un campo que no está en la lista blanca se ignora, no se guarda', async () => {
        const res = await patchConfiguracion({ estado: 'I' });

        // Sin campos editables el servicio responde 400: prueba de que `estado` no viajó.
        expect(res.statusCode).toBe(400);
        const [fila] = await sequelize.query(
            'SELECT estado FROM general.gener_negocio WHERE id_negocio = :n;',
            { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
        );
        expect(fila.estado).toBe('A');
    });
});
