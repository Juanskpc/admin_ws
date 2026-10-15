/**
 * Barrios y veredas por comuna/corregimiento, con precio por zona (2026-10-15).
 *
 *  - el listado de la ciudad se copia al negocio sin precios, y copiarlo dos veces no duplica;
 *  - un barrio sin precio propio vale lo de su zona; con precio propio, el suyo;
 *  - «aplicar a todos» iguala la zona; la subida general suma a zonas y precios propios;
 *  - el cliente y el asistente solo ven barrios con precio, con su zona;
 *  - la plantilla de Excel va y vuelve;
 *  - otro negocio no puede tocar nada.
 *
 * Corre contra la base local con `Restaurante Demo` y la migración `restaurante-zonas-domicilio`.
 */
'use strict';

require('dotenv').config();

const ExcelJS = require('exceljs');
const Models = require('../../app_core/models/conection');
const Barrios = require('../../app_restaurante_api/services/barrioService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idOtroNegocio;
let maxZona;
let maxBarrio;
let flagOriginal;

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

const barrio = (lista, zona, nombre) => lista.find((b) => b.zona === zona && b.nombre === nombre);

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio, permite_pago_domicilio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`
    );
    idNegocio = negocio.id_negocio;
    flagOriginal = negocio.permite_pago_domicilio;
    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario
          WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio }
    )).id_usuario;
    idOtroNegocio = (await unaFila(
        `SELECT n.id_negocio FROM general.gener_negocio n
          WHERE n.id_negocio <> :n AND NOT EXISTS (
                SELECT 1 FROM general.gener_negocio_usuario nu WHERE nu.id_negocio = n.id_negocio AND nu.id_usuario = :u)
          ORDER BY n.id_negocio LIMIT 1;`,
        { n: idNegocio, u: idUsuario }
    )).id_negocio;
    maxZona = Number((await unaFila('SELECT COALESCE(max(id_zona_domicilio), 0) AS m FROM restaurante.rest_zona_domicilio')).m);
    maxBarrio = Number((await unaFila('SELECT COALESCE(max(id_barrio), 0) AS m FROM restaurante.rest_barrio_domicilio')).m);
    await Models.GenerNegocio.update({ permite_pago_domicilio: true }, { where: { id_negocio: idNegocio } });
});

afterAll(async () => {
    await sequelize.query('DELETE FROM restaurante.rest_barrio_domicilio WHERE id_barrio > :m', { replacements: { m: maxBarrio } });
    await sequelize.query('DELETE FROM restaurante.rest_zona_domicilio WHERE id_zona_domicilio > :m', { replacements: { m: maxZona } });
    await Models.GenerNegocio.update({ permite_pago_domicilio: flagOriginal }, { where: { id_negocio: idNegocio } });
    await sequelize.close();
});

describe('zonas de domicilio', () => {
    let zonas;
    let comuna1;
    let catambuco;

    test('el listado de Pasto se copia sin precios, y copiarlo otra vez no duplica', async () => {
        const r = await Barrios.importarCatalogo(idUsuario, { id_negocio: idNegocio, ciudad: 'Pasto' });
        expect(r.zonas_nuevas).toBe(29);
        expect(r.barrios_nuevos).toBe(555);

        const otra = await Barrios.importarCatalogo(idUsuario, { id_negocio: idNegocio, ciudad: 'pasto' });
        expect(otra).toEqual({ zonas_nuevas: 0, barrios_nuevos: 0 });

        zonas = (await Barrios.listarZonas(idUsuario, idNegocio)).zonas;
        comuna1 = zonas.find((z) => z.nombre === 'Comuna 1');
        catambuco = zonas.find((z) => z.nombre === 'Catambuco');
        expect(comuna1).toMatchObject({ tipo: 'COMUNA', valor: null, barrios: 21 });
        expect(catambuco.tipo).toBe('CORREGIMIENTO');

        // Sin precio todavía: nada se le ofrece al cliente.
        const pub = await Barrios.listarPublico(idNegocio);
        expect(pub.barrios.filter((b) => b.zona === 'Comuna 1')).toEqual([]);
    });

    test('el precio de la zona lo heredan sus barrios; un precio propio manda', async () => {
        await Barrios.editarZona(idUsuario, comuna1.id_zona_domicilio, { id_negocio: idNegocio, valor: 5000 });
        let lista = await Barrios.listar(idUsuario, idNegocio);
        const centro = barrio(lista, 'Comuna 1', 'Centro');
        expect(centro).toMatchObject({ valor: null, valor_efectivo: 5000, tipo: 'BARRIO' });

        await Barrios.editar(idUsuario, centro.id_barrio, { id_negocio: idNegocio, valor: 4000 });
        lista = await Barrios.listar(idUsuario, idNegocio);
        expect(barrio(lista, 'Comuna 1', 'Centro').valor_efectivo).toBe(4000);
        expect(barrio(lista, 'Comuna 1', 'Bombona').valor_efectivo).toBe(5000);

        // El cliente lo ve con su zona, y el pedido cobra lo mismo.
        const pub = await Barrios.listarPublico(idNegocio);
        const pubCentro = pub.barrios.find((b) => b.id_barrio === centro.id_barrio);
        expect(pubCentro).toEqual({ id_barrio: centro.id_barrio, nombre: 'Centro', valor: 4000, zona: 'Comuna 1' });
        await expect(Barrios.resolverBarrio({ idNegocio, idBarrio: centro.id_barrio })).resolves.toMatchObject({ valor: 4000 });

        // Vuelve a heredar con valor null.
        await Barrios.editar(idUsuario, centro.id_barrio, { id_negocio: idNegocio, valor: null });
        await expect(Barrios.resolverBarrio({ idNegocio, idBarrio: centro.id_barrio })).resolves.toMatchObject({ valor: 5000 });
    });

    test('un barrio de una zona sin precio no se puede usar en un pedido', async () => {
        const lista = await Barrios.listar(idUsuario, idNegocio);
        const vereda = lista.find((b) => b.zona === 'Catambuco');
        expect(vereda.tipo).toBe('VEREDA');
        await expect(Barrios.resolverBarrio({ idNegocio, idBarrio: vereda.id_barrio })).rejects.toMatchObject({
            code: 'ZONA_INVALIDA',
        });
    });

    test('«aplicar a todos» iguala la zona; la subida general suma a zonas y precios propios', async () => {
        let lista = await Barrios.listar(idUsuario, idNegocio);
        const bombona = barrio(lista, 'Comuna 1', 'Bombona');
        await Barrios.editar(idUsuario, bombona.id_barrio, { id_negocio: idNegocio, valor: 7000 });

        const r = await Barrios.editarZona(idUsuario, comuna1.id_zona_domicilio, {
            id_negocio: idNegocio, valor: 6000, aplicar_a_todos: true,
        });
        expect(r.igualados).toBe(1);
        lista = await Barrios.listar(idUsuario, idNegocio);
        expect(barrio(lista, 'Comuna 1', 'Bombona')).toMatchObject({ valor: null, valor_efectivo: 6000 });

        await Barrios.editar(idUsuario, bombona.id_barrio, { id_negocio: idNegocio, valor: 7000 });
        const ajuste = await Barrios.ajustarPrecios(idUsuario, { id_negocio: idNegocio, monto: 1000 });
        expect(ajuste.zonas).toBeGreaterThanOrEqual(1);
        lista = await Barrios.listar(idUsuario, idNegocio);
        expect(barrio(lista, 'Comuna 1', 'Bombona').valor_efectivo).toBe(8000);
        expect(barrio(lista, 'Comuna 1', 'Centro').valor_efectivo).toBe(7000);
        // Lo que no tenía precio sigue sin tenerlo.
        expect(lista.find((b) => b.zona === 'Catambuco').valor_efectivo).toBeNull();
    });

    test('la plantilla de Excel va y vuelve', async () => {
        const buffer = await Barrios.exportarPlantilla(idUsuario, { id_negocio: idNegocio });
        const libro = new ExcelJS.Workbook();
        await libro.xlsx.load(buffer);
        const hojaZonas = libro.getWorksheet('Comunas y corregimientos');
        const hojaBarrios = libro.getWorksheet('Barrios y veredas');
        expect(hojaZonas.rowCount).toBeGreaterThanOrEqual(30);

        // Catambuco a $9.000, y una vereda suya a $12.000.
        hojaZonas.eachRow((fila) => {
            if (fila.getCell(2).value === 'Catambuco') fila.getCell(3).value = 9000;
        });
        let veredaNombre = null;
        hojaBarrios.eachRow((fila, n) => {
            if (n > 1 && !veredaNombre && fila.getCell(1).value === 'Catambuco') {
                veredaNombre = fila.getCell(3).value;
                fila.getCell(4).value = '$12.000';
            }
        });
        // Y un barrio nuevo que no estaba.
        hojaBarrios.addRow(['Comuna 1', 'Barrio', 'TEST Barrio Nuevo', 3500]);

        const r = await Barrios.importarPlantilla(idUsuario, {
            id_negocio: idNegocio,
            buffer: await libro.xlsx.writeBuffer(),
        });
        expect(r.barrios_creados).toBe(1);
        const lista = await Barrios.listar(idUsuario, idNegocio);
        expect(barrio(lista, 'Catambuco', veredaNombre).valor_efectivo).toBe(12000);
        expect(lista.filter((b) => b.zona === 'Catambuco' && b.nombre !== veredaNombre).every((b) => b.valor_efectivo === 9000)).toBe(true);
        expect(barrio(lista, 'Comuna 1', 'TEST Barrio Nuevo').valor_efectivo).toBe(3500);
    });

    test('una plantilla con un precio inválido no guarda nada y dice la fila', async () => {
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Comunas y corregimientos');
        hoja.addRow(['Tipo', 'Comuna/Corregimiento', 'Precio']);
        hoja.addRow(['Comuna', 'Comuna 2', 'cinco mil']);
        await expect(
            Barrios.importarPlantilla(idUsuario, { id_negocio: idNegocio, buffer: await libro.xlsx.writeBuffer() })
        ).rejects.toMatchObject({ code: 'PLANTILLA_INVALIDA', message: expect.stringContaining('Fila 2') });
        const z = (await Barrios.listarZonas(idUsuario, idNegocio)).zonas.find((x) => x.nombre === 'Comuna 2');
        expect(z.valor).toBeNull();
    });

    test('otro negocio no puede tocar nada', async () => {
        await expect(
            Barrios.editarZona(idUsuario, comuna1.id_zona_domicilio, { id_negocio: idOtroNegocio, valor: 1 })
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
            Barrios.ajustarPrecios(idUsuario, { id_negocio: idOtroNegocio, monto: 100 })
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    test('quitar una zona quita sus barrios', async () => {
        await Barrios.eliminarZona(idUsuario, catambuco.id_zona_domicilio, idNegocio);
        const lista = await Barrios.listar(idUsuario, idNegocio);
        expect(lista.some((b) => b.zona === 'Catambuco')).toBe(false);
    });
});
