/**
 * Restaurante de EVALUACIÓN con la carta pública de Zona Burger, para comparar modelos con
 * `scripts/evaluar.js respuestas_restaurante` (2026-10-04).
 *
 *   node scripts/fixtures/dev_zona_burger_eval.js          # crea o pone al día; imprime el id
 *
 * Solo datos PÚBLICOS: la carta que cualquiera ve en escalapp.cloud/restaurante/carta/6
 * (`zona_burger_carta_publica.json`) y los ajustes del asistente que el bot le dice a cualquier
 * cliente (tiempo, rango del domicilio, cómo pagar). Ningún cliente, pedido ni teléfono.
 *
 * Idempotente. El negocio se clona de otro restaurante de la misma base (para no adivinar las
 * columnas obligatorias de `gener_negocio`), queda sin horario (= abierto siempre, ver
 * horarioService.estaAbierto) y con una caja abierta, para que la evaluación no dependa de la hora.
 *
 * ⚠️ Solo para bases de desarrollo: aborta con NODE_ENV=production o un DB_HOST que no sea local.
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const carta = require('./zona_burger_carta_publica.json');

const NOMBRE = 'ZONA BURGER (EVALUACIÓN)';
const SELECT = { type: Models.sequelize.QueryTypes.SELECT };
const CAPACIDADES = [
    'buscar_producto', 'consultar_carta', 'tomar_pedido', 'agregar_items_pedido',
    'cancelar_pedido', 'consultar_estado_pedido', 'consultar_info_negocio',
];
const AJUSTES = {
    tiempo_estimado_min: 40,
    tiempo_estimado_max: 60,
    domicilio_valor_min: 7000,
    domicilio_valor_max: 9000,
    domicilio_nota: 'Fuera de Pasto, desde $10.000.',
    pago_texto_domicilio:
        'En los domicilios el pago es por transferencia o en efectivo, y lo haces cuando el ' +
        'domiciliario llegue con tu pedido 🛵',
    pago_texto_local:
        'Puedes pagar por transferencia a la llave BreB o al Nequi 3236388196. En los dos te ' +
        'aparece como «Bra*** Mej**»: confírmalo antes de enviar 🙌',
};

if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(process.env.DB_HOST)) {
    console.error('Solo para una base de desarrollo local. Abortado.');
    process.exit(1);
}

(async () => {
    const t = await Models.sequelize.transaction();
    try {
        const q = (sql, replacements = {}) => Models.sequelize.query(sql, { replacements, transaction: t, ...SELECT });

        let [negocio] = await q(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = :n LIMIT 1;`, { n: NOMBRE });
        if (!negocio) {
            const [plantilla] = await q(
                `SELECT id_negocio FROM general.gener_negocio
                  WHERE id_tipo_negocio = 1 AND estado = 'A' ORDER BY id_negocio LIMIT 1;`
            );
            if (!plantilla) throw new Error('No hay ningún restaurante en esta base para clonar.');
            const columnas = (
                await q(
                    `SELECT column_name FROM information_schema.columns
                      WHERE table_schema = 'general' AND table_name = 'gener_negocio'
                        AND column_name <> 'id_negocio' AND is_generated = 'NEVER'
                      ORDER BY ordinal_position;`
                )
            ).map((c) => `"${c.column_name}"`);
            // Las columnas únicas no se copian: un NIT y un slug propios.
            const propias = { '"nit"': `'EVAL-ZONA-BURGER'`, '"slug"': `'zona-burger-evaluacion'` };
            const origen = columnas.map((c) => propias[c] ?? c);
            [negocio] = await q(
                `INSERT INTO general.gener_negocio (${columnas.join(', ')})
                 SELECT ${origen.join(', ')} FROM general.gener_negocio WHERE id_negocio = :p
                 RETURNING id_negocio;`,
                { p: plantilla.id_negocio }
            );
        }
        const id = negocio.id_negocio;

        await Models.sequelize.query(
            `UPDATE general.gener_negocio
                SET nombre = :nombre, estado = 'A', id_tipo_negocio = 1, pais = 'CO',
                    tiempo_estimado_min = :tiempo_estimado_min, tiempo_estimado_max = :tiempo_estimado_max,
                    domicilio_valor_min = :domicilio_valor_min, domicilio_valor_max = :domicilio_valor_max,
                    domicilio_nota = :domicilio_nota, pago_texto_domicilio = :pago_texto_domicilio,
                    pago_texto_local = :pago_texto_local, asistente_pausado = false
              WHERE id_negocio = :id;`,
            { replacements: { id, nombre: NOMBRE, ...AJUSTES }, transaction: t }
        );

        // Carta: se rehace entera desde la foto pública.
        await Models.sequelize.query(`DELETE FROM restaurante.carta_producto WHERE id_negocio = :id;`, { replacements: { id }, transaction: t });
        await Models.sequelize.query(`DELETE FROM restaurante.carta_categoria WHERE id_negocio = :id;`, { replacements: { id }, transaction: t });
        let orden = 1;
        let productos = 0;
        for (const cat of carta.categorias) {
            const [c] = await q(
                `INSERT INTO restaurante.carta_categoria (id_negocio, nombre, descripcion, icono, orden, estado, visible)
                 VALUES (:id, :nombre, '', :icono, :orden, 'A', true) RETURNING id_categoria;`,
                { id, nombre: cat.nombre, icono: cat.icono || null, orden: orden++ }
            );
            for (const p of cat.productos) {
                await Models.sequelize.query(
                    `INSERT INTO restaurante.carta_producto
                        (id_negocio, id_categoria, nombre, descripcion, precio, icono, es_popular, disponible, estado, visible)
                     VALUES (:id, :cat, :nombre, :descripcion, :precio, :icono, false, true, 'A', true);`,
                    { replacements: { id, cat: c.id_categoria, ...p, icono: p.icono || null }, transaction: t }
                );
                productos++;
            }
        }

        // Abierto siempre: sin horario y con una caja abierta en su punto de caja.
        await Models.sequelize.query(`DELETE FROM restaurante.rest_horario WHERE id_negocio = :id;`, { replacements: { id }, transaction: t });
        let [punto] = await q(`SELECT id_punto_caja FROM restaurante.rest_punto_caja WHERE id_negocio = :id LIMIT 1;`, { id });
        if (!punto) {
            [punto] = await q(
                `INSERT INTO restaurante.rest_punto_caja (id_negocio, nombre, descripcion, orden, estado)
                 VALUES (:id, 'Caja principal', 'Evaluación de modelos', 0, 'A') RETURNING id_punto_caja;`,
                { id }
            );
        }
        const [abierta] = await q(`SELECT 1 FROM restaurante.rest_caja WHERE id_negocio = :id AND estado = 'A' LIMIT 1;`, { id });
        if (!abierta) {
            const [usuario] = await q(`SELECT id_usuario FROM general.gener_usuario WHERE estado = 'A' ORDER BY id_usuario LIMIT 1;`);
            await Models.sequelize.query(
                `INSERT INTO restaurante.rest_caja (id_negocio, id_usuario, id_punto_caja, monto_apertura, estado)
                 VALUES (:id, :u, :p, 0, 'A');`,
                { replacements: { id, u: usuario.id_usuario, p: punto.id_punto_caja }, transaction: t }
            );
        }

        // Un domiciliario: sin ninguno, `tomar_pedido` rechaza los domicilios
        // (SIN_DOMICILIARIO_DISPONIBLE) y la evaluación mediría eso en vez del modelo. Con
        // `permite_domicilio_personal` cualquier usuario vinculado cuenta como domiciliario.
        await Models.sequelize.query(
            `UPDATE general.gener_negocio SET permite_domicilio_personal = true WHERE id_negocio = :id;`,
            { replacements: { id }, transaction: t }
        );
        const [vinculado] = await q(
            `SELECT 1 FROM general.gener_negocio_usuario WHERE id_negocio = :id AND estado = 'A' LIMIT 1;`,
            { id }
        );
        if (!vinculado) {
            const [persona] = await q(
                `SELECT id_usuario FROM general.gener_usuario
                  WHERE estado = 'A' AND num_identificacion NOT LIKE 'ASISTENTE-%' ORDER BY id_usuario LIMIT 1;`
            );
            await Models.sequelize.query(
                `INSERT INTO general.gener_negocio_usuario (id_usuario, id_negocio, estado) VALUES (:u, :id, 'A');`,
                { replacements: { u: persona.id_usuario, id }, transaction: t }
            );
        }

        // Dos mesas libres: «para servir» guarda la primera libre, y sin ninguna `tomar_pedido`
        // contesta SIN_MESA_LIBRE (otra vez el entorno, no el modelo).
        const [mesas] = await q(`SELECT count(*)::int AS n FROM restaurante.rest_mesa WHERE id_negocio = :id;`, { id });
        for (let numero = mesas.n + 1; numero <= 2; numero++) {
            await Models.sequelize.query(
                `INSERT INTO restaurante.rest_mesa (id_negocio, nombre, numero, capacidad, estado, estado_servicio)
                 VALUES (:id, :nombre, :numero, 4, 'A', 'DISPONIBLE');`,
                { replacements: { id, nombre: `MESA ${numero}`, numero }, transaction: t }
            );
        }

        for (const capacidad of CAPACIDADES) {
            await Models.sequelize.query(
                `INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada)
                 VALUES (:id, :capacidad, true)
                 ON CONFLICT DO NOTHING;`,
                { replacements: { id, capacidad }, transaction: t }
            );
        }

        await t.commit();
        console.log(`✓ ${NOMBRE}: id_negocio ${id}, ${productos} productos, ${CAPACIDADES.length} capacidades.`);
        console.log(`  FEATURES_FORZADAS=asistente_ia node scripts/evaluar.js respuestas_restaurante --negocio ${id} --comparar gpt-5.6-terra,gpt-5.6-luna`);
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló (revertido):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
})();
