/**
 * Ingredientes quitados desde la carta: `tomar_pedido` y la carta pública, 2026-09-24.
 *
 * Contra la base de verdad. Lo que se sostiene:
 *  - solo se guarda un id que sea REMOVIBLE de ESE producto en ESE negocio;
 *  - la confirmación enseña solo lo válido y dice lo que no pudo quitar;
 *  - `ejecutar` es estricto: si lo confirmado dejó de valer, `EXCLUSION_INVALIDA` y nada a medias;
 *  - lo quitado no descuenta inventario (con control de inventario encendido);
 *  - la carta pública lleva SOLO {id_ingrediente, nombre} de los removibles activos.
 *
 * Necesita `scripts/fixtures/dev_carta_restaurante.sql`.
 */
'use strict';

require('dotenv').config();
process.env.FEATURES_FORZADAS = 'asistente_ia';

const { asegurarCajaPrincipal } = require('../../app_core/helpers/cajaPrincipal');
const Models = require('../../app_core/models/conection');
const { resolverPrincipalUsuario } = require('../../app_core/authz/principal');
const { principalDeContacto } = require('../../intelligence/engine/identidad');
const intelligence = require('../../intelligence');
const policyGate = require('../../intelligence/core/policyGate');
const registry = require('../../intelligence/core/registry');
const CartaService = require('../../app_restaurante_api/services/cartaService');

const sequelize = Models.sequelize;
const TEL = '+573005550202';

let idNegocio;
let idRival;
let principalAdmin;
let idCategoria;
let idProducto;
let idProductoOtro;
let ing = {}; // nombre → id
let controlOriginal;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

const contacto = () => principalDeContacto(idNegocio, { telefonoVerificado: TEL });

const pedir = (items, extra = {}) =>
    policyGate.ejecutar({
        capacidad: 'tomar_pedido',
        principal: contacto(),
        idNegocio,
        args: {
            items,
            cliente_nombre: 'BOT Exclu',
            tipo_entrega: 'LLEVAR',
            ...extra,
        },
        confirmadoPor: { origen: 'test', texto: 'sí' },
    });

const preguntar = (items, extra = {}) =>
    registry.obtener('tomar_pedido').confirmacion.pregunta({
        idNegocio,
        args: { items, cliente_nombre: 'Ana', tipo_entrega: 'LLEVAR', ...extra },
    });

async function exclusionesDe(numeroOrden) {
    const filas = await sequelize.query(
        `SELECT d.id_detalle, d.id_producto, d.cantidad, x.id_ingrediente
           FROM restaurante.pedid_orden o
           JOIN restaurante.pedid_detalle d ON d.id_orden = o.id_orden
      LEFT JOIN restaurante.pedid_detalle_exclu x ON x.id_detalle = d.id_detalle
          WHERE o.id_negocio = :n AND o.numero_orden = :num ORDER BY d.id_detalle;`,
        { replacements: { n: idNegocio, num: numeroOrden }, type: sequelize.QueryTypes.SELECT }
    );
    return filas;
}

async function abrirCaja() {
    await asegurarCajaPrincipal(idNegocio);
    await sequelize.query(
        `INSERT INTO restaurante.rest_caja (id_negocio, id_punto_caja, id_usuario, monto_apertura, estado, fecha_apertura)
         SELECT :n, (SELECT id_punto_caja FROM restaurante.rest_punto_caja
                      WHERE id_negocio = :n AND estado = 'A' ORDER BY orden LIMIT 1), :u, 0, 'A', now()
          WHERE NOT EXISTS (SELECT 1 FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A');`,
        { replacements: { n: idNegocio, u: principalAdmin.id_usuario } }
    );
}

async function nuevoIngrediente(nombre, { negocio = idNegocio, estado = 'A', stock = 1000 } = {}) {
    return (await unaFila(
        `INSERT INTO restaurante.carta_ingrediente (id_negocio, nombre, stock_actual, estado)
         VALUES (:n, :nom, :s, :e) RETURNING id_ingrediente;`,
        { n: negocio, nom: nombre, s: stock, e: estado }
    )).id_ingrediente;
}

async function enReceta(producto, ingrediente, { removible = true, porcion = 10, estado = 'A' } = {}) {
    await sequelize.query(
        `INSERT INTO restaurante.carta_producto_ingred (id_producto, id_ingrediente, porcion, es_removible, estado)
         VALUES (:p, :i, :por, :r, :e);`,
        { replacements: { p: producto, i: ingrediente, por: porcion, r: removible, e: estado } }
    );
}

const stockDe = async (id) =>
    Number((await unaFila(`SELECT stock_actual FROM restaurante.carta_ingrediente WHERE id_ingrediente = :i;`, { i: id })).stock_actual);

beforeAll(async () => {
    intelligence.arrancar();
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idRival = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Rival';`)).id_negocio;
    controlOriginal = (await unaFila(
        `SELECT controla_inventario AS c FROM general.gener_negocio WHERE id_negocio = :n;`, { n: idNegocio }
    )).c;
    principalAdmin = await resolverPrincipalUsuario(
        (await unaFila(`SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = '1000000002';`)).id_usuario
    );
    await sequelize.query(
        `INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada)
         VALUES (:n, 'tomar_pedido', true)
         ON CONFLICT (id_negocio, capacidad) DO UPDATE SET habilitada = true;`,
        { replacements: { n: idNegocio } }
    );

    // Un producto propio con receta: cebolla (removible), tomate (removible), pan (NO removible),
    // sal (removible pero receta desactivada) y un ingrediente de OTRO negocio.
    idCategoria = (await unaFila(
        `INSERT INTO restaurante.carta_categoria (id_negocio, nombre, estado, visible) VALUES (:n, 'TEST-Exclu', 'A', true)
         RETURNING id_categoria;`, { n: idNegocio }
    )).id_categoria;
    const producto = async (nombre) => (await unaFila(
        `INSERT INTO restaurante.carta_producto (id_negocio, id_categoria, nombre, precio, estado, disponible, visible)
         VALUES (:n, :c, :nom, 15000, 'A', true, true) RETURNING id_producto;`,
        { n: idNegocio, c: idCategoria, nom: nombre }
    )).id_producto;
    idProducto = await producto('TEST-Hamburguesa');
    idProductoOtro = await producto('TEST-Perro');

    ing.cebolla = await nuevoIngrediente('TEST-cebolla');
    ing.tomate = await nuevoIngrediente('TEST-tomate');
    ing.pan = await nuevoIngrediente('TEST-pan');
    ing.sal = await nuevoIngrediente('TEST-sal');
    ing.inactivo = await nuevoIngrediente('TEST-inactivo', { estado: 'I' });
    ing.ajeno = await nuevoIngrediente('TEST-ajeno', { negocio: idRival });
    ing.deOtroProducto = await nuevoIngrediente('TEST-salsa');

    await enReceta(idProducto, ing.cebolla);
    await enReceta(idProducto, ing.tomate);
    await enReceta(idProducto, ing.pan, { removible: false });
    await enReceta(idProducto, ing.sal, { estado: 'I' });
    await enReceta(idProducto, ing.inactivo);
    await enReceta(idProducto, ing.ajeno);
    await enReceta(idProductoOtro, ing.deOtroProducto);
});

afterAll(async () => {
    const ordenes = `SELECT id_orden FROM restaurante.pedid_orden WHERE id_negocio = :n AND contacto_nombre = 'BOT Exclu'`;
    await sequelize.query(
        `DELETE FROM restaurante.pedid_detalle_exclu WHERE id_detalle IN (
            SELECT id_detalle FROM restaurante.pedid_detalle WHERE id_orden IN (${ordenes}));`,
        { replacements: { n: idNegocio } }
    );
    await sequelize.query(`DELETE FROM restaurante.pedid_detalle WHERE id_orden IN (${ordenes});`, { replacements: { n: idNegocio } });
    await sequelize.query(`DELETE FROM restaurante.pedid_orden WHERE id_negocio = :n AND contacto_nombre = 'BOT Exclu';`, { replacements: { n: idNegocio } });
    await sequelize.query(`DELETE FROM restaurante.carta_producto_ingred WHERE id_producto IN (:p);`, { replacements: { p: [idProducto, idProductoOtro] } });
    await sequelize.query(`DELETE FROM restaurante.carta_producto WHERE id_categoria = :c;`, { replacements: { c: idCategoria } });
    await sequelize.query(`DELETE FROM restaurante.carta_categoria WHERE id_categoria = :c;`, { replacements: { c: idCategoria } });
    await sequelize.query(`DELETE FROM restaurante.carta_ingrediente WHERE nombre LIKE 'TEST-%';`);
    await sequelize.query(
        `UPDATE general.gener_negocio SET controla_inventario = :c WHERE id_negocio = :n;`,
        { replacements: { c: controlOriginal, n: idNegocio } }
    );
    await sequelize.query(`UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_negocio = :n AND estado = 'A';`, { replacements: { n: idNegocio } });
    intelligence._reiniciar();
    await sequelize.close();
});

beforeEach(abrirCaja);

const linea = (sin, cantidad = 1) => ({ id_producto: idProducto, cantidad, ...(sin ? { sin } : {}) });

describe('tomar_pedido con ingredientes quitados', () => {
    it('guarda las exclusiones válidas (removibles de ese producto) en pedid_detalle_exclu', async () => {
        const { resultado } = await pedir([linea(`${ing.cebolla}.${ing.tomate}`)]);
        const filas = await exclusionesDe(resultado.numero_orden);
        expect(filas.map((f) => f.id_ingrediente).sort()).toEqual([ing.cebolla, ing.tomate].sort());
    });

    it('dos líneas del mismo producto con distintas exclusiones son dos detalles', async () => {
        const { resultado } = await pedir([linea(String(ing.cebolla)), linea(null)]);
        const filas = await exclusionesDe(resultado.numero_orden);
        const detalles = new Set(filas.map((f) => f.id_detalle));
        expect(detalles.size).toBe(2);
        expect(filas.filter((f) => f.id_ingrediente !== null)).toHaveLength(1);
    });

    it.each([
        ['un ingrediente NO removible', () => ing.pan],
        ['un ingrediente de la receta pero con la receta desactivada', () => ing.sal],
        ['un ingrediente desactivado', () => ing.inactivo],
        ['un ingrediente de OTRO negocio', () => ing.ajeno],
        ['un ingrediente que es de OTRO producto', () => ing.deOtroProducto],
        ['un id que no existe', () => 987654321],
    ])('rechaza con EXCLUSION_INVALIDA %s y NO crea nada', async (_, id) => {
        const antes = await unaFila(`SELECT count(*)::int AS n FROM restaurante.pedid_orden WHERE id_negocio = :n;`, { n: idNegocio });
        await expect(pedir([linea(String(id()))])).rejects.toMatchObject({
            code: 'EXCLUSION_INVALIDA', statusCode: 400,
        });
        const despues = await unaFila(`SELECT count(*)::int AS n FROM restaurante.pedid_orden WHERE id_negocio = :n;`, { n: idNegocio });
        expect(despues.n).toBe(antes.n);
    });

    it('una mezcla válida + inválida se rechaza entera: nunca se guarda a medias', async () => {
        await expect(pedir([linea(`${ing.cebolla}.${ing.pan}`)])).rejects.toMatchObject({ code: 'EXCLUSION_INVALIDA' });
    });

    it('con control de inventario, lo quitado NO descuenta stock', async () => {
        await sequelize.query(`UPDATE general.gener_negocio SET controla_inventario = true WHERE id_negocio = :n;`, { replacements: { n: idNegocio } });
        const [c0, t0, p0] = [await stockDe(ing.cebolla), await stockDe(ing.tomate), await stockDe(ing.pan)];

        await pedir([linea(String(ing.cebolla), 2)]);

        expect(await stockDe(ing.cebolla)).toBe(c0); // quitada: no se descuenta
        expect(await stockDe(ing.tomate)).toBe(t0 - 20); // el resto de la receta sí (2 × 10)
        expect(await stockDe(ing.pan)).toBe(p0 - 20);
    });
});

describe('la confirmación', () => {
    it('enseña solo las exclusiones válidas: «(sin cebolla, sin tomate)»', async () => {
        const texto = await preguntar([linea(`${ing.cebolla}.${ing.tomate}`)]);
        expect(texto).toContain('1 × TEST-Hamburguesa (sin TEST-cebolla, sin TEST-tomate)');
        expect(texto).not.toContain('no pudimos quitar');
    });

    it('descarta las inválidas y lo dice ANTES del «sí»: «(no pudimos quitar: X)»', async () => {
        const texto = await preguntar([linea(`${ing.cebolla}.${ing.pan}.${ing.inactivo}`)]);
        expect(texto).toContain('(sin TEST-cebolla)');
        expect(texto).not.toContain('sin TEST-pan');
        expect(texto).toContain('(no pudimos quitar:');
        expect(texto).toContain('TEST-pan');
    });

    it('suma lo que el flujo ya descartó al leer el código (`sin_descartadas`)', async () => {
        const texto = await preguntar([linea(String(ing.cebolla))], { sin_descartadas: 'lechuga' });
        expect(texto).toContain('no pudimos quitar: lechuga');
    });

    it('sin exclusiones el texto es el de siempre', async () => {
        const texto = await preguntar([linea(null)]);
        expect(texto).toContain('1 × TEST-Hamburguesa — ');
        expect(texto).not.toContain('sin ');
    });
});

describe('carta pública: ingredientes_removibles', () => {
    it('lleva SOLO {id_ingrediente, nombre} de los removibles activos de ese producto', async () => {
        const categorias = await CartaService.getCartaPublicaCompleta(idNegocio);
        const cat = categorias.find((c) => c.id_categoria === idCategoria);
        const hamburguesa = cat.productos.find((p) => p.id_producto === idProducto);

        expect(hamburguesa.removibles.map((r) => r.nombre).sort()).toEqual(['TEST-cebolla', 'TEST-tomate']);
        for (const r of hamburguesa.removibles) {
            expect(Object.keys(r).sort()).toEqual(['id_ingrediente', 'nombre']);
        }
    });

    it('no deja pasar el no removible, el de receta inactiva, el inactivo ni el de otro negocio', async () => {
        const categorias = await CartaService.getCartaPublicaCompleta(idNegocio);
        const hamburguesa = categorias.flatMap((c) => c.productos).find((p) => p.id_producto === idProducto);
        const nombres = hamburguesa.removibles.map((r) => r.nombre);

        for (const fuera of ['TEST-pan', 'TEST-sal', 'TEST-inactivo', 'TEST-ajeno', 'TEST-salsa']) {
            expect(nombres).not.toContain(fuera);
        }
    });

    it('un producto sin removibles trae lista vacía', async () => {
        const categorias = await CartaService.getCartaPublicaCompleta(idNegocio);
        const otros = categorias.flatMap((c) => c.productos).filter((p) => p.id_producto !== idProducto);
        for (const p of otros) expect(Array.isArray(p.removibles)).toBe(true);
    });
});
