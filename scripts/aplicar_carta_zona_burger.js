/**
 * Ajustes de NOMBRES en la carta de Zona Burger (negocio 6), aprobados por el cliente el
 * 2026-10-04 (entregable «Ajustes sugeridos a la carta de Zona Burger»).
 *
 *   node scripts/aplicar_carta_zona_burger.js             # ENSAYO: dice qué haría, no escribe
 *   node scripts/aplicar_carta_zona_burger.js --aplicar   # escribe, en una transacción
 *
 * Qué toca, y nada más:
 *   - `nombre` de los productos de la lista (y la descripción de las alitas, una errata);
 *   - crea tres «Familiar <sabor>» copiando la familiar genérica (que no tiene receta) y deja la
 *     genérica fuera de la carta pública y del asistente (`visible = false`), con su historial.
 * NO toca precios, disponibilidad, empaques, recetas, categorías ni pedidos.
 *
 * Salvaguardas: exige que el negocio 6 se llame ZONA BURGER; cada producto tiene que llamarse HOY
 * como se espera (si alguien lo cambió, aborta entero); antes de escribir guarda la carta completa
 * en un JSON (`--respaldo <ruta>`, por defecto en /tmp) con el que se puede deshacer.
 *
 * Lo que el entregable pedía y aquí NO se hace porque falta un dato del negocio: el precio real de
 * «Cigarra 400ml» ($1), qué es «concurso», los sabores de Postobón y las descripciones que faltan.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const Models = require('../app_core/models/conection');

const ID_NEGOCIO = 6;
const APLICAR = process.argv.includes('--aplicar');
const iRespaldo = process.argv.indexOf('--respaldo');
const RESPALDO = iRespaldo > -1 ? process.argv[iRespaldo + 1] : `/tmp/carta_zona_burger_antes_${Date.now()}.json`;

/** id_producto → [nombre de hoy, nombre nuevo] */
const NOMBRES = {
    // Salchipapas: mismo patrón de tamaños
    31: ['viciosa', 'Viciosa pequeña'],
    61: ['viciosa mediana', 'Viciosa mediana'],
    65: ['viciosa GRANDE', 'Viciosa grande'],
    30: ['criollita', 'Criollita pequeña'],
    59: ['criolla mediana', 'Criollita mediana'],
    63: ['criollita GRANDE', 'Criollita grande'],
    32: ['the house', 'The House pequeña'],
    60: ['the house mediana', 'The House mediana'],
    64: ['the house GRANDE', 'The House grande'],
    29: ['Salchi-limon', 'Salchi-limón personal'],
    // «mediana» se queda en el nombre: es la marca de tamaño que entiende el buscador del
    // asistente; «pareja» va al lado porque así la piden («una salchilimón de pareja»).
    62: ['salchi-limon mediana', 'Salchi-limón mediana (pareja)'],
    84: ['salchi barril per', 'Salchibarril personal'],
    148: ['BARRIL MEDIANO', 'Salchibarril mediana'],
    33: ['choripapa', 'Choripapa'],
    // Carnes: el mismo nombre en las tres
    36: ['parrillada de res', 'Parrilla de res'],
    34: ['parrilla de cerdo', 'Parrilla de cerdo'],
    35: ['parrilla de pollo', 'Parrilla de pollo'],
    // Hot dogs: como los piden
    42: ['perro loco', 'Perro caliente loco'],
    43: ['smoked dog', 'Perro caliente smoked'],
    // Hervidos
    53: ['lulo', 'Hervido de lulo'],
    52: ['maracuya', 'Hervido de maracuyá'],
    51: ['mora', 'Hervido de mora'],
    // Bebidas: tipo, sabor y tamaño
    70: ['cuatro', 'Gaseosa Cuatro personal'],
    67: ['cuatro 1,5', 'Gaseosa Cuatro 1,5 L'],
    69: ['coca-cola', 'Coca-Cola personal'],
    66: ['Coca grande', 'Coca-Cola 1,5 L'],
    81: ['Postobón 1.5 ml', 'Postobón 1,5 L'],
    83: ['postobon 1L', 'Postobón 1 L'],
    79: ['postobon 500ml', 'Postobón personal 500 ml'],
    68: ['del valle', 'Jugo Del Valle'],
    363: ['POWER', 'Bebida Power'],
    78: ['Agua', 'Agua en botella'],
    80: ['Jugo Hit 500ml', 'Jugo Hit 500 ml'],
};

/** La errata de las alitas: id → [fragmento de hoy, corrección]. */
const DESCRIPCIONES = {
    40: ['acompañas de papá francesa', 'acompañadas de papa a la francesa'],
    41: ['acompañas de papá francesa', 'acompañadas de papa a la francesa'],
};

/** La familiar genérica y los tres sabores que la reemplazan en la carta. */
const FAMILIAR = { id: 73, hoy: 'familiar', despues: 'Familiar (sin sabor)' };
const SABORES = [
    ['Familiar Criollita', 'Tamaño familiar de nuestra salchipapa La Criollita.'],
    ['Familiar The House', 'Tamaño familiar de nuestra salchipapa The House.'],
    ['Familiar Viciosa', 'Tamaño familiar de nuestra salchipapa La Viciosa.'],
];

(async () => {
    const t = await Models.sequelize.transaction();
    const q = (sql, replacements = {}) =>
        Models.sequelize.query(sql, { replacements, transaction: t, type: Models.sequelize.QueryTypes.SELECT, logging: false });
    const escribir = (sql, replacements = {}) => Models.sequelize.query(sql, { replacements, transaction: t, logging: false });
    try {
        const [negocio] = await q(`SELECT nombre FROM general.gener_negocio WHERE id_negocio = :id;`, { id: ID_NEGOCIO });
        if (!negocio || !/zona\s*burger/i.test(negocio.nombre)) {
            throw new Error(`El negocio ${ID_NEGOCIO} no es Zona Burger (es «${negocio?.nombre ?? 'ninguno'}»). Base equivocada.`);
        }

        const antes = await q(`SELECT * FROM restaurante.carta_producto WHERE id_negocio = :id ORDER BY id_producto;`, { id: ID_NEGOCIO });
        const porId = new Map(antes.map((p) => [Number(p.id_producto), p]));

        // 1. Todo tiene que estar como se espera, o no se toca nada.
        const problemas = [];
        for (const [id, [hoy]] of Object.entries(NOMBRES)) {
            const p = porId.get(Number(id));
            if (!p) problemas.push(`producto ${id}: no existe`);
            else if (p.nombre !== hoy) problemas.push(`producto ${id}: se llama «${p.nombre}», se esperaba «${hoy}»`);
        }
        for (const [id, [fragmento]] of Object.entries(DESCRIPCIONES)) {
            if (!String(porId.get(Number(id))?.descripcion || '').includes(fragmento)) {
                problemas.push(`producto ${id}: la descripción ya no tiene «${fragmento}»`);
            }
        }
        const generica = porId.get(FAMILIAR.id);
        if (!generica || generica.nombre !== FAMILIAR.hoy) problemas.push(`familiar ${FAMILIAR.id}: no está como se esperaba`);
        for (const [nombre] of SABORES) {
            if (antes.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) problemas.push(`ya existe «${nombre}»`);
        }
        if (problemas.length) throw new Error(`La carta no está como se esperaba:\n  - ${problemas.join('\n  - ')}`);

        console.log(`${APLICAR ? 'APLICANDO' : 'ENSAYO (no escribe)'} — ${negocio.nombre}, ${antes.length} productos\n`);
        for (const [id, [hoy, nuevo]] of Object.entries(NOMBRES)) console.log(`  ${String(id).padStart(3)}  «${hoy}»  →  «${nuevo}»`);
        for (const id of Object.keys(DESCRIPCIONES)) console.log(`  ${String(id).padStart(3)}  descripción: errata de las alitas`);
        console.log(`  ${FAMILIAR.id}  «${FAMILIAR.hoy}»  →  «${FAMILIAR.despues}» (fuera de la carta pública) + ${SABORES.map((s) => `«${s[0]}»`).join(', ')}`);

        if (!APLICAR) {
            await t.rollback();
            console.log('\nEnsayo terminado: no se escribió nada. Con --aplicar se ejecuta.');
            return;
        }

        fs.writeFileSync(RESPALDO, JSON.stringify(antes, null, 1));
        console.log(`\nRespaldo de la carta: ${RESPALDO}`);

        for (const [id, [, nuevo]] of Object.entries(NOMBRES)) {
            await escribir(`UPDATE restaurante.carta_producto SET nombre = :nuevo WHERE id_producto = :id AND id_negocio = :n;`, { nuevo, id: Number(id), n: ID_NEGOCIO });
        }
        for (const [id, [fragmento, correccion]] of Object.entries(DESCRIPCIONES)) {
            await escribir(
                `UPDATE restaurante.carta_producto SET descripcion = replace(descripcion, :fragmento, :correccion) WHERE id_producto = :id AND id_negocio = :n;`,
                { fragmento, correccion, id: Number(id), n: ID_NEGOCIO }
            );
        }
        await escribir(`UPDATE restaurante.carta_producto SET nombre = :nombre, visible = false WHERE id_producto = :id AND id_negocio = :n;`, {
            nombre: FAMILIAR.despues, id: FAMILIAR.id, n: ID_NEGOCIO,
        });
        const creados = [];
        for (const [nombre, descripcion] of SABORES) {
            const [fila] = await q(
                `INSERT INTO restaurante.carta_producto
                    (id_negocio, id_categoria, nombre, descripcion, precio, imagen_url, icono, es_popular,
                     disponible, visible, estado, id_producto_empaque, cantidad_empaque)
                 SELECT id_negocio, id_categoria, :nombre, :descripcion, precio, imagen_url, icono, es_popular,
                        disponible, true, estado, id_producto_empaque, cantidad_empaque
                   FROM restaurante.carta_producto WHERE id_producto = :id
                 RETURNING id_producto;`,
                { nombre, descripcion, id: FAMILIAR.id }
            );
            creados.push(`${nombre} = ${fila.id_producto}`);
        }

        // 2. Comprobación antes de confirmar: nada más cambió.
        const despues = await q(`SELECT * FROM restaurante.carta_producto WHERE id_negocio = :id ORDER BY id_producto;`, { id: ID_NEGOCIO });
        if (despues.length !== antes.length + SABORES.length) throw new Error('El número de productos no cuadra.');
        const permitidos = { nombre: 1, descripcion: 1, visible: 1 };
        for (const a of antes) {
            const d = despues.find((x) => x.id_producto === a.id_producto);
            for (const campo of Object.keys(a)) {
                if (String(a[campo]) !== String(d[campo]) && !permitidos[campo]) {
                    throw new Error(`El producto ${a.id_producto} cambió en «${campo}», y no debía.`);
                }
            }
            const id = Number(a.id_producto);
            if (!NOMBRES[id] && !DESCRIPCIONES[id] && id !== FAMILIAR.id && JSON.stringify(a) !== JSON.stringify(d)) {
                throw new Error(`El producto ${a.id_producto} cambió y no estaba en la lista.`);
            }
        }

        await t.commit();
        console.log(`✓ Hecho. Nuevos: ${creados.join(', ')}. Precios, disponibilidad, empaques y recetas, sin tocar.`);
    } catch (error) {
        await t.rollback();
        console.error(`✗ No se cambió nada: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
})();
