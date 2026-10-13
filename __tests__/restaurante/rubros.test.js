/**
 * Sectores de ingreso del restaurante (rubros) — 2026-10-10.
 *
 * ## Qué defiende esta suite
 *
 * El caso que originó la función: un restaurante con tres tipos de comida quiere saber cuánto
 * deja cada uno, **aunque una misma mesa pida de los tres y pague una sola vez**. Eso es lo que
 * las cajas (`rest_punto_caja`) no pueden hacer —`pedid_orden.id_punto_caja` es NOT NULL, así
 * que una orden cae entera en una caja— y es lo primero que se comprueba aquí: el pedido mixto
 * se reparte por ÍTEM, vía `carta_categoria.id_rubro`.
 *
 * Lo segundo es el cuadre. Lo que no es producto (impuesto, domicilio, descuento) es de la
 * orden y NO se prorratea: va en líneas aparte. La suma de los sectores más esas líneas tiene
 * que dar el total cobrado, exactamente. Si eso se rompe, el informe miente sin avisar — y es
 * justo la cifra que alguien va a comparar contra el mes pasado.
 *
 * Los datos se insertan con fechas de 2019 para que ningún pedido real de la base de
 * desarrollo entre en el rango y contamine las cifras exactas que se afirman.
 *
 * Corre contra la base de verdad: `npx jest __tests__/restaurante/rubros.test.js`
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const puntoCajaService = require('../../app_restaurante_api/services/puntoCajaService');
const rubroService = require('../../app_restaurante_api/services/rubroService');
const reporteService = require('../../app_restaurante_api/services/reporteService');
const cajaService = require('../../app_restaurante_api/services/cajaService');

const sequelize = Models.sequelize;

// Rango sin pedidos reales: así las cifras se pueden afirmar al peso exacto.
const DESDE = '2019-03-01';
const HASTA = '2019-03-31';
const MARTES = '2019-03-05';
const SABADO = '2019-03-09';

let idNegocio;
let idUsuario;
let idPunto;
const cat = {};
const prod = {};
const rub = {};
const ordenes = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function crearCategoria(nombre) {
    const fila = await unaFila(
        `INSERT INTO restaurante.carta_categoria (id_negocio, nombre, orden, visible, estado)
         VALUES (:n, :nombre, 900, true, 'A') RETURNING id_categoria;`,
        { n: idNegocio, nombre },
    );
    return fila.id_categoria;
}

async function crearProducto(idCategoria, nombre, precio) {
    const fila = await unaFila(
        `INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio, estado)
         VALUES (:n, :c, :nombre, :precio, 'A') RETURNING id_producto;`,
        { n: idNegocio, c: idCategoria, nombre, precio },
    );
    return fila.id_producto;
}

/**
 * Una orden CERRADA con sus ítems. `subtotal` se calcula de los ítems y `total` como lo hace
 * `pedidoService` (subtotal + impuesto + domicilio − descuento), que es la fórmula contra la
 * que tiene que cuadrar el informe.
 */
async function crearOrden({ numero, fecha, items, domicilio = 0, descuento = 0, impuesto = 0, idUsuarioOrden = null }) {
    const subtotal = items.reduce((s, i) => s + i.precio * i.cantidad, 0);
    const total = subtotal + impuesto + domicilio - descuento;
    const fila = await unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_punto_caja, id_usuario, numero_orden, tipo_pedido, estado,
             subtotal, impuesto, valor_domicilio, descuento, total,
             fecha_creacion, fecha_cierre)
         VALUES (:n, :p, :u, :num, 'LLEVAR', 'CERRADA',
                 :subtotal, :impuesto, :domicilio, :descuento, :total,
                 :fecha::date + interval '12 hours', :fecha::date + interval '13 hours')
         RETURNING id_orden;`,
        {
            n: idNegocio, p: idPunto, u: idUsuarioOrden ?? idUsuario, num: numero,
            subtotal, impuesto, domicilio, descuento, total, fecha,
        },
    );
    for (const i of items) {
        await sequelize.query(
            `INSERT INTO restaurante.pedid_detalle
                (id_orden, id_producto, cantidad, precio_unitario, subtotal, estado)
             VALUES (:o, :p, :cant, :precio, :sub, 'ENTREGADO');`,
            { replacements: { o: fila.id_orden, p: i.id, cant: i.cantidad, precio: i.precio, sub: i.precio * i.cantidad } },
        );
    }
    ordenes.push(fila.id_orden);
    return fila.id_orden;
}

const reporte = (tipo, extra = {}) => reporteService.getReporte({
    idUsuario, idNegocio, tipo, fechaDesde: DESDE, fechaHasta: HASTA, ...extra,
});

const filaDe = (rows, rubro) => rows.find((r) => r.rubro === rubro);

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idUsuario = (await unaFila(
        `SELECT gu.id_usuario FROM general.gener_usuario_rol ur
           JOIN general.gener_usuario gu ON gu.id_usuario = ur.id_usuario
           JOIN general.gener_rol gr ON gr.id_rol = ur.id_rol
          WHERE ur.id_negocio = :n AND ur.estado = 'A' AND gr.descripcion = 'ADMINISTRADOR'
          ORDER BY gu.id_usuario LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
    ({ id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio }));

    cat.parrilla = await crearCategoria('TEST Parrilla');
    cat.sushi = await crearCategoria('TEST Sushi');
    cat.bebidas = await crearCategoria('TEST Bebidas');

    prod.churrasco = await crearProducto(cat.parrilla, 'TEST Churrasco', 30000);
    prod.roll = await crearProducto(cat.sushi, 'TEST Roll', 20000);
    prod.gaseosa = await crearProducto(cat.bebidas, 'TEST Gaseosa', 5000);

    // Dos sectores. «TEST Bebidas» se queda sin sector a propósito: es el caso «General».
    rub.parrilla = (await rubroService.crear({ idNegocio, idUsuario, nombre: 'TEST Parrilla' })).id_rubro;
    rub.sushi = (await rubroService.crear({ idNegocio, idUsuario, nombre: 'TEST Sushi' })).id_rubro;
    await rubroService.fijarCategorias({ idRubro: rub.parrilla, idNegocio, idUsuario, idsCategoria: [cat.parrilla] });
    await rubroService.fijarCategorias({ idRubro: rub.sushi, idNegocio, idUsuario, idsCategoria: [cat.sushi] });

    // EL pedido del caso: una mesa pide de los tres sectores y paga UNA vez.
    //   30.000 parrilla + 20.000 sushi + 10.000 bebidas = 60.000 de producto
    //   + 5.000 de domicilio − 2.000 de descuento = 63.000 cobrados
    await crearOrden({
        numero: 'TEST-RUB-1', fecha: MARTES, domicilio: 5000, descuento: 2000,
        items: [
            { id: prod.churrasco, cantidad: 1, precio: 30000 },
            { id: prod.roll, cantidad: 1, precio: 20000 },
            { id: prod.gaseosa, cantidad: 2, precio: 5000 },
        ],
    });

    // Un segundo pedido, otro día de la semana y solo de un sector.
    await crearOrden({
        numero: 'TEST-RUB-2', fecha: SABADO,
        items: [{ id: prod.churrasco, cantidad: 2, precio: 30000 }],
    });
});

afterAll(async () => {
    for (const id of ordenes) {
        await sequelize.query('DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o;', { replacements: { o: id } });
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o;', { replacements: { o: id } });
    }
    for (const id of Object.values(prod)) {
        await sequelize.query('DELETE FROM restaurante.carta_producto WHERE id_producto = :p;', { replacements: { p: id } });
    }
    for (const id of Object.values(rub)) {
        await sequelize.query('DELETE FROM restaurante.rest_rubro WHERE id_rubro = :r;', { replacements: { r: id } });
    }
    for (const id of Object.values(cat)) {
        await sequelize.query('DELETE FROM restaurante.carta_categoria WHERE id_categoria = :c;', { replacements: { c: id } });
    }
    await sequelize.close();
});

describe('el pedido mixto con un solo pago', () => {
    it('se reparte entre los tres sectores', async () => {
        const r = await reporte('ventas_rubro');
        expect(filaDe(r.rows, 'TEST Parrilla').ingresos).toBe(90000);  // 30.000 + 2×30.000
        expect(filaDe(r.rows, 'TEST Sushi').ingresos).toBe(20000);
        expect(filaDe(r.rows, 'General').ingresos).toBe(10000);        // 2 gaseosas
    });

    it('cuenta el pedido en cada sector del que pidió, no una sola vez', async () => {
        const r = await reporte('ventas_rubro');
        // El pedido mixto aparece en los tres; el segundo solo en Parrilla.
        expect(filaDe(r.rows, 'TEST Parrilla').ordenes).toBe(2);
        expect(filaDe(r.rows, 'TEST Sushi').ordenes).toBe(1);
        expect(filaDe(r.rows, 'General').ordenes).toBe(1);
    });

    it('las unidades son las del ítem, no las del pedido', async () => {
        const r = await reporte('ventas_rubro');
        expect(filaDe(r.rows, 'General').unidades).toBe(2);
        expect(filaDe(r.rows, 'TEST Parrilla').unidades).toBe(3);
    });
});

describe('la categoría sin sector es «General»', () => {
    it('agrupa ahí lo que se vende en todos los sectores', async () => {
        const r = await reporte('ventas_rubro');
        const general = filaDe(r.rows, 'General');
        expect(general).toBeDefined();
        expect(general.ingresos).toBe(10000);
    });

    it('al asignarle un sector deja de ser General, y al quitárselo vuelve', async () => {
        await rubroService.fijarCategorias({
            idRubro: rub.sushi, idNegocio, idUsuario, idsCategoria: [cat.sushi, cat.bebidas],
        });
        let r = await reporte('ventas_rubro');
        expect(filaDe(r.rows, 'General')).toBeUndefined();
        expect(filaDe(r.rows, 'TEST Sushi').ingresos).toBe(30000);  // 20.000 + 10.000 de bebidas

        await rubroService.fijarCategorias({ idRubro: rub.sushi, idNegocio, idUsuario, idsCategoria: [cat.sushi] });
        r = await reporte('ventas_rubro');
        expect(filaDe(r.rows, 'General').ingresos).toBe(10000);
    });
});

describe('el cuadre contra lo cobrado', () => {
    it('la suma de sectores es la venta de productos', async () => {
        const r = await reporte('ventas_rubro');
        const suma = r.graficas.por_rubro.reduce((s, x) => s + x.ingresos, 0);
        expect(suma).toBe(r.graficas.conciliacion.venta_productos);
        expect(suma).toBe(120000);  // 60.000 + 60.000
    });

    it('productos + impuesto + domicilio − descuento da el total cobrado', async () => {
        const c = (await reporte('ventas_rubro')).graficas.conciliacion;
        expect(c.domicilios).toBe(5000);
        expect(c.descuentos).toBe(2000);
        expect(c.total_cobrado).toBe(123000);  // 63.000 + 60.000
        expect(c.venta_productos + c.impuestos + c.domicilios - c.descuentos).toBe(c.total_cobrado);
    });

    it('el descuadre es 0: si no, el informe miente sin avisar', async () => {
        expect((await reporte('ventas_rubro')).graficas.conciliacion.descuadre).toBe(0);
    });

    it('lo que no es producto NO se reparte entre los sectores', async () => {
        // El domicilio y el descuento son de la orden. Si alguien los prorrateara, la suma de
        // sectores dejaría de ser 120.000 y pasaría a ser 123.000.
        const r = await reporte('ventas_rubro');
        expect(r.graficas.por_rubro.reduce((s, x) => s + x.ingresos, 0)).toBe(120000);
    });

    it('la participación se mide sobre todo el período, no sobre la página', async () => {
        const r = await reporte('ventas_rubro', { pageSize: 1 });
        expect(r.rows).toHaveLength(1);
        // 90.000 de 120.000 = 75 %, no el 100 % que daría medirlo contra la página.
        expect(r.rows[0].participacion).toBe('75.0%');
        expect(r.pagination.total).toBe(3);
    });
});

describe('el negocio que no separa sectores', () => {
    /** Apaga los sectores del negocio, corre el cuerpo y los vuelve a encender pase lo que pase. */
    async function conSectoresApagados(cuerpo) {
        const ids = Object.values(rub);
        for (const idRubro of ids) {
            await rubroService.actualizar({ idRubro, idNegocio, idUsuario, estado: 'I' });
        }
        try {
            await cuerpo();
        } finally {
            for (const idRubro of ids) {
                await rubroService.actualizar({ idRubro, idNegocio, idUsuario, estado: 'A' });
            }
        }
    }

    it('`negocioUsaRubros` es el único interruptor: no hay flag que lo contradiga', async () => {
        expect(await rubroService.negocioUsaRubros(idNegocio)).toBe(true);
        await conSectoresApagados(async () => {
            expect(await rubroService.negocioUsaRubros(idNegocio)).toBe(false);
        });
        expect(await rubroService.negocioUsaRubros(idNegocio)).toBe(true);
    });

    it('no puede pedir el informe, en vez de recibir una tabla de una sola fila «General»', async () => {
        await conSectoresApagados(async () => {
            await expect(reporte('ventas_rubro'))
                .rejects.toMatchObject({ code: 'RUBROS_NO_CONFIGURADOS', statusCode: 422 });
        });
    });

    it('tampoco lo puede exportar: la API no es una puerta de atrás al informe', async () => {
        await conSectoresApagados(async () => {
            await expect(reporteService.getExportPayload({
                idUsuario, idNegocio, tipo: 'ventas_rubro', fechaDesde: DESDE, fechaHasta: HASTA,
            })).rejects.toMatchObject({ code: 'RUBROS_NO_CONFIGURADOS', statusCode: 422 });
        });
    });

    it('desactivar un sector NO desasigna sus categorías: el histórico sigue partido', async () => {
        await rubroService.actualizar({ idRubro: rub.parrilla, idNegocio, idUsuario, estado: 'I' });
        try {
            // Queda «TEST Sushi» activo, así que el informe sigue disponible y el sector
            // apagado tiene que seguir apareciendo con sus cifras de siempre.
            const r = await reporte('ventas_rubro');
            expect(filaDe(r.rows, 'TEST Parrilla').ingresos).toBe(90000);

            const { rows } = await rubroService.listarAdmin({ idNegocio });
            const apagado = rows.find((x) => x.id_rubro === rub.parrilla);
            expect(apagado.estado).toBe('I');
            expect(apagado.categorias).toBe(1);
        } finally {
            await rubroService.actualizar({ idRubro: rub.parrilla, idNegocio, idUsuario, estado: 'A' });
        }
    });
});

describe('una categoría vive en un solo sector', () => {
    it('marcarla en otro la saca del primero, sin dejar el estado imposible', async () => {
        await rubroService.fijarCategorias({
            idRubro: rub.sushi, idNegocio, idUsuario, idsCategoria: [cat.sushi, cat.parrilla],
        });
        const { rows, categorias } = await rubroService.listarAdmin({ idNegocio });
        expect(categorias.find((c) => c.id_categoria === cat.parrilla).id_rubro).toBe(rub.sushi);
        expect(rows.find((r) => r.id_rubro === rub.parrilla).categorias).toBe(0);

        await rubroService.fijarCategorias({ idRubro: rub.sushi, idNegocio, idUsuario, idsCategoria: [cat.sushi] });
        await rubroService.fijarCategorias({ idRubro: rub.parrilla, idNegocio, idUsuario, idsCategoria: [cat.parrilla] });
    });

    it('la categoría de otro negocio no se puede escribir por la API', async () => {
        const ajena = await unaFila(
            `SELECT id_categoria FROM restaurante.carta_categoria WHERE id_negocio <> :n LIMIT 1;`,
            { n: idNegocio },
        );
        if (!ajena) return;
        await rubroService.fijarCategorias({
            idRubro: rub.parrilla, idNegocio, idUsuario,
            idsCategoria: [cat.parrilla, ajena.id_categoria],
        });
        const fila = await unaFila(
            'SELECT id_rubro FROM restaurante.carta_categoria WHERE id_categoria = :c;',
            { c: ajena.id_categoria },
        );
        expect(fila.id_rubro).not.toBe(rub.parrilla);
    });
});

describe('ventas por día de la semana', () => {
    it('trae los siete días, también los que no vendieron', async () => {
        const r = await reporte('ventas_dia_semana');
        expect(r.rows).toHaveLength(7);
        expect(r.rows.map((x) => x.dia)).toEqual([
            'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo',
        ]);
    });

    it('cuenta cuántas veces cayó cada día en el rango', async () => {
        // Marzo 2019: 4 martes (5, 12, 19, 26) y 5 sábados (2, 9, 16, 23, 30).
        const r = await reporte('ventas_dia_semana');
        expect(r.rows.find((x) => x.dia === 'Martes').dias_en_rango).toBe(4);
        expect(r.rows.find((x) => x.dia === 'Sábado').dias_en_rango).toBe(5);
    });

    it('el promedio por día divide por esas veces, no por los días con venta', async () => {
        const r = await reporte('ventas_dia_semana');
        const martes = r.rows.find((x) => x.dia === 'Martes');
        const sabado = r.rows.find((x) => x.dia === 'Sábado');
        expect(martes.ventas_totales).toBe(63000);
        expect(martes.promedio_por_dia).toBeCloseTo(63000 / 4, 2);
        expect(sabado.ventas_totales).toBe(60000);
        expect(sabado.promedio_por_dia).toBeCloseTo(60000 / 5, 2);
    });

    it('el mejor y el peor día se deciden por el promedio', async () => {
        // Martes 63.000 en 4 oportunidades = 15.750/día · Sábado 60.000 en 5 = 12.000/día.
        // Los otros cinco días no vendieron nada, así que el peor es uno de ellos: lo que se
        // afirma es que el ranking usa el promedio y que mira los siete, no solo los que
        // vendieron.
        const r = await reporte('ventas_dia_semana');
        const kpi = (k) => r.resumen.find((x) => x.key === k)?.value;
        expect(kpi('mejor_dia')).toBe('Martes');
        expect(['Lunes', 'Miércoles', 'Jueves', 'Viernes', 'Domingo']).toContain(kpi('peor_dia'));
        expect(kpi('ventas_totales')).toBe(123000);
    });

    it('no se pagina: los siete días llegan de una vez', async () => {
        const r = await reporte('ventas_dia_semana', { pageSize: 2 });
        expect(r.rows).toHaveLength(7);
        expect(r.pagination.total_pages).toBe(1);
    });
});

describe('ventas por usuario cruzado con productos', () => {
    it('sin productos se comporta como siempre', async () => {
        const r = await reporte('rendimiento_usuarios');
        expect(r.columns.map((c) => c.key)).toContain('ventas_totales');
        expect(r.graficas.modo_producto).toBeUndefined();
    });

    it('con productos cambian las columnas: las cifras ya no son del pedido', async () => {
        const r = await reporte('rendimiento_usuarios', { idsProducto: [prod.churrasco] });
        expect(r.columns.map((c) => c.key)).toEqual(['cajero', 'unidades', 'ordenes', 'ingresos', 'precio_promedio']);
        expect(r.graficas.modo_producto).toBe(true);
    });

    it('la venta es la del producto elegido, no la del pedido completo', async () => {
        const r = await reporte('rendimiento_usuarios', { idsProducto: [prod.gaseosa] });
        const fila = r.rows.find((x) => Number(x.id_usuario) === idUsuario);
        // La gaseosa iba en un pedido de 63.000; aquí tiene que valer sus 10.000.
        expect(fila.ingresos).toBe(10000);
        expect(fila.unidades).toBe(2);
        expect(fila.ordenes).toBe(1);
    });

    it('acepta la selección como lista o como CSV', async () => {
        const lista = await reporte('rendimiento_usuarios', { idsProducto: [prod.churrasco, prod.roll] });
        const csv = await reporte('rendimiento_usuarios', { idsProducto: `${prod.churrasco},${prod.roll}` });
        expect(csv.rows).toEqual(lista.rows);
        expect(csv.filtros.id_productos).toHaveLength(2);
    });

    it('la matriz trae una celda por producto, con los ceros incluidos', async () => {
        const r = await reporte('rendimiento_usuarios', { idsProducto: [prod.churrasco, prod.roll, prod.gaseosa] });
        const m = r.graficas.matriz;
        expect(m.productos).toHaveLength(3);
        const fila = m.filas.find((f) => f.id_usuario === idUsuario);
        expect(fila.celdas).toHaveLength(3);
        const celda = (id) => fila.celdas.find((c) => c.id_producto === id);
        expect(celda(prod.churrasco).unidades).toBe(3);
        expect(celda(prod.roll).unidades).toBe(1);
        expect(celda(prod.gaseosa).unidades).toBe(2);
        expect(fila.unidades).toBe(6);
    });

    it('un producto seleccionado que no vendió nada sale igual, con su columna en cero', async () => {
        const otro = await crearProducto(cat.parrilla, 'TEST Sin ventas', 11000);
        try {
            const r = await reporte('rendimiento_usuarios', { idsProducto: [prod.churrasco, otro] });
            expect(r.graficas.matriz.productos.map((p) => p.id_producto)).toContain(otro);
            const fila = r.graficas.matriz.filas.find((f) => f.id_usuario === idUsuario);
            expect(fila.celdas.find((c) => c.id_producto === otro).unidades).toBe(0);
        } finally {
            await sequelize.query('DELETE FROM restaurante.carta_producto WHERE id_producto = :p;', { replacements: { p: otro } });
        }
    });

    it('el producto de otro negocio no trae datos', async () => {
        const ajeno = await unaFila(
            `SELECT id_producto FROM restaurante.carta_producto WHERE id_negocio <> :n LIMIT 1;`,
            { n: idNegocio },
        );
        if (!ajeno) return;
        const r = await reporte('rendimiento_usuarios', { idsProducto: [ajeno.id_producto] });
        expect(r.rows).toHaveLength(0);
        expect(r.graficas.matriz.productos).toHaveLength(0);
    });

    it('rechaza cruzar más productos de los que tiene sentido mirar', async () => {
        const demasiados = Array.from({ length: reporteService.MAX_PRODUCTOS_FILTRO + 1 }, (_, i) => i + 1);
        await expect(reporte('rendimiento_usuarios', { idsProducto: demasiados }))
            .rejects.toMatchObject({ code: 'DEMASIADOS_PRODUCTOS', statusCode: 422 });
    });
});

describe('el catálogo del selector', () => {
    it('trae cada producto con su categoría y su sector', async () => {
        const c = await reporteService.getCatalogoProductos({ idUsuario, idNegocio });
        const churrasco = c.rows.find((p) => p.id_producto === prod.churrasco);
        expect(churrasco.categoria).toBe('TEST Parrilla');
        expect(churrasco.rubro).toBe('TEST Parrilla');
        // La bebida no tiene sector: el selector lo enseña como está, sin inventarle uno.
        expect(c.rows.find((p) => p.id_producto === prod.gaseosa).rubro).toBeNull();
        expect(c.max_seleccion).toBe(reporteService.MAX_PRODUCTOS_FILTRO);
    });
});

describe('escribir sectores exige permiso', () => {
    it('un usuario sin `caja_gestionar` no puede crear uno', async () => {
        const cajero = await unaFila(
            `SELECT gu.id_usuario FROM general.gener_usuario_rol ur
               JOIN general.gener_usuario gu ON gu.id_usuario = ur.id_usuario
               JOIN general.gener_rol gr ON gr.id_rol = ur.id_rol
              WHERE ur.id_negocio = :n AND ur.estado = 'A'
                AND gr.descripcion NOT ILIKE '%ADMINISTRADOR%'
              ORDER BY gu.id_usuario LIMIT 1;`,
            { n: idNegocio },
        );
        if (!cajero) return;
        await expect(rubroService.crear({ idNegocio, idUsuario: cajero.id_usuario, nombre: 'TEST Colado' }))
            .rejects.toMatchObject({ code: 'SIN_PERMISO_RUBROS', statusCode: 403 });
    });

    it('leerlos no exige nada: los informes y el cierre de caja los necesitan', async () => {
        const activos = await rubroService.listarActivos(idNegocio);
        expect(activos.map((r) => r.nombre)).toEqual(expect.arrayContaining(['TEST Parrilla', 'TEST Sushi']));
    });

    it('dos sectores no pueden llamarse igual, ni cambiando mayúsculas', async () => {
        await expect(rubroService.crear({ idNegocio, idUsuario, nombre: 'test parrilla' }))
            .rejects.toMatchObject({ code: 'RUBRO_DUPLICADO', statusCode: 409 });
    });
});

describe('el corte por sector de un turno de caja', () => {
    it('es `null` mientras el negocio no tenga sectores', async () => {
        const sinRubros = await unaFila(
            `SELECT c.id_caja, c.id_negocio FROM restaurante.rest_caja c
              WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_rubro r
                                 WHERE r.id_negocio = c.id_negocio AND r.estado = 'A')
              LIMIT 1;`,
        );
        if (!sinRubros) return;
        expect(await cajaService.getDesglosePorRubro(sinRubros.id_caja, sinRubros.id_negocio)).toBeNull();
    });

    it('se mide sobre los movimientos del turno, no sobre `pedid_orden.id_caja`', async () => {
        // Un pedido estampado con el turno pero SIN movimiento no es plata que entró: si se
        // contara, el panel enseñaría una venta por sector mayor que el cajón. Pasó con datos
        // cargados en bloque en la base de desarrollo.
        const turno = await unaFila(
            `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n ORDER BY id_caja DESC LIMIT 1;`,
            { n: idNegocio },
        );
        if (!turno) return;

        const antes = await cajaService.getDesglosePorRubro(turno.id_caja, idNegocio);
        await sequelize.query(
            'UPDATE restaurante.pedid_orden SET id_caja = :c WHERE id_orden = :o;',
            { replacements: { c: turno.id_caja, o: ordenes[0] } },
        );
        try {
            const despues = await cajaService.getDesglosePorRubro(turno.id_caja, idNegocio);
            expect(despues.total_pedidos).toBe(antes.total_pedidos);
            expect(despues.ordenes).toBe(antes.ordenes);
        } finally {
            await sequelize.query(
                'UPDATE restaurante.pedid_orden SET id_caja = NULL WHERE id_orden = :o;',
                { replacements: { o: ordenes[0] } },
            );
        }
    });
});
