/**
 * Las secciones del salón («Piso 1», «Patio», «Terraza»…) como ENTIDAD: se crean una vez y las mesas
 * se les asignan. Antes eran un texto libre por mesa, y escribir «Piso 1» a mano diez veces creaba una
 * sección nueva con cada error de dedo.
 *
 * Lo que hay que sostener:
 *  1. Crear, renombrar y borrar; el nombre es único por negocio SIN distinguir mayúsculas ni espacios.
 *  2. Todo va acotado por negocio: una sección de otro negocio no se ve, no se toca, y no se puede
 *     escribir en una mesa (la fuga que cerró F2).
 *  3. Asignar mesas es una asignación COMPLETA: las de la lista entran, las que ya no van quedan libres.
 *  4. Borrar una sección NO borra sus mesas: quedan «sin sección».
 *  5. Editar una mesa SIN tocar su sección no se la quita.
 *  6. El tablero y la lista del POS traen el nombre y el orden de la sección.
 *
 * Corre contra la base de verdad y borra lo que crea.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const mesaService = require('../../app_restaurante_api/services/mesaService');
const seccionService = require('../../app_restaurante_api/services/mesaSeccionService');

const sequelize = Models.sequelize;
const mesasCreadas = [];
const seccionesCreadas = [];
let idNegocio;
let idOtroNegocio;

async function mesa(datos = {}) {
    const m = await mesaService.crearMesa({ idNegocio, nombre: 'TEST mesa sección', ...datos });
    mesasCreadas.push(m.id_mesa);
    return m;
}

async function seccion(nombre, negocio = idNegocio) {
    const s = await seccionService.crear({ idNegocio: negocio, nombre });
    seccionesCreadas.push(s.id_seccion);
    return s;
}

const codigo = async (promesa) => {
    try {
        await promesa;
        return null;
    } catch (e) {
        return e.code ?? e.message;
    }
};

beforeAll(async () => {
    const negocios = await sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio ORDER BY id_negocio LIMIT 2`,
        { type: sequelize.QueryTypes.SELECT },
    );
    idNegocio = negocios[0].id_negocio;
    idOtroNegocio = negocios[1].id_negocio;
});

afterAll(async () => {
    if (mesasCreadas.length > 0) await Models.RestMesa.destroy({ where: { id_mesa: mesasCreadas } });
    if (seccionesCreadas.length > 0) {
        await Models.RestMesa.update({ id_seccion: null }, { where: { id_seccion: seccionesCreadas } });
        await Models.RestMesaSeccion.destroy({ where: { id_seccion: seccionesCreadas } });
    }
    await sequelize.close();
});

describe('crear, renombrar y borrar', () => {
    it('crea con el nombre limpio y al final del orden', async () => {
        const a = await seccion('  TEST   Piso   1 ');
        const b = await seccion('TEST Piso 2');
        expect(a.nombre).toBe('TEST Piso 1');
        expect(b.orden).toBeGreaterThan(a.orden);
        expect(a.total_mesas).toBe(0);
    });

    it('el nombre es único por negocio sin distinguir mayúsculas ni espacios de más', async () => {
        await seccion('TEST Terraza');
        expect(await codigo(seccionService.crear({ idNegocio, nombre: 'test   TERRAZA' }))).toBe('NOMBRE_DUPLICADO');
        // El MISMO nombre en otro negocio sí se puede: cada negocio tiene sus secciones.
        const otra = await seccion('TEST Terraza', idOtroNegocio);
        expect(otra.nombre).toBe('TEST Terraza');
    });

    it('rechaza nombres vacíos o demasiado largos', async () => {
        expect(await codigo(seccionService.crear({ idNegocio, nombre: '   ' }))).toBe('NOMBRE_REQUERIDO');
        expect(await codigo(seccionService.crear({ idNegocio, nombre: 'x'.repeat(61) }))).toBe('NOMBRE_MUY_LARGO');
    });

    it('renombrar respeta la unicidad, pero una sección puede «renombrarse» a sí misma', async () => {
        const a = await seccion('TEST Rn A');
        await seccion('TEST Rn B');
        expect(await codigo(seccionService.renombrar({ idSeccion: a.id_seccion, idNegocio, nombre: 'test rn b' })))
            .toBe('NOMBRE_DUPLICADO');
        const igual = await seccionService.renombrar({ idSeccion: a.id_seccion, idNegocio, nombre: 'TEST RN A' });
        expect(igual.nombre).toBe('TEST RN A');
    });

    it('listar trae cuántas mesas tiene cada una', async () => {
        const s = await seccion('TEST Conteo');
        const m1 = await mesa();
        const m2 = await mesa();
        await seccionService.asignarMesas({ idSeccion: s.id_seccion, idNegocio, idsMesas: [m1.id_mesa, m2.id_mesa] });
        const lista = await seccionService.listar(idNegocio);
        expect(lista.find((x) => x.id_seccion === s.id_seccion).total_mesas).toBe(2);
    });
});

describe('aislamiento entre negocios', () => {
    it('una sección de otro negocio no se ve, no se renombra y no se borra', async () => {
        const ajena = await seccion('TEST Ajena', idOtroNegocio);
        const mias = await seccionService.listar(idNegocio);
        expect(mias.find((x) => x.id_seccion === ajena.id_seccion)).toBeUndefined();

        expect(await codigo(seccionService.renombrar({ idSeccion: ajena.id_seccion, idNegocio, nombre: 'X' })))
            .toBe('SECCION_NO_ENCONTRADA');
        expect(await codigo(seccionService.eliminar({ idSeccion: ajena.id_seccion, idNegocio })))
            .toBe('SECCION_NO_ENCONTRADA');
    });

    it('no se puede escribir una sección ajena en una mesa (crear ni editar)', async () => {
        const ajena = await seccion('TEST Ajena 2', idOtroNegocio);
        expect(await codigo(mesaService.crearMesa({ idNegocio, nombre: 'TEST x', idSeccion: ajena.id_seccion })))
            .toBe('SECCION_INVALIDA');

        const m = await mesa();
        expect(await codigo(mesaService.actualizarMesa(m.id_mesa, { idSeccion: ajena.id_seccion })))
            .toBe('SECCION_INVALIDA');
    });

    it('asignar mesas de otro negocio se rechaza', async () => {
        const s = await seccion('TEST Mias');
        const ajena = await mesaService.crearMesa({ idNegocio: idOtroNegocio, nombre: 'TEST mesa ajena' });
        mesasCreadas.push(ajena.id_mesa);
        expect(await codigo(seccionService.asignarMesas({ idSeccion: s.id_seccion, idNegocio, idsMesas: [ajena.id_mesa] })))
            .toBe('MESAS_INVALIDAS');
    });
});

describe('asignar mesas', () => {
    it('es una asignación COMPLETA: las de la lista entran y las que ya no van quedan libres', async () => {
        const s = await seccion('TEST Asignar');
        const [a, b, c] = [await mesa(), await mesa(), await mesa()];

        await seccionService.asignarMesas({ idSeccion: s.id_seccion, idNegocio, idsMesas: [a.id_mesa, b.id_mesa] });
        await seccionService.asignarMesas({ idSeccion: s.id_seccion, idNegocio, idsMesas: [b.id_mesa, c.id_mesa] });

        const filas = await Models.RestMesa.findAll({ where: { id_mesa: [a.id_mesa, b.id_mesa, c.id_mesa] }, raw: true });
        const de = (id) => filas.find((f) => f.id_mesa === id).id_seccion;
        expect(de(a.id_mesa)).toBeNull();       // ya no va
        expect(de(b.id_mesa)).toBe(s.id_seccion);
        expect(de(c.id_mesa)).toBe(s.id_seccion);
    });

    it('una mesa que estaba en OTRA sección se mueve a esta', async () => {
        const uno = await seccion('TEST Mover 1');
        const dos = await seccion('TEST Mover 2');
        const m = await mesa();
        await seccionService.asignarMesas({ idSeccion: uno.id_seccion, idNegocio, idsMesas: [m.id_mesa] });
        await seccionService.asignarMesas({ idSeccion: dos.id_seccion, idNegocio, idsMesas: [m.id_mesa] });
        const fila = await Models.RestMesa.findByPk(m.id_mesa, { raw: true });
        expect(fila.id_seccion).toBe(dos.id_seccion);
    });

    it('con lista vacía la sección se queda sin mesas', async () => {
        const s = await seccion('TEST Vaciar');
        const m = await mesa({ idSeccion: s.id_seccion });
        await seccionService.asignarMesas({ idSeccion: s.id_seccion, idNegocio, idsMesas: [] });
        expect((await Models.RestMesa.findByPk(m.id_mesa, { raw: true })).id_seccion).toBeNull();
    });
});

describe('borrar y editar mesas', () => {
    it('borrar una sección NO borra sus mesas: quedan sin sección', async () => {
        const s = await seccion('TEST Borrar');
        const m = await mesa({ idSeccion: s.id_seccion });

        const r = await seccionService.eliminar({ idSeccion: s.id_seccion, idNegocio });
        expect(r.mesas_sin_seccion).toBe(1);

        const fila = await Models.RestMesa.findByPk(m.id_mesa, { raw: true });
        expect(fila).not.toBeNull();
        expect(fila.id_seccion).toBeNull();
    });

    it('editar una mesa SIN mandar la sección no se la quita; mandar null sí', async () => {
        const s = await seccion('TEST Editar');
        const m = await mesa({ idSeccion: s.id_seccion });

        const renombrada = await mesaService.actualizarMesa(m.id_mesa, { nombre: 'TEST renombrada' });
        expect(renombrada.id_seccion).toBe(s.id_seccion);

        const sinSeccion = await mesaService.actualizarMesa(m.id_mesa, { idSeccion: null });
        expect(sinSeccion.id_seccion).toBeNull();
    });
});

describe('orden y lectura', () => {
    it('reordenar exige TODAS las secciones del negocio y ninguna ajena', async () => {
        const a = await seccion('TEST Orden A');
        const b = await seccion('TEST Orden B');
        const ajena = await seccion('TEST Orden Ajena', idOtroNegocio);

        expect(await codigo(seccionService.reordenar({ idNegocio, ids: [a.id_seccion, ajena.id_seccion] })))
            .toBe('ORDEN_INVALIDO');
        expect(await codigo(seccionService.reordenar({ idNegocio, ids: [a.id_seccion, a.id_seccion] })))
            .toBe('ORDEN_INVALIDO');

        const todas = (await seccionService.listar(idNegocio)).map((x) => x.id_seccion);
        const invertido = [...todas].reverse();
        await seccionService.reordenar({ idNegocio, ids: invertido });
        const despues = (await seccionService.listar(idNegocio)).map((x) => x.id_seccion);
        expect(despues).toEqual(invertido);
        expect(despues.indexOf(b.id_seccion)).toBeLessThan(despues.indexOf(a.id_seccion));
    });

    it('el tablero y la lista del POS traen id, nombre y orden de la sección', async () => {
        const s = await seccion('TEST Lectura');
        const m = await mesa({ idSeccion: s.id_seccion });
        const sin = await mesa();

        const tablero = await mesaService.getMesasDashboard(idNegocio);
        const enTablero = tablero.find((x) => x.id_mesa === m.id_mesa);
        expect(enTablero.id_seccion).toBe(s.id_seccion);
        expect(enTablero.seccion).toBe('TEST Lectura');
        expect(typeof enTablero.seccion_orden).toBe('number');
        expect(tablero.find((x) => x.id_mesa === sin.id_mesa).seccion).toBeNull();

        const lista = await mesaService.getMesas(idNegocio);
        expect(lista.find((x) => x.id_mesa === m.id_mesa).seccion).toBe('TEST Lectura');
    });
});
