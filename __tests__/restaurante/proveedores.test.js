/**
 * Proveedores de insumos: privacidad entre negocios, entrada al inventario y comparador.
 *
 * De todo lo que hace el módulo, lo que esta suite protege es lo que **no se puede romper
 * nunca**, en este orden:
 *
 *  1. **Un negocio no ve lo privado de otro.** Un proveedor en PRIVADO no existe para los
 *     demás; uno publicado enseña contacto pero nunca la razón social, el NIT, quién lo
 *     registró, las notas, las compras ni los precios no publicados. El filtro es una lista
 *     BLANCA en `proyectar()`: si alguien añade una columna a `rest_proveedor` y se le olvida
 *     tratarla, estos asserts siguen pasando — que es justo lo que se quiere.
 *  2. **La compra mueve el inventario con exactitud.** Lo que suma un renglón se guarda en
 *     `stock_sumado`, y anular devuelve eso mismo, ni más ni menos.
 *  3. **El comparador no miente.** Normaliza por unidad base y, cuando no puede (kilos contra
 *     cajas), NO señala un ganador y lo marca.
 *
 * Corre contra la base de verdad, como el resto de suites. Todo lo que crea lleva prefijo
 * `TEST-PRV` y se borra en el `afterAll`, incluso si un test falla.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const Prov = require('../../app_restaurante_api/services/proveedorService');
const Compras = require('../../app_restaurante_api/services/compraService');

const sequelize = Models.sequelize;

/** Dos negocios de tipo RESTAURANTE con un administrador cada uno, y un insumo del primero. */
let A = null;   // { negocio, usuario }
let B = null;
let idIngrediente = null;
let stockOriginal = 0;

const proveedoresCreados = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

/** Un negocio de restaurante con administrador, distinto de los ya elegidos. */
async function negocioConAdmin(excluir = []) {
    return unaFila(`
        SELECT n.id_negocio, ur.id_usuario
          FROM general.gener_negocio n
          JOIN general.gener_usuario_rol ur
            ON ur.id_negocio = n.id_negocio AND ur.estado = 'A'
          JOIN general.gener_rol r
            ON r.id_rol = ur.id_rol AND UPPER(r.descripcion) = 'ADMINISTRADOR'
          JOIN general.gener_tipo_negocio t
            ON t.id_tipo_negocio = n.id_tipo_negocio AND UPPER(t.nombre) LIKE '%RESTAURANTE%'
         WHERE n.estado = 'A'
           ${excluir.length ? 'AND n.id_negocio NOT IN (:excluir)' : ''}
         ORDER BY n.id_negocio
         LIMIT 1;
    `, excluir.length ? { excluir } : {});
}

beforeAll(async () => {
    A = await negocioConAdmin();
    if (A) B = await negocioConAdmin([A.id_negocio]);

    if (A) {
        const ing = await unaFila(`
            SELECT id_ingrediente, stock_actual
              FROM restaurante.carta_ingrediente
             WHERE id_negocio = :n AND estado = 'A' AND lower(unidad_medida) IN ('g','gr','gramo','gramos')
             ORDER BY id_ingrediente
             LIMIT 1;
        `, { n: A.id_negocio });
        if (ing) {
            idIngrediente = Number(ing.id_ingrediente);
            stockOriginal = Number(ing.stock_actual);
        }
    }
});

afterAll(async () => {
    // Se borra en orden de dependencia. Va dentro de try/catch: si un test dejó a medias algo
    // inesperado, la limpieza de lo demás no se puede quedar colgada por ello.
    try {
        if (proveedoresCreados.length) {
            const r = { ids: proveedoresCreados };
            await sequelize.query(`
                DELETE FROM restaurante.rest_proveedor_precio
                 WHERE id_proveedor_insumo IN (
                     SELECT id_proveedor_insumo FROM restaurante.rest_proveedor_insumo
                      WHERE id_proveedor IN (:ids))
                    OR id_compra IN (
                     SELECT id_compra FROM restaurante.rest_compra WHERE id_proveedor IN (:ids));
            `, { replacements: r });
            await sequelize.query(
                'DELETE FROM restaurante.rest_compra WHERE id_proveedor IN (:ids);', { replacements: r },
            );
            await sequelize.query(
                'DELETE FROM restaurante.rest_proveedor WHERE id_proveedor IN (:ids);', { replacements: r },
            );
        }
        if (idIngrediente !== null) {
            await sequelize.query(
                'UPDATE restaurante.carta_ingrediente SET stock_actual = :s WHERE id_ingrediente = :i;',
                { replacements: { s: stockOriginal, i: idIngrediente } },
            );
        }
    } catch (err) {
        console.error('[proveedores.test] limpieza:', err.message);
    }
    await sequelize.close();
});

// ============================================================
// Catálogo
// ============================================================

describe('Catálogo de categorías', () => {
    test('son del sistema y están sembradas', async () => {
        const cats = await Prov.listarCategorias();
        expect(cats.length).toBeGreaterThanOrEqual(15);
        expect(cats.map((c) => c.codigo)).toEqual(
            expect.arrayContaining(['carnes', 'abarrotes', 'bebidas', 'otros']),
        );
    });
});

// ============================================================
// Privacidad entre negocios — lo que no se puede romper nunca
// ============================================================

describe('Privacidad entre negocios', () => {
    let privado = null;
    let publicado = null;

    test('se crea un proveedor y nace privado y vinculado a quien lo creó', async () => {
        if (!A) return console.warn('Sin restaurante con administrador: se omite.');

        privado = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio,
            nombre_comercial: `TEST-PRV privado ${Date.now()}`,
            telefono: '3001112233',
            ciudad: 'Cali',
            categorias: ['carnes'],
        });
        proveedoresCreados.push(privado.id_proveedor);

        expect(privado.visibilidad).toBe('PRIVADO');
        expect(privado.es_propio).toBe(true);
        expect(privado.es_propietario).toBe(true);
    });

    test('dos fichas con el mismo nombre en el mismo negocio no se permiten', async () => {
        if (!A || !privado) return;
        await expect(
            Prov.crear(A.id_usuario, {
                id_negocio: A.id_negocio,
                nombre_comercial: privado.nombre_comercial.toUpperCase(),
            }),
        ).rejects.toMatchObject({ code: 'PROVEEDOR_DUPLICADO', statusCode: 409 });
    });

    test('un proveedor PRIVADO no existe para otro negocio', async () => {
        if (!A || !B || !privado) return console.warn('Hacen falta dos restaurantes: se omite.');

        // 404 y no 403: un 403 confirmaría que ese id está ocupado, que ya es contar de más.
        await expect(Prov.detalle(B.id_usuario, privado.id_proveedor, B.id_negocio))
            .rejects.toMatchObject({ code: 'PROVEEDOR_NO_ENCONTRADO', statusCode: 404 });

        const directorio = await Prov.listar(B.id_usuario, {
            idNegocio: B.id_negocio, ambito: 'directorio',
        });
        expect(directorio.items.some((p) => p.id_proveedor === privado.id_proveedor)).toBe(false);
    });

    test('publicado enseña el contacto pero nunca lo privado ni quién lo registró', async () => {
        if (!A || !B) return;

        publicado = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio,
            nombre_comercial: `TEST-PRV publicado ${Date.now()}`,
            telefono: '3009998877',
            email: 'ventas@test-prv.co',
            nombre_legal: 'TEST-PRV Distribuciones SAS',
            identificacion: '900123456-7',
            ciudad: 'Bogotá',
            observaciones: 'Entrega en 24 horas',
            pedido_minimo: 100000,
            categorias: ['abarrotes'],
            visibilidad: 'DIRECTORIO',
        });
        proveedoresCreados.push(publicado.id_proveedor);

        await Prov.guardarPrivado(A.id_usuario, publicado.id_proveedor, {
            id_negocio: A.id_negocio, notas: 'Pide pago anticipado', calificacion: 4,
        });

        const vistaAjena = await Prov.detalle(B.id_usuario, publicado.id_proveedor, B.id_negocio);

        // Lo que SÍ sale: es para lo que sirve un directorio.
        expect(vistaAjena.telefono).toBe('3009998877');
        expect(vistaAjena.observaciones).toBe('Entrega en 24 horas');
        expect(vistaAjena.nivel_acceso).toBe('completo');
        expect(vistaAjena.es_propio).toBe(false);

        // Lo que NO sale, uno a uno. `toBeUndefined` y no `toBeNull`: la propiedad no se
        // proyecta siquiera, que es distinto de proyectarla vacía.
        expect(vistaAjena.nombre_legal).toBeUndefined();
        expect(vistaAjena.identificacion).toBeUndefined();
        expect(vistaAjena.notas).toBeUndefined();
        expect(vistaAjena.calificacion).toBeUndefined();
        expect(vistaAjena.visibilidad).toBeUndefined();
        expect(vistaAjena).not.toHaveProperty('id_negocio_origen');
    });

    test('DIRECTORIO_BASICO recorta las condiciones comerciales', async () => {
        if (!A || !B || !publicado) return;

        await Prov.cambiarVisibilidad(A.id_usuario, publicado.id_proveedor, {
            id_negocio: A.id_negocio, visibilidad: 'DIRECTORIO_BASICO',
        });

        const basica = await Prov.detalle(B.id_usuario, publicado.id_proveedor, B.id_negocio);
        expect(basica.nivel_acceso).toBe('basico');
        expect(basica.observaciones).toBeUndefined();
        expect(basica.pedido_minimo).toBeUndefined();
        // El contacto se conserva en todos los niveles: sin él, el directorio no sirve de nada.
        expect(basica.telefono).toBe('3009998877');

        await Prov.cambiarVisibilidad(A.id_usuario, publicado.id_proveedor, {
            id_negocio: A.id_negocio, visibilidad: 'DIRECTORIO',
        });
    });

    test('solo el negocio que publicó la ficha puede editarla', async () => {
        if (!A || !B || !publicado) return;

        await Prov.vincular(B.id_usuario, publicado.id_proveedor, { id_negocio: B.id_negocio });
        const trasVincular = await Prov.detalle(B.id_usuario, publicado.id_proveedor, B.id_negocio);

        expect(trasVincular.es_propio).toBe(true);        // ya está en su lista…
        expect(trasVincular.es_propietario).toBe(false);  // …pero la ficha no es suya

        await expect(
            Prov.editar(B.id_usuario, publicado.id_proveedor, {
                id_negocio: B.id_negocio, nombre_comercial: 'SECUESTRADO',
            }),
        ).rejects.toMatchObject({ code: 'PROVEEDOR_AJENO', statusCode: 403 });
    });

    test('archivar es de un solo negocio y no toca a los demás', async () => {
        if (!A || !B || !publicado) return;

        await Prov.archivar(B.id_usuario, publicado.id_proveedor, {
            id_negocio: B.id_negocio, archivado: true,
        });

        const listaB = await Prov.listar(B.id_usuario, { idNegocio: B.id_negocio, ambito: 'mios' });
        expect(listaB.items.some((p) => p.id_proveedor === publicado.id_proveedor)).toBe(false);

        const listaA = await Prov.listar(A.id_usuario, { idNegocio: A.id_negocio, ambito: 'mios' });
        expect(listaA.items.some((p) => p.id_proveedor === publicado.id_proveedor)).toBe(true);
    });

    test('los insumos privados no se publican y los públicos sí', async () => {
        if (!A || !B || !publicado) return;

        await Prov.crearInsumo(A.id_usuario, publicado.id_proveedor, {
            id_negocio: A.id_negocio, nombre: 'TEST-PRV arroz', unidad: 'KG',
            cantidad_presentacion: 50, precio: 195000, publico: true,
        });
        await Prov.crearInsumo(A.id_usuario, publicado.id_proveedor, {
            id_negocio: A.id_negocio, nombre: 'TEST-PRV azúcar', unidad: 'KG',
            cantidad_presentacion: 25, precio: 90000, publico: false,
        });

        const vistosPorB = await Prov.listarInsumos(B.id_usuario, publicado.id_proveedor, B.id_negocio);
        expect(vistosPorB).toHaveLength(1);
        expect(vistosPorB[0].nombre).toBe('TEST-PRV arroz');
        expect(vistosPorB[0].es_propio).toBe(false);

        const vistosPorA = await Prov.listarInsumos(A.id_usuario, publicado.id_proveedor, A.id_negocio);
        expect(vistosPorA).toHaveLength(2);
    });

    test('el histórico de precios de un negocio no lo lee otro', async () => {
        if (!A || !B || !publicado) return;

        const mios = await Prov.listarInsumos(A.id_usuario, publicado.id_proveedor, A.id_negocio);
        const arroz = mios.find((i) => i.nombre === 'TEST-PRV arroz');

        // Cambiar el precio deja un punto nuevo; el alta dejó el primero.
        await Prov.editarInsumo(A.id_usuario, arroz.id_proveedor_insumo, {
            id_negocio: A.id_negocio, nombre: 'TEST-PRV arroz', unidad: 'KG',
            cantidad_presentacion: 50, precio: 210000, publico: true,
        });

        const hist = await Prov.historicoPrecios(A.id_usuario, arroz.id_proveedor_insumo, A.id_negocio);
        expect(hist.length).toBeGreaterThanOrEqual(2);
        expect(hist[0].precio).toBe(210000);

        await expect(
            Prov.historicoPrecios(B.id_usuario, arroz.id_proveedor_insumo, B.id_negocio),
        ).rejects.toMatchObject({ code: 'INSUMO_NO_ENCONTRADO' });
    });
});

// ============================================================
// Compras e inventario
// ============================================================

describe('Compras y entrada al inventario', () => {
    let proveedor = null;
    let insumo = null;

    beforeAll(async () => {
        if (!A) return;
        proveedor = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio,
            nombre_comercial: `TEST-PRV compras ${Date.now()}`,
            categorias: ['abarrotes'],
        });
        proveedoresCreados.push(proveedor.id_proveedor);

        insumo = await Prov.crearInsumo(A.id_usuario, proveedor.id_proveedor, {
            id_negocio: A.id_negocio,
            nombre: 'TEST-PRV insumo de compra',
            unidad: 'KG',
            cantidad_presentacion: 50,   // un bulto trae 50 kg
            precio: 180000,
            id_ingrediente: idIngrediente,
        });
    });

    test('un renglón enlazado suma stock, convertido a la unidad del inventario', async () => {
        if (!A || idIngrediente === null) {
            return console.warn('El negocio no tiene insumos en gramos: se omite.');
        }

        const antes = Number((await Models.CartaIngrediente.findByPk(idIngrediente)).stock_actual);

        const compra = await Compras.crear(A.id_usuario, {
            id_negocio: A.id_negocio,
            id_proveedor: proveedor.id_proveedor,
            referencia: 'TEST-PRV-F1',
            detalles: [{
                id_proveedor_insumo: insumo.id_proveedor_insumo,
                cantidad: 2,                 // 2 bultos
                precio_unitario: 180000,
                id_ingrediente: idIngrediente,
            }],
        });

        expect(compra.total).toBe(360000);

        // 2 bultos × 50 kg = 100 kg = 100.000 g
        const despues = Number((await Models.CartaIngrediente.findByPk(idIngrediente)).stock_actual);
        expect(despues).toBe(antes + 100000);
        expect(compra.detalles[0].stock_sumado).toBe(100000);

        // Y anular devuelve EXACTAMENTE lo que sumó, no un recálculo.
        await Compras.anular(A.id_usuario, compra.id_compra, {
            id_negocio: A.id_negocio, motivo: 'TEST-PRV',
        });
        const revertido = Number((await Models.CartaIngrediente.findByPk(idIngrediente)).stock_actual);
        expect(revertido).toBe(antes);

        await expect(
            Compras.anular(A.id_usuario, compra.id_compra, { id_negocio: A.id_negocio }),
        ).rejects.toMatchObject({ code: 'COMPRA_YA_ANULADA', statusCode: 409 });
    });

    test('una unidad que no se puede convertir avisa y deja el stock quieto', async () => {
        if (!A || idIngrediente === null) return;

        const enCajas = await Prov.crearInsumo(A.id_usuario, proveedor.id_proveedor, {
            id_negocio: A.id_negocio, nombre: 'TEST-PRV en cajas', unidad: 'CAJA',
            cantidad_presentacion: 12, precio: 36000,
        });

        const antes = Number((await Models.CartaIngrediente.findByPk(idIngrediente)).stock_actual);

        const compra = await Compras.crear(A.id_usuario, {
            id_negocio: A.id_negocio,
            id_proveedor: proveedor.id_proveedor,
            detalles: [{
                id_proveedor_insumo: enCajas.id_proveedor_insumo,
                cantidad: 3, precio_unitario: 36000, unidad: 'CAJA',
                id_ingrediente: idIngrediente,
            }],
        });

        // La compra se registra igual (es gasto real), pero NO inventa un stock en gramos.
        expect(compra.avisos).toHaveLength(1);
        expect(compra.avisos[0].motivo).toBe('UNIDAD_NO_CONVERTIBLE');
        expect(Number((await Models.CartaIngrediente.findByPk(idIngrediente)).stock_actual)).toBe(antes);
    });

    test('solo se le compra a un proveedor que esté en la lista', async () => {
        if (!A || !B) return;

        const ajeno = await Prov.crear(B.id_usuario, {
            id_negocio: B.id_negocio,
            nombre_comercial: `TEST-PRV ajeno ${Date.now()}`,
            visibilidad: 'DIRECTORIO',
        });
        proveedoresCreados.push(ajeno.id_proveedor);

        await expect(Compras.crear(A.id_usuario, {
            id_negocio: A.id_negocio,
            id_proveedor: ajeno.id_proveedor,
            detalles: [{ descripcion: 'algo', cantidad: 1, precio_unitario: 1000 }],
        })).rejects.toMatchObject({ code: 'SIN_VINCULO', statusCode: 409 });
    });

    test('el historial y el gasto de un negocio no los ve el otro', async () => {
        if (!A || !B) return;

        const deA = await Compras.listar(A.id_usuario, {
            idNegocio: A.id_negocio, busqueda: 'TEST-PRV', incluirAnuladas: true,
        });
        expect(deA.items.length).toBeGreaterThan(0);

        const deB = await Compras.listar(B.id_usuario, {
            idNegocio: B.id_negocio, busqueda: 'TEST-PRV', incluirAnuladas: true,
        });
        const idsA = new Set(deA.items.map((c) => c.id_compra));
        expect(deB.items.some((c) => idsA.has(c.id_compra))).toBe(false);
    });
});

// ============================================================
// Comparador
// ============================================================

describe('Comparador de precios', () => {
    test('normaliza por unidad base y señala el más barato de verdad', async () => {
        if (!A) return;

        const uno = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio, nombre_comercial: `TEST-PRV comp uno ${Date.now()}`,
        });
        const dos = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio, nombre_comercial: `TEST-PRV comp dos ${Date.now()}`,
        });
        proveedoresCreados.push(uno.id_proveedor, dos.id_proveedor);

        const nombre = `TEST-PRV harina ${Date.now()}`;
        // 100.000 / 50 kg = 2.000 $/kg  ← el barato, aunque su etiqueta sea la cara
        await Prov.crearInsumo(A.id_usuario, uno.id_proveedor, {
            id_negocio: A.id_negocio, nombre, unidad: 'KG',
            cantidad_presentacion: 50, precio: 100000,
        });
        // 55.000 / 25 kg = 2.200 $/kg
        await Prov.crearInsumo(A.id_usuario, dos.id_proveedor, {
            id_negocio: A.id_negocio, nombre, unidad: 'KG',
            cantidad_presentacion: 25, precio: 55000,
        });

        const grupos = await Prov.comparar(A.id_usuario, { idNegocio: A.id_negocio, busqueda: nombre });
        expect(grupos).toHaveLength(1);

        const grupo = grupos[0];
        expect(grupo.ofertas).toHaveLength(2);
        expect(grupo.unidades_mixtas).toBe(false);
        expect(grupo.presentaciones_distintas).toBe(true);

        // El ganador NO es el del precio de etiqueta más bajo: es el del precio por kilo.
        const ganador = grupo.ofertas.find((o) => o.id_proveedor_insumo === grupo.id_mas_barato);
        expect(ganador.proveedor).toBe(uno.nombre_comercial);
        expect(ganador.precio_base).toBeCloseTo(2000, 2);
        expect(ganador.estimado).toBe(false);
    });

    test('con unidades que no se pueden reducir a la misma base, NO señala ganador', async () => {
        if (!A) return;

        const uno = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio, nombre_comercial: `TEST-PRV mix uno ${Date.now()}`,
        });
        const dos = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio, nombre_comercial: `TEST-PRV mix dos ${Date.now()}`,
        });
        proveedoresCreados.push(uno.id_proveedor, dos.id_proveedor);

        const nombre = `TEST-PRV gaseosa ${Date.now()}`;
        await Prov.crearInsumo(A.id_usuario, uno.id_proveedor, {
            id_negocio: A.id_negocio, nombre, unidad: 'L', cantidad_presentacion: 1.5, precio: 6000,
        });
        await Prov.crearInsumo(A.id_usuario, dos.id_proveedor, {
            id_negocio: A.id_negocio, nombre, unidad: 'CAJA', cantidad_presentacion: 12, precio: 48000,
        });

        const [grupo] = await Prov.comparar(A.id_usuario, { idNegocio: A.id_negocio, busqueda: nombre });
        expect(grupo.unidades_mixtas).toBe(true);
        // Esto es lo que se está protegiendo: callar antes que inventar un ganador.
        expect(grupo.id_mas_barato).toBeNull();
    });

    test('sin saber cuánto trae la presentación, el precio por unidad sale marcado como estimado', async () => {
        if (!A) return;

        const prov = await Prov.crear(A.id_usuario, {
            id_negocio: A.id_negocio, nombre_comercial: `TEST-PRV estimado ${Date.now()}`,
        });
        proveedoresCreados.push(prov.id_proveedor);

        const nombre = `TEST-PRV sin cantidad ${Date.now()}`;
        await Prov.crearInsumo(A.id_usuario, prov.id_proveedor, {
            id_negocio: A.id_negocio, nombre, unidad: 'KG', precio: 7000,
        });

        const [grupo] = await Prov.comparar(A.id_usuario, { idNegocio: A.id_negocio, busqueda: nombre });
        expect(grupo.ofertas[0].estimado).toBe(true);
        expect(grupo.ofertas[0].precio_base).toBe(7000);
    });

    test('comparar exige el permiso de precios', async () => {
        if (!A) return;
        // El servicio pregunta por `proveedores_precios`; con un usuario que no existe no hay
        // rol que valga, así que la respuesta es un 403 tipado y no una lista vacía.
        await expect(
            Prov.comparar(-1, { idNegocio: A.id_negocio, busqueda: 'lo que sea' }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });
});

// ============================================================
// Conversión de unidades (función pura)
// ============================================================

describe('Conversión de unidades', () => {
    test('convierte dentro de la misma familia', () => {
        expect(Compras.convertir(1, 'KG', 'G')).toBe(1000);
        expect(Compras.convertir(500, 'G', 'KG')).toBe(0.5);
        expect(Compras.convertir(2, 'L', 'ML')).toBe(2000);
    });

    test('devuelve null entre familias distintas: no inventa', () => {
        expect(Compras.convertir(1, 'KG', 'L')).toBeNull();
        expect(Compras.convertir(1, 'CAJA', 'G')).toBeNull();
        expect(Compras.convertir(1, 'UN', 'KG')).toBeNull();
    });

    test('entiende cómo se escribe la unidad en el inventario', () => {
        expect(Compras.unidadInventario('g')).toBe('G');
        expect(Compras.unidadInventario('Gramos')).toBe('G');
        expect(Compras.unidadInventario('und')).toBe('UN');
        expect(Compras.unidadInventario('litros')).toBe('L');
        expect(Compras.unidadInventario('cucharadas')).toBeNull();
    });
});
