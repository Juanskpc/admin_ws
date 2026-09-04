/**
 * Suite de datos fiscales (FE-1) — `app_core/facturacion/datosFiscales.js`.
 *
 * Requiere la migración de FE-1:  npm run migrate:facturacion
 *
 * Correr con:  npx jest __tests__/facturacion/datos_fiscales.test.js --runInBand
 *
 * Corre igual de bien contra la base compartida (5433, la de trabajo por defecto) que contra la
 * local: crea su propio negocio de usar y tirar y lo borra al terminar, y no depende de tiempos
 * —que es lo único que falla contra el VPS por la latencia y el desfase de reloj.
 *
 * Lo que se comprueba es la promesa de FE-1: que un negocio en modo NINGUNO **no se entera de
 * nada**, y que activar la facturación no responde «no» sino **qué falta**.
 */
'use strict';
require('dotenv').config();

const db = require('../../app_core/models/conection');
const {
    MODO,
    REGISTRO,
    asegurarFicha,
    obtener,
    puedeEmitir,
    actualizar,
    declarar,
    catalogos,
} = require('../../app_core/facturacion/datosFiscales');

const sequelize = db.sequelize;

/** Negocio de usar y tirar, creado y borrado por la propia suite. */
let idNegocio;

async function fijarFicha(campos) {
    const asignaciones = Object.keys(campos)
        .map((c) => `${c} = :${c}`)
        .join(', ');
    await sequelize.query(
        `UPDATE general.gener_negocio_fiscal SET ${asignaciones} WHERE id_negocio = :idNegocio;`,
        { replacements: { ...campos, idNegocio } }
    );
}

beforeAll(async () => {
    const filas = await sequelize.query(
        `INSERT INTO general.gener_negocio (nombre, estado)
         VALUES ('TEST FE-1 (borrar)', 'A')
         RETURNING id_negocio;`,
        { type: sequelize.QueryTypes.INSERT }
    );
    idNegocio = filas[0][0].id_negocio;

    // La migración siembra la fila para los negocios que existían; este se creó después.
    await sequelize.query(
        `INSERT INTO general.gener_negocio_fiscal (id_negocio) VALUES (:idNegocio)
         ON CONFLICT (id_negocio) DO NOTHING;`,
        { replacements: { idNegocio } }
    );
});

afterAll(async () => {
    if (idNegocio) {
        // gener_negocio_fiscal cae por ON DELETE CASCADE.
        await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :idNegocio;`, {
            replacements: { idNegocio },
        });
    }
    await sequelize.close();
});

describe('el negocio que no factura', () => {
    test('nace en modo NINGUNO', async () => {
        const ficha = await obtener(idNegocio);
        expect(ficha).not.toBeNull();
        expect(ficha.modo_facturacion).toBe(MODO.NINGUNO);
    });

    test('no se le pide NADA: puede=false pero sin faltantes', async () => {
        // Es la promesa entera de FE-1. Si esta lista deja de estar vacía, le estamos poniendo
        // deberes a un cliente que no pidió facturar.
        const r = await puedeEmitir(idNegocio);
        expect(r.puede).toBe(false);
        expect(r.motivo).toBe('MODO_NINGUNO');
        expect(r.faltan).toEqual([]);
    });
});

describe('al activar, dice qué falta', () => {
    beforeAll(async () => {
        // El orden importa y lo obliga la base: primero se declara que el negocio está
        // registrado, y solo entonces se le puede poner un modo distinto de NINGUNO.
        await fijarFicha({ estado_registro: REGISTRO.REGISTRADO, modo_facturacion: MODO.POS });
    });

    test('con la ficha vacía enumera todo lo que hace falta', async () => {
        const r = await puedeEmitir(idNegocio);
        expect(r.puede).toBe(false);
        expect(r.motivo).toBe('DATOS_INCOMPLETOS');
        expect(r.faltan.length).toBeGreaterThan(5);
        expect(r.faltan.join(' ')).toMatch(/razón social/i);
        expect(r.faltan.join(' ')).toMatch(/municipio/i);
    });

    test('con todo cargado y el DV correcto, puede emitir', async () => {
        await fijarFicha({
            tipo_persona: '1',
            tipo_documento: '31',
            numero_documento: '800197268',
            dv: '4',
            razon_social: 'NEGOCIO DE PRUEBA S.A.S.',
            direccion_fiscal: 'Calle 1 # 2-3',
            municipio_dane: '05001',
            departamento_dane: '05',
            correo_facturacion: 'facturacion@ejemplo.test',
        });
        await sequelize.query(
            `UPDATE general.gener_negocio_fiscal
                SET responsabilidades_fiscales = ARRAY['R-99-PN']::varchar(20)[],
                    tributos = ARRAY['04']::varchar(4)[]
              WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio } }
        );

        const r = await puedeEmitir(idNegocio);
        expect(r.faltan).toEqual([]);
        expect(r.puede).toBe(true);
        expect(r.modo).toBe(MODO.POS);
    });

    test('un DV que no corresponde se caza aquí, no en el rechazo de la DIAN', async () => {
        await fijarFicha({ dv: '9' });

        const r = await puedeEmitir(idNegocio);
        expect(r.puede).toBe(false);
        // Y dice cuál era el correcto, que es lo que ahorra el viaje al RUT.
        expect(r.faltan.join(' ')).toMatch(/debería ser 4/);

        await fijarFicha({ dv: '4' });
    });

    test('a una persona natural le pide además el nombre partido', async () => {
        await fijarFicha({ tipo_persona: '2' });

        const r = await puedeEmitir(idNegocio);
        expect(r.puede).toBe(false);
        expect(r.faltan.join(' ')).toMatch(/apellido/i);

        await fijarFicha({ tipo_persona: '1' });
    });
});

describe('el negocio que NO está registrado', () => {
    // Buena parte de los clientes de EscalApp son negocios informales, y ayudarlos a crecer es
    // parte del producto. Que no estén registrados no es una ficha a medio llenar: es una
    // respuesta, y hay que dejar de preguntarles.
    afterAll(async () => {
        await fijarFicha({ estado_registro: REGISTRO.REGISTRADO });
    });

    test('contesta SIN_REGISTRO y no le pide NADA', async () => {
        await fijarFicha({ modo_facturacion: MODO.NINGUNO });
        await fijarFicha({ estado_registro: REGISTRO.SIN_REGISTRO });

        const r = await puedeEmitir(idNegocio);
        expect(r.puede).toBe(false);
        expect(r.motivo).toBe('SIN_REGISTRO');
        expect(r.faltan).toEqual([]);
    });

    test('la BASE impide activarle la facturación, no solo la aplicación', async () => {
        // El invariante vive en un CHECK justamente para que ningún camino de escritura
        // —panel, script, migración futura— pueda saltárselo por olvido.
        await expect(fijarFicha({ modo_facturacion: MODO.POS })).rejects.toThrow(
            /chk_negfiscal_modo_requiere_registro/
        );
    });

    test('NO_DECLARADO no es lo mismo que SIN_REGISTRO', async () => {
        // Al primero hay que preguntarle; al segundo no hay que volver a molestarlo. Si esta
        // diferencia se pierde, la interfaz acaba dándole la lata a quien ya contestó.
        await fijarFicha({ estado_registro: REGISTRO.NO_DECLARADO });
        const r = await puedeEmitir(idNegocio);
        expect(r.motivo).toBe('MODO_NINGUNO');
        expect(r.motivo).not.toBe('SIN_REGISTRO');
    });
});

describe('asegurarFicha', () => {
    test('es idempotente: llamarla dos veces no duplica ni pisa nada', async () => {
        await fijarFicha({ razon_social: 'NO ME PISES S.A.S.' });

        await asegurarFicha(idNegocio);
        await asegurarFicha(idNegocio);

        const ficha = await obtener(idNegocio);
        expect(ficha.razon_social).toBe('NO ME PISES S.A.S.');

        const filas = await sequelize.query(
            `SELECT count(*)::int AS n FROM general.gener_negocio_fiscal WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
        );
        expect(filas[0].n).toBe(1);
    });

    test('la ficha nace en NINGUNO y NO_DECLARADO', async () => {
        const filas = await sequelize.query(
            `INSERT INTO general.gener_negocio (nombre, estado)
             VALUES ('TEST FE-1 ficha nueva (borrar)', 'A') RETURNING id_negocio;`,
            { type: sequelize.QueryTypes.INSERT }
        );
        const otro = filas[0][0].id_negocio;
        try {
            await asegurarFicha(otro);
            const ficha = await obtener(otro);
            expect(ficha.modo_facturacion).toBe(MODO.NINGUNO);
            expect(ficha.estado_registro).toBe(REGISTRO.NO_DECLARADO);
            expect(ficha.obligado_a_facturar).toBeNull();
        } finally {
            await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :otro;`, {
                replacements: { otro },
            });
        }
    });
});

describe('actualizar() — lo que guarda el panel', () => {
    test('normaliza el documento: entra con puntos y guiones, se guarda limpio', async () => {
        const ficha = await actualizar(idNegocio, {
            tipo_documento: '31',
            numero_documento: '800.197.268',
        });
        expect(ficha.numero_documento).toBe('800197268');
    });

    test('si no mandan el DV, lo calcula (es una función del número, no una adivinanza)', async () => {
        await actualizar(idNegocio, { dv: null });
        const ficha = await actualizar(idNegocio, {
            tipo_documento: '31',
            numero_documento: '890903938',
        });
        expect(ficha.dv).toBe('8');
    });

    test('si mandan un DV que no corresponde, lo rechaza y dice cuál era', async () => {
        // Vale la pena que reviente aquí: si pasa, la DIAN rechaza CADA documento que se emita
        // con ese NIT, y el mensaje de error de allá no siempre dice que el problema era el DV.
        await expect(
            actualizar(idNegocio, { tipo_documento: '31', numero_documento: '800197268', dv: '9' })
        ).rejects.toMatchObject({ code: 'DV_INVALIDO', statusCode: 400 });

        await expect(
            actualizar(idNegocio, { tipo_documento: '31', numero_documento: '800197268', dv: '9' })
        ).rejects.toThrow(/debería ser 4/);
    });

    test('acepta un subconjunto: la ficha se llena en varias tandas', async () => {
        const ficha = await actualizar(idNegocio, { razon_social: 'PRUEBAS S.A.S.' });
        expect(ficha.razon_social).toBe('PRUEBAS S.A.S.');
        // Y no pisa lo que ya estaba.
        expect(ficha.numero_documento).toBeTruthy();
    });

    test('rechaza un municipio escrito por nombre', async () => {
        await expect(actualizar(idNegocio, { municipio_dane: 'Medellín' })).rejects.toMatchObject({
            code: 'MUNICIPIO_INVALIDO',
        });
    });

    test('rechaza un departamento que no existe', async () => {
        await expect(actualizar(idNegocio, { departamento_dane: '99' })).resolves.toBeTruthy();
        await expect(actualizar(idNegocio, { departamento_dane: '01' })).rejects.toMatchObject({
            code: 'DEPARTAMENTO_INVALIDO',
        });
    });

    test('ignora campos que no están en la lista blanca', async () => {
        // modo_facturacion NO se cambia por aquí: es una declaración, no un dato.
        await expect(
            actualizar(idNegocio, { modo_facturacion: MODO.COMPLETO })
        ).rejects.toMatchObject({ code: 'SIN_CAMBIOS' });
    });
});

describe('declarar() — lo que firma el cliente', () => {
    test('deja constancia de quién declaró y cuándo', async () => {
        const { ficha } = await declarar(
            idNegocio,
            { estado_registro: REGISTRO.REGISTRADO, obligado_a_facturar: true },
            { idUsuario: null }
        );
        expect(ficha.estado_registro).toBe(REGISTRO.REGISTRADO);
        expect(ficha.obligado_a_facturar).toBe(true);
        expect(ficha.declarado_en).not.toBeNull();
    });

    test('activar sin registro se rechaza con un mensaje para una persona, no con un error de BD', async () => {
        await declarar(idNegocio, { modo_facturacion: MODO.NINGUNO });
        await declarar(idNegocio, { estado_registro: REGISTRO.SIN_REGISTRO });

        const fallo = declarar(idNegocio, { modo_facturacion: MODO.POS });
        await expect(fallo).rejects.toMatchObject({ code: 'REGISTRO_REQUERIDO', statusCode: 409 });
        await expect(fallo).rejects.toThrow(/no está registrado/);
    });

    test('se puede activar el modo aunque falten datos, y contesta qué falta', async () => {
        // Es la promesa de §5.1: la validación ocurre al activar y responde QUÉ FALTA, para que
        // el formulario se pueda llenar en dos ratos.
        await declarar(idNegocio, { estado_registro: REGISTRO.REGISTRADO });
        const { estado } = await declarar(idNegocio, { modo_facturacion: MODO.POS });
        expect(estado.modo).toBe(MODO.POS);
        expect(Array.isArray(estado.faltan)).toBe(true);
    });

    test('rechaza valores que no existen', async () => {
        await expect(
            declarar(idNegocio, { estado_registro: 'MAS_O_MENOS' })
        ).rejects.toMatchObject({ code: 'ESTADO_REGISTRO_INVALIDO' });
        await expect(declarar(idNegocio, { modo_facturacion: 'TODO' })).rejects.toMatchObject({
            code: 'MODO_INVALIDO',
        });
    });
});

describe('catalogos()', () => {
    test('trae los 33 departamentos y los impuestos activos', async () => {
        const c = await catalogos();
        expect(c.departamentos).toHaveLength(33);
        expect(c.impuestos.length).toBeGreaterThanOrEqual(5);
        // El impoconsumo del 8% tiene que estar: es el de los restaurantes, y confundirlo con
        // IVA es el error tributario más fácil de este dominio.
        expect(c.impuestos.some((i) => i.codigo === '04' && Number(i.tarifa) === 8)).toBe(true);
    });
});

describe('negocio inexistente', () => {
    test('no revienta: contesta SIN_FICHA', async () => {
        const r = await puedeEmitir(-1);
        expect(r.puede).toBe(false);
        expect(r.motivo).toBe('SIN_FICHA');
    });
});
