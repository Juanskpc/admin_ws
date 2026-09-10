/**
 * Rubros: separar **el oficio del cliente** del **módulo que lo atiende**.
 *
 *   npm run migrate:rubros-negocio
 *
 * ## El problema
 *
 * `gener_tipo_negocio` venía haciendo dos trabajos incompatibles a la vez: decir qué es el
 * negocio para el cliente («Barbería») y decidir qué software se le monta. Como los roles, los
 * permisos y el filtro de cada vertical cuelgan de `id_tipo_negocio`, el segundo trabajo manda:
 * el tipo TIENE que ser el módulo. Y entonces al cliente hay que decirle que es un «RESERVA»,
 * que no significa nada para él, o crearle un tipo con su nombre y dejarlo sin app — que es
 * exactamente lo que le pasó al primer cliente de reserva, creado como BARBERIA (2026-09-09).
 *
 * La misma decisión estaba además escrita en **cuatro sitios** que había que sincronizar a
 * mano: los chips de la landing, el validador de `registroVerificacionController.js`, el mapa
 * `TIPO_NEGOCIO_MAPA` de `registroTrialService.js` y esta tabla. Olvidar uno no daba error:
 * daba un negocio inservible o un 400 sin explicación.
 *
 * ## Lo que hace
 *
 * 1. `gener_tipo_negocio.id_tipo_modulo` — auto-referencia: «a este oficio lo atiende aquel
 *    módulo». RESTAURANTE se apunta a sí mismo; CAFETERIA, HELADERIA y PIZZERIA apuntan a
 *    RESTAURANTE; BARBERIA y SALON DE BELLEZA apuntan a RESERVA.
 *
 *    **`NULL` significa «hoy no lo podemos atender»**, y por eso PARQUEADERO, GIMNASIO y TIENDA
 *    se quedan en NULL aunque tengan permisos sembrados: su app no está desplegada en el VPS.
 *    Ofrecerlos sería vender algo que el cliente no puede abrir el lunes. Habilitar uno el día
 *    que se despliegue es un UPDATE de una fila, no un cambio de código.
 *
 * 2. `gener_tipo_negocio.orden` — el orden en que se le enseñan al cliente. No es alfabético
 *    a propósito: «Restaurante» y «Barbería» encabezan su grupo porque son los que más se
 *    buscan, y alfabéticamente caerían en medio y al final.
 *
 * 3. `descripcion` pasa a ser **la etiqueta legible** («Salón de belleza»), que es para lo que
 *    estaba pensada y estaba sin usar en las ocho filas. `nombre` sigue siendo la clave en
 *    mayúsculas y sin tildes.
 *
 * 4. `gener_negocio.id_rubro` — qué oficio dijo ser el cliente. `id_tipo_negocio` **no cambia
 *    de significado**: sigue siendo el módulo, y por tanto los permisos y los roles siguen
 *    funcionando exactamente igual. Backfill: los negocios que ya existen quedan con el rubro
 *    igual a su módulo, que es lo único cierto que se sabe de ellos.
 *
 * Todo se resuelve **por nombre, nunca por id**: los ids de tipo NO coinciden entre la base de
 * desarrollo y la de producción (RESERVA es 9 en una y 10 en la otra). Escribir un id aquí
 * habría mapeado media docena de oficios al módulo equivocado en producción.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER y los rubros van por
 * `ON CONFLICT (nombre)`.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

/**
 * Los oficios que ofrecemos, agrupados por el módulo que los atiende.
 *
 * `icono` es un nombre de icono de lucide y lo consumen tanto la consola como la landing; si se
 * añade uno nuevo hay que importarlo también en `landing.component.ts`, que registra los iconos
 * de uno en uno y no falla al compilar, solo deja el hueco vacío.
 */
const RUBROS = [
    // ── Los atiende el módulo de RESTAURANTE ──
    { modulo: 'RESTAURANTE', nombre: 'RESTAURANTE',            etiqueta: 'Restaurante',            icono: 'utensils-crossed', orden: 10 },
    { modulo: 'RESTAURANTE', nombre: 'CAFETERIA',              etiqueta: 'Cafetería',              icono: 'coffee',           orden: 20 },
    { modulo: 'RESTAURANTE', nombre: 'PANADERIA Y REPOSTERIA', etiqueta: 'Panadería / Repostería', icono: 'croissant',        orden: 30 },
    { modulo: 'RESTAURANTE', nombre: 'HELADERIA',              etiqueta: 'Heladería',              icono: 'ice-cream-cone',   orden: 40 },
    { modulo: 'RESTAURANTE', nombre: 'BAR',                    etiqueta: 'Bar',                    icono: 'beer',             orden: 50 },
    { modulo: 'RESTAURANTE', nombre: 'COMIDAS RAPIDAS',        etiqueta: 'Comidas rápidas',        icono: 'sandwich',         orden: 60 },
    { modulo: 'RESTAURANTE', nombre: 'PIZZERIA',               etiqueta: 'Pizzería',               icono: 'pizza',            orden: 70 },

    // ── Los atiende el módulo de RESERVA ──
    { modulo: 'RESERVA',     nombre: 'BARBERIA',               etiqueta: 'Barbería',               icono: 'scissors',         orden: 110 },
    { modulo: 'RESERVA',     nombre: 'SALON DE BELLEZA',       etiqueta: 'Salón de belleza',       icono: 'sparkles',         orden: 120 },
    { modulo: 'RESERVA',     nombre: 'PELUQUERIA',             etiqueta: 'Peluquería',             icono: 'scissors',         orden: 130 },
    { modulo: 'RESERVA',     nombre: 'SPA Y ESTETICA',         etiqueta: 'Spa / Estética',         icono: 'flower-2',         orden: 140 },
    { modulo: 'RESERVA',     nombre: 'MANICURE Y PEDICURE',    etiqueta: 'Uñas',                   icono: 'hand',             orden: 150 },
    { modulo: 'RESERVA',     nombre: 'MASAJES',                etiqueta: 'Masajes',                icono: 'hand-heart',       orden: 160 },
    { modulo: 'RESERVA',     nombre: 'CONSULTORIO',            etiqueta: 'Consultorio',            icono: 'stethoscope',      orden: 170 },
];

/** Los módulos que existen de verdad. El resto de tipos se queda sin `id_tipo_modulo`. */
const MODULOS = ['RESTAURANTE', 'RESERVA'];

async function existeColumna(tabla, columna, transaction) {
    const [filas] = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'general' AND table_name = :tabla AND column_name = :columna;`,
        { replacements: { tabla, columna }, transaction },
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: rubros de negocio\n');

        // ── 1. Columnas nuevas ────────────────────────────────────────────────
        console.log('1. Columnas en general.gener_tipo_negocio...');
        if (!await existeColumna('gener_tipo_negocio', 'id_tipo_modulo', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_tipo_negocio
                ADD COLUMN id_tipo_modulo INTEGER NULL
                REFERENCES general.gener_tipo_negocio(id_tipo_negocio);
            `, { transaction: t });
            console.log('   id_tipo_modulo creada.');
        } else {
            console.log('   id_tipo_modulo ya existe.');
        }

        if (!await existeColumna('gener_tipo_negocio', 'orden', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_tipo_negocio
                ADD COLUMN orden SMALLINT NOT NULL DEFAULT 999;
            `, { transaction: t });
            console.log('   orden creada.\n');
        } else {
            console.log('   orden ya existe.\n');
        }

        console.log('2. Columna en general.gener_negocio...');
        if (!await existeColumna('gener_negocio', 'id_rubro', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN id_rubro INTEGER NULL
                REFERENCES general.gener_tipo_negocio(id_tipo_negocio) ON DELETE SET NULL;
            `, { transaction: t });
            console.log('   id_rubro creada.\n');
        } else {
            console.log('   id_rubro ya existe.\n');
        }

        // ── 2. Los módulos deben existir antes de que nadie los apunte ────────
        console.log('3. Comprobando los módulos...');
        const idPorNombre = {};
        for (const modulo of MODULOS) {
            const [filas] = await sequelize.query(
                `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = :nombre;`,
                { replacements: { nombre: modulo }, transaction: t },
            );
            if (filas.length === 0) {
                throw new Error(
                    `No existe el tipo de negocio «${modulo}», que es uno de los módulos. `
                    + 'Corre antes las migraciones base.',
                );
            }
            idPorNombre[modulo] = filas[0].id_tipo_negocio;
            console.log(`   ${modulo} → id ${filas[0].id_tipo_negocio}`);
        }
        console.log('');

        // ── 3. Los rubros ─────────────────────────────────────────────────────
        console.log('4. Sembrando rubros...');
        let creados = 0;
        let actualizados = 0;
        for (const r of RUBROS) {
            const [filas] = await sequelize.query(
                `
                INSERT INTO general.gener_tipo_negocio
                       (nombre, descripcion, icono, orden, id_tipo_modulo, estado)
                VALUES (:nombre, :etiqueta, :icono, :orden, :modulo, 'A')
                ON CONFLICT (nombre) DO UPDATE SET
                    descripcion         = EXCLUDED.descripcion,
                    icono               = EXCLUDED.icono,
                    orden               = EXCLUDED.orden,
                    id_tipo_modulo      = EXCLUDED.id_tipo_modulo,
                    estado              = 'A',
                    fecha_actualizacion = CURRENT_TIMESTAMP
                RETURNING id_tipo_negocio, (xmax = 0) AS insertado;
                `,
                {
                    replacements: {
                        nombre: r.nombre, etiqueta: r.etiqueta, icono: r.icono,
                        orden: r.orden, modulo: idPorNombre[r.modulo],
                    },
                    transaction: t,
                },
            );
            if (filas[0]?.insertado) { creados += 1; } else { actualizados += 1; }
        }
        console.log(`   ${creados} creados, ${actualizados} actualizados.\n`);

        // ── 4. Lo que NO se ofrece, explícitamente ────────────────────────────
        //
        // Se fuerza a NULL en vez de dejarlo "como esté": si alguien apuntó a mano un tipo sin
        // app desplegada, esto lo deshace. La lista de lo ofrecible tiene que salir de aquí y
        // de ningún otro sitio.
        console.log('5. Dejando sin módulo los tipos que no se pueden atender...');
        const [sinModulo] = await sequelize.query(
            `
            UPDATE general.gener_tipo_negocio
               SET id_tipo_modulo = NULL, fecha_actualizacion = CURRENT_TIMESTAMP
             WHERE nombre NOT IN (:nombres)
               AND id_tipo_modulo IS NOT NULL
            RETURNING nombre;
            `,
            { replacements: { nombres: RUBROS.map((r) => r.nombre) }, transaction: t },
        );
        console.log(`   ${sinModulo.length} tipo(s) sin módulo${sinModulo.length ? ': ' + sinModulo.map((f) => f.nombre).join(', ') : ''}.\n`);

        // ── 5. Backfill del rubro de los negocios que ya existen ──────────────
        //
        // Lo único cierto que se sabe de ellos es su módulo, así que el rubro queda igual. Un
        // negocio que en realidad es una barbería lo corrige su dueño (o el super admin) desde
        // la consola; inventarlo aquí sería adivinar.
        console.log('6. Backfill de gener_negocio.id_rubro...');
        const [backfill] = await sequelize.query(
            `
            UPDATE general.gener_negocio
               SET id_rubro = id_tipo_negocio
             WHERE id_rubro IS NULL AND id_tipo_negocio IS NOT NULL
            RETURNING id_negocio;
            `,
            { transaction: t },
        );
        console.log(`   ${backfill.length} negocio(s) actualizados.\n`);

        await t.commit();
        console.log('✓ Migración de rubros completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
