/**
 * FE-1 — El modelo de datos fiscal.
 *
 * Ver `docs/facturacion-electronica.md` §5 (el mapa de campos) y §9 (las fases), y
 * `docs/adr/ADR-026-facturacion-electronica.md` (por qué se integra un proveedor tecnológico en
 * vez de construir el emisor).
 *
 * ## Qué hace, y qué NO hace
 *
 * Esto **no emite nada**. Crea el sitio donde viven los datos que la DIAN exige y que hoy no
 * tenemos: `general.gener_negocio` guarda `nit` y punto. Sin estos campos no se puede construir un
 * documento fiscal, y son los que hay que capturar **antes** de que un cliente los necesite.
 *
 * No crea `fe_documento` ni `fe_configuracion`: eso es FE-2, cuando haya un proveedor elegido y
 * algo que enviarle. Construir la tabla de documentos antes de saber qué devuelve el proveedor es
 * adivinar el esquema.
 *
 * ## La decisión que gobierna todo lo de aquí: nace apagada
 *
 * `modo_facturacion` vale `NINGUNO` por defecto **para todos los negocios existentes**. Con ese
 * valor no cambia absolutamente nada: ni una validación nueva, ni un campo obligatorio, ni una
 * llamada a ningún sitio. Un negocio que está empezando y no quiere saber de esto no se entera de
 * que la migración pasó.
 *
 * Y `obligado_a_facturar` lo **declara el cliente**, no lo deducimos: quién está obligado depende
 * de sus ingresos, su régimen y su figura jurídica, datos que no tenemos y que no nos corresponde
 * interpretar. Guardamos qué declaró, quién lo declaró y cuándo.
 *
 * ## El negocio que NO está registrado — y por qué merece su propia columna
 *
 * Buena parte de los clientes de EscalApp son negocios **sin matrícula mercantil y sin RUT**.
 * Ayudarlos a crecer es parte de por qué existe el producto, así que el modelo tiene que
 * contemplarlos sin tratarlos como un formulario a medio llenar.
 *
 * `tipo_persona` en NULL no basta, porque mezcla dos cosas que la interfaz debe tratar distinto:
 * «todavía no se lo hemos preguntado» y «no está registrado, no hay nada que preguntar». La
 * primera hay que insistirla; la segunda **no**, y darle la lata a alguien que ya contestó es la
 * forma más rápida de que odie el producto.
 *
 * De ahí `estado_registro`: `NO_DECLARADO` (defecto) · `SIN_REGISTRO` · `REGISTRADO`.
 *
 * Ojo con una confusión fácil: un negocio informal **sí tiene dueño con cédula**, así que
 * fiscalmente es una persona natural y NOSOTROS sí podemos facturarle la mensualidad. Lo que no
 * tiene es RUT ni resolución, o sea que **él** no puede emitir. Por eso el invariante va en la
 * base y no en un `if`: sin `REGISTRADO`, `modo_facturacion` no puede salir de `NINGUNO`.
 *
 * Y lo que el cliente declare aquí es **responsabilidad suya**, no nuestra: nosotros no
 * verificamos su registro ante la Cámara de Comercio ni ante la DIAN. Eso tiene que estar escrito
 * en los términos y condiciones — ver `docs/obligaciones-escalapp.md` §6.
 *
 * ## Dos cosas que se dejan a medias A PROPÓSITO
 *
 * 1. **`municipio_dane` no tiene FK ni catálogo.** El catálogo real son ~1.100 municipios y todos
 *    los proveedores tecnológicos publican el suyo; sembrar aquí una lista parcial (las capitales,
 *    por ejemplo) sería peor que no tenerla, porque parecería completa y el negocio de Envigado no
 *    se podría guardar. Se carga en FE-2 desde el proveedor elegido. Aquí solo se valida el
 *    formato. Los **departamentos sí** se siembran completos: son 33 y no cambian.
 * 2. **`unidad_medida_dian` se crea sin valor por defecto.** La lista de códigos también la publica
 *    cada proveedor y no coinciden todos; poner un código adivinado en una migración es sembrar un
 *    dato equivocado en todos los productos a la vez.
 *
 *    Y se llama `unidad_medida_DIAN` por algo concreto: `tienda.tienda_producto` **ya tiene** una
 *    `unidad_medida` que es `'und'`, `'kg'`, `'lt'` — legible para una persona, no un código de la
 *    DIAN. Son dos conceptos distintos y reutilizar el nombre habría hecho que la misma columna
 *    significara una cosa en tienda y otra en las demás verticales. Ese es el tipo de ambigüedad
 *    que no se descubre hasta que una factura sale con la unidad equivocada.
 *
 * ## Impuestos por línea
 *
 * Las columnas van en las tablas de producto de las CINCO verticales, **sin FK hacia
 * `facturacion`** — ADR-005, el test del apagón: si la facturación se apaga o se cae, el
 * restaurante tiene que seguir vendiendo. La validación contra el catálogo la hace la aplicación.
 *
 * Idempotente: `IF NOT EXISTS` en todo, y las ALTER comprueban `information_schema` antes de tocar
 * nada. Se puede correr dos veces seguidas sin efecto.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

/** Los 32 departamentos + Bogotá D.C. Códigos DANE de 2 dígitos. */
const DEPARTAMENTOS = [
    ['05', 'Antioquia'],
    ['08', 'Atlántico'],
    ['11', 'Bogotá, D.C.'],
    ['13', 'Bolívar'],
    ['15', 'Boyacá'],
    ['17', 'Caldas'],
    ['18', 'Caquetá'],
    ['19', 'Cauca'],
    ['20', 'Cesar'],
    ['23', 'Córdoba'],
    ['25', 'Cundinamarca'],
    ['27', 'Chocó'],
    ['41', 'Huila'],
    ['44', 'La Guajira'],
    ['47', 'Magdalena'],
    ['50', 'Meta'],
    ['52', 'Nariño'],
    ['54', 'Norte de Santander'],
    ['63', 'Quindío'],
    ['66', 'Risaralda'],
    ['68', 'Santander'],
    ['70', 'Sucre'],
    ['73', 'Tolima'],
    ['76', 'Valle del Cauca'],
    ['81', 'Arauca'],
    ['85', 'Casanare'],
    ['86', 'Putumayo'],
    ['88', 'Archipiélago de San Andrés, Providencia y Santa Catalina'],
    ['91', 'Amazonas'],
    ['94', 'Guainía'],
    ['95', 'Guaviare'],
    ['97', 'Vaupés'],
    ['99', 'Vichada'],
];

/**
 * Catálogo mínimo de impuestos. La TARIFA que aplica cada negocio la decide su contador; esto
 * solo es la lista de valores válidos.
 *
 * `04` es el impuesto nacional al consumo — el 8% de los restaurantes. NO es IVA, y confundirlos
 * es el error tributario más fácil de cometer en este dominio.
 */
const IMPUESTOS = [
    ['01', 'IVA', 19.0, 'Tarifa general'],
    ['01', 'IVA', 5.0, 'Tarifa diferencial'],
    ['01', 'IVA', 0.0, 'Exento (tarifa 0%, da derecho a descontables)'],
    ['04', 'INC', 8.0, 'Impuesto nacional al consumo — restaurantes y bares'],
    ['ZZ', 'No causa', 0.0, 'Excluido o no sujeto'],
];

/** Las columnas fiscales que se añaden a cada tabla de producto de las verticales. */
const TABLAS_PRODUCTO = [
    ['restaurante', 'carta_producto'],
    ['tienda', 'tienda_producto'],
    ['gym', 'gym_producto'],
    ['gym', 'gym_plan'],
    ['reserva', 'reserva_servicio'],
    ['parqueadero', 'parq_tarifa'],
];

async function existeTabla(esquema, tabla, t) {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema = :esquema AND table_name = :tabla LIMIT 1;`,
        {
            replacements: { esquema, tabla },
            transaction: t,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return filas.length > 0;
}

async function existeColumna(esquema, tabla, columna, t) {
    const filas = await Models.sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna LIMIT 1;`,
        {
            replacements: { esquema, tabla, columna },
            transaction: t,
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. Esquema facturacion...');
        await Models.sequelize.query('CREATE SCHEMA IF NOT EXISTS facturacion;', { transaction: t });

        // ── Catálogo de departamentos ────────────────────────────────────────────────────────
        console.log('2. general.gener_departamento (catálogo DANE)...');
        await Models.sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS general.gener_departamento (
                codigo  char(2)      PRIMARY KEY,
                nombre  varchar(100) NOT NULL
            );
            `,
            { transaction: t }
        );

        for (const [codigo, nombre] of DEPARTAMENTOS) {
            await Models.sequelize.query(
                `INSERT INTO general.gener_departamento (codigo, nombre)
                 VALUES (:codigo, :nombre)
                 ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre;`,
                { replacements: { codigo, nombre }, transaction: t }
            );
        }
        console.log(`   ${DEPARTAMENTOS.length} departamentos.`);

        // ── Catálogo de impuestos ────────────────────────────────────────────────────────────
        console.log('3. facturacion.fe_impuesto (catálogo)...');
        await Models.sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS facturacion.fe_impuesto (
                id_impuesto  serial       PRIMARY KEY,

                -- Código del tributo según la DIAN: 01 IVA, 04 INC, ZZ no causa.
                codigo       varchar(4)   NOT NULL,
                nombre       varchar(60)  NOT NULL,
                tarifa       numeric(5,2) NOT NULL,
                descripcion  text,
                estado       char(1)      NOT NULL DEFAULT 'A',

                CONSTRAINT chk_fe_impuesto_estado CHECK (estado IN ('A','I')),
                CONSTRAINT chk_fe_impuesto_tarifa CHECK (tarifa >= 0 AND tarifa <= 100),
                CONSTRAINT uq_fe_impuesto_codigo_tarifa UNIQUE (codigo, tarifa)
            );
            `,
            { transaction: t }
        );

        for (const [codigo, nombre, tarifa, descripcion] of IMPUESTOS) {
            await Models.sequelize.query(
                `INSERT INTO facturacion.fe_impuesto (codigo, nombre, tarifa, descripcion)
                 VALUES (:codigo, :nombre, :tarifa, :descripcion)
                 ON CONFLICT (codigo, tarifa) DO NOTHING;`,
                { replacements: { codigo, nombre, tarifa, descripcion }, transaction: t }
            );
        }
        console.log(`   ${IMPUESTOS.length} impuestos.`);

        // ── Identidad fiscal del negocio ─────────────────────────────────────────────────────
        //
        // Va en `general` y no en `facturacion` a propósito: es identidad del inquilino, y la
        // necesitamos aunque ese negocio no emita jamás un documento — porque el que le factura
        // la mensualidad somos nosotros. Ver docs/obligaciones-escalapp.md §1.
        console.log('4. general.gener_negocio_fiscal...');
        await Models.sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS general.gener_negocio_fiscal (
                id_negocio       integer PRIMARY KEY
                                 REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,

                -- ── El interruptor. NINGUNO = exactamente el comportamiento de hoy. ──
                modo_facturacion varchar(10) NOT NULL DEFAULT 'NINGUNO',

                -- ── Lo declara el cliente. No lo deducimos: no es nuestra decisión. ──
                --
                -- ¿Está registrado el negocio? 'NO_DECLARADO' no es lo mismo que 'SIN_REGISTRO':
                -- al primero hay que preguntarle, al segundo NO hay que volver a molestarlo.
                estado_registro     varchar(15) NOT NULL DEFAULT 'NO_DECLARADO',
                obligado_a_facturar boolean,
                declarado_por       integer REFERENCES general.gener_usuario(id_usuario),
                declarado_en        timestamptz,

                -- ── Identificación ──
                -- '1' jurídica (SIEMPRE obligada a facturar) · '2' natural (depende de umbrales)
                tipo_persona     char(1),
                -- Código DIAN del tipo de documento: 31 NIT, 13 cédula, 41 pasaporte…
                tipo_documento   varchar(2),
                -- Normalizado: solo dígitos, SIN puntos, SIN guiones y SIN el DV.
                numero_documento varchar(20),
                -- Dígito de verificación. Se calcula, pero hay que contrastarlo con el RUT:
                -- si no cuadra, la DIAN rechaza el documento.
                dv               char(1),

                -- ── Nombre ──
                -- razon_social es la del RUT, NO el nombre comercial.
                razon_social     varchar(255),
                nombre_comercial varchar(255),
                -- La DIAN pide el nombre de una persona natural partido en cuatro, no en uno.
                primer_apellido  varchar(100),
                segundo_apellido varchar(100),
                primer_nombre    varchar(100),
                otros_nombres    varchar(100),

                -- ── Régimen ──
                -- Códigos del RUT: O-13 gran contribuyente, O-15 autorretenedor,
                -- O-23 agente de retención de IVA, O-47 régimen simple, R-99-PN no aplica.
                responsabilidades_fiscales varchar(20)[],
                -- Tributos que causa: 01 IVA, 04 INC, ZZ no causa.
                tributos           varchar(4)[],
                responsable_iva    boolean NOT NULL DEFAULT false,
                responsable_inc    boolean NOT NULL DEFAULT false,
                regimen            varchar(20),
                -- Determina desde cuándo estaba obligado según el calendario de 2024.
                tipo_contribuyente varchar(30),
                actividad_ciiu     varchar(10),
                matricula_mercantil varchar(50),

                -- ── Domicilio fiscal ──
                direccion_fiscal  varchar(255),
                -- Código DANE de 5 dígitos. 'Medellín' no es un dato válido; '05001' sí.
                -- Sin FK: el catálogo completo llega en FE-2 desde el proveedor.
                municipio_dane    char(5),
                departamento_dane char(2) REFERENCES general.gener_departamento(codigo),
                pais              char(2) NOT NULL DEFAULT 'CO',
                codigo_postal     varchar(10),

                -- ── Contacto de facturación ──
                -- NO es gener_negocio.email_contacto: ese es comercial, este suele ser el del contador.
                correo_facturacion   varchar(255),
                telefono_facturacion varchar(30),

                creado_en      timestamptz NOT NULL DEFAULT now(),
                actualizado_en timestamptz NOT NULL DEFAULT now(),

                CONSTRAINT chk_negfiscal_modo
                    CHECK (modo_facturacion IN ('NINGUNO','POS','COMPLETO')),
                CONSTRAINT chk_negfiscal_estado_registro
                    CHECK (estado_registro IN ('NO_DECLARADO','SIN_REGISTRO','REGISTRADO')),
                -- El invariante: un negocio sin registro no tiene RUT ni resolución, así que no
                -- puede emitir NADA. Vive en la base para que ningún camino de escritura —panel,
                -- script, migración futura— pueda saltárselo por olvido.
                CONSTRAINT chk_negfiscal_modo_requiere_registro
                    CHECK (modo_facturacion = 'NINGUNO' OR estado_registro = 'REGISTRADO'),
                CONSTRAINT chk_negfiscal_tipo_persona
                    CHECK (tipo_persona IS NULL OR tipo_persona IN ('1','2')),
                CONSTRAINT chk_negfiscal_dv
                    CHECK (dv IS NULL OR dv ~ '^[0-9]$'),
                CONSTRAINT chk_negfiscal_documento
                    CHECK (numero_documento IS NULL OR numero_documento ~ '^[0-9]+$'),
                CONSTRAINT chk_negfiscal_municipio
                    CHECK (municipio_dane IS NULL OR municipio_dane ~ '^[0-9]{5}$'),
                CONSTRAINT chk_negfiscal_regimen
                    CHECK (regimen IS NULL OR regimen IN ('ORDINARIO','SIMPLE')),
                CONSTRAINT chk_negfiscal_tipo_contrib
                    CHECK (tipo_contribuyente IS NULL OR tipo_contribuyente IN
                           ('GRAN_CONTRIBUYENTE','DECLARANTE','NO_DECLARANTE'))
            );
            `,
            { transaction: t }
        );

        // La tabla ya existía en las dos bases de desarrollo antes de que `estado_registro`
        // existiera, y `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya está. Así que la
        // columna y sus dos invariantes se añaden aparte, comprobando antes si hacen falta.
        console.log('4b. estado_registro (negocios sin registrar)...');
        if (!(await existeColumna('general', 'gener_negocio_fiscal', 'estado_registro', t))) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio_fiscal
                     ADD COLUMN estado_registro varchar(15) NOT NULL DEFAULT 'NO_DECLARADO';`,
                { transaction: t }
            );
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio_fiscal
                     ADD CONSTRAINT chk_negfiscal_estado_registro
                     CHECK (estado_registro IN ('NO_DECLARADO','SIN_REGISTRO','REGISTRADO'));`,
                { transaction: t }
            );
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio_fiscal
                     ADD CONSTRAINT chk_negfiscal_modo_requiere_registro
                     CHECK (modo_facturacion = 'NINGUNO' OR estado_registro = 'REGISTRADO');`,
                { transaction: t }
            );
            console.log('   Columna y los dos CHECK añadidos.');
        } else {
            console.log('   Ya estaba.');
        }

        // Buscar un negocio por su NIT normalizado es la consulta que hará el panel y la que
        // usaremos para facturarle. Único parcial: dos negocios no pueden compartir documento,
        // pero muchos pueden tenerlo en NULL mientras no lo hayan cargado.
        await Models.sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_negfiscal_documento
                 ON general.gener_negocio_fiscal (tipo_documento, numero_documento)
              WHERE numero_documento IS NOT NULL;`,
            { transaction: t }
        );

        // ── Fila para cada negocio existente, en modo NINGUNO ────────────────────────────────
        //
        // Se crea la fila (no se deja ausente) para que leer la configuración sea siempre un
        // SELECT que devuelve algo, y no un "si no hay fila, asume el defecto" repartido por el
        // código. El defecto vive en un sitio: la columna.
        console.log('5. Sembrando una fila por negocio, en modo NINGUNO...');
        await Models.sequelize.query(
            `
            INSERT INTO general.gener_negocio_fiscal (id_negocio)
            SELECT n.id_negocio
              FROM general.gener_negocio n
             WHERE NOT EXISTS (
                 SELECT 1 FROM general.gener_negocio_fiscal f WHERE f.id_negocio = n.id_negocio
             );
            `,
            { transaction: t }
        );

        // El `nit` que ya existe NO se copia. Viene de un campo de texto libre: trae puntos,
        // guiones y a veces el DV pegado, y no hay forma de saber cuál de esos dígitos es el DV
        // sin contrastarlo con el RUT. Migrarlo automáticamente sería inventar un dato fiscal.
        // Aquí solo se cuenta cuántos habrá que capturar a mano desde el panel.
        const conNit = await Models.sequelize.query(
            `SELECT count(*)::int AS n FROM general.gener_negocio
              WHERE nit IS NOT NULL AND btrim(nit) <> '';`,
            { transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );

        // ── Impuestos por línea en las verticales ────────────────────────────────────────────
        console.log('6. Columnas de impuesto en las tablas de producto...');
        for (const [esquema, tabla] of TABLAS_PRODUCTO) {
            if (!(await existeTabla(esquema, tabla, t))) {
                console.log(`   ${esquema}.${tabla} — no existe en esta base, se omite.`);
                continue;
            }

            const columnas = [
                ['codigo_impuesto', 'varchar(4)'],
                ['tarifa_impuesto', 'numeric(5,2)'],
                ['unidad_medida_dian', 'varchar(10)'],
                ['codigo_producto', 'varchar(50)'],
            ];

            let añadidas = 0;
            for (const [columna, tipo] of columnas) {
                if (await existeColumna(esquema, tabla, columna, t)) continue;
                await Models.sequelize.query(
                    `ALTER TABLE ${esquema}.${tabla} ADD COLUMN ${columna} ${tipo};`,
                    { transaction: t }
                );
                añadidas++;
            }
            console.log(
                `   ${esquema}.${tabla} — ${añadidas === 0 ? 'ya estaban' : `${añadidas} columnas`}`
            );
        }

        const negocios = await Models.sequelize.query(
            `SELECT count(*)::int AS n FROM general.gener_negocio_fiscal;`,
            { transaction: t, type: Models.sequelize.QueryTypes.SELECT }
        );

        await t.commit();

        console.log('\n=== FE-1 listo ===');
        console.log(`   Negocios con ficha fiscal: ${negocios[0].n} (todos en modo NINGUNO)`);
        console.log(`   Negocios con algún NIT cargado hoy: ${conNit[0].n}`);
        console.log('   → Ese NIT NO se copió: es texto libre y sin DV. Hay que capturarlo');
        console.log('     contra el RUT desde el panel, no adivinarlo. Ver docs §5.2.');
        console.log('\n   Nada cambia para ningún negocio hasta que alguien ponga modo POS o COMPLETO.');
        console.log('✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

migrate()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('Falló la migración:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
