/**
 * Migración: el módulo `/promociones` y su permiso (F1 de `docs/promociones-masivas.md`).
 *
 * No crea ninguna tabla: F1 no guarda nada nuevo —la audiencia sale de `persona_negocio` y de los
 * pedidos que ya están—. Lo único que hace falta es que el módulo **exista** en la matriz de
 * permisos, porque sin fila en `gener_nivel` el menú no lo pinta y `canAccessRoute('/promociones')`
 * dice no. Es el mismo trámite que hizo `migrate:restaurante-cuentas` para `/clientes`.
 *
 * ## Nace CERRADO para TODOS, y se enciende negocio por negocio
 *
 * Una promoción **gasta dinero del negocio** —el de Meta a su tarjeta y, desde F3, créditos
 * nuestros— y manda publicidad por su número. Así que no es una pantalla de operación (no la ve el
 * mesero ni el cajero) **y tampoco es algo que el dueño se pueda dar a sí mismo**: la enciende
 * EscalApp, negocio por negocio, mientras esto sea un piloto.
 *
 * Eso son dos candados distintos y los pone los dos:
 *
 *   1. `gener_negocio.permite_promociones` — la **lista blanca**. Nace en `false` para todos, y se
 *      pone en `true` solo para el negocio del piloto. Es lo que lee `app_core/promociones/
 *      habilitado.js`, y lo que cierra la API con un 403 aunque alguien tenga el permiso puesto.
 *   2. La matriz de permisos — **qué rol** lo ve dentro de ese negocio. Solo ADMINISTRADOR.
 *
 * ## ⚠️ Por qué el permiso NO se siembra en `gener_rol_nivel` con `puede_ver = true`
 *
 * Porque `gener_rol_nivel` es la plantilla **del tipo de negocio**, compartida por todos los
 * restaurantes: encenderlo ahí lo enciende para los cinco. Y hay un camino peor que ese, que es el
 * que decide la forma de esta migración: `usuarioAdminDao.getPermisosRol` **siembra sola** la fila
 * que falta en `gener_nivel_negocio` con el valor de la plantilla la primera vez que alguien abre
 * «Roles y permisos». Con la plantilla en `true`, a cualquier restaurante le aparecería el módulo
 * por el simple hecho de que su dueño entró a mirar los permisos de su personal. Nadie lo habría
 * decidido.
 *
 * Así que la plantilla queda explícitamente en `false` —la fila existe, para que el módulo se vea
 * en la matriz y se pueda conceder a mano el día que toque— y el `true` se escribe **solo** en el
 * `gener_nivel_negocio` del negocio del piloto.
 *
 * ## Se siembra `promociones_enviar` aunque F1 no lo use todavía
 *
 * Es deliberado y es por la trampa de los subniveles que ya costó una vez: **«ausente» se lee como
 * «denegado» en la sesión viva**, así que un subnivel que llega con el frontend que lo necesita
 * aparece denegado para todo el mundo hasta que alguien vuelva a entrar. Sembrarlo ahora, con el
 * módulo, hace que el día del envío (F2) no haya que coordinar migración y despliegue del frontend.
 *
 * La separación en dos permisos tiene sentido desde ya: **ver** la clientela y sus segmentos es
 * información del negocio; **enviar** es gastar. Un encargado puede necesitar lo primero sin tener
 * lo segundo.
 *
 * ## Solo restaurante, por ahora
 *
 * El backend ya es transversal (`app_core/promociones/hechos/` tiene adaptador de reserva), pero
 * reserva tiene **su propio frontend** (`reserva_app`), así que su módulo se siembra el día que
 * tenga pantalla. Sembrarlo ahora pondría en su menú un enlace a una vista que no existe.
 *
 * Idempotente: todo con `WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING`, en una transacción.
 * Registrada como `npm run migrate:promociones-modulo`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;

/**
 * El único negocio al que se le enciende, por NOMBRE y nunca por id: `id_negocio` no vale lo mismo
 * en desarrollo que en producción, y resolver por id es el fallo que ya costó una vez (CLAUDE.md).
 * Es el restaurante con el que EscalApp se prueba a sí misma — el que atiende el número de la
 * plataforma—, así que el piloto sale por nuestro número y lo pagamos nosotros.
 *
 * Si no está en esta base, la migración lo dice y sigue: deja el módulo sembrado y cerrado para
 * todos, que es el estado correcto mientras nadie lo encienda.
 */
const NEGOCIO_PILOTO = 'Restaurante pregonchos';

const URL_MODULO = '/promociones';
const DESCRIPCION_MODULO = 'PROMOCIONES';
/** Icono de `lucide` que pinta el menú de `negocio_app`. */
const ICONO = 'megaphone';

const SUBNIVELES = [
    {
        codigo: 'promociones_enviar',
        descripcion: 'Enviar promociones (gasta dinero del negocio)',
    },
];

/**
 * Cuántas filas tocó una escritura.
 *
 * Existe porque `sequelize.query` no devuelve lo mismo según el dialecto y el tipo de sentencia:
 * con `pg` un INSERT/UPDATE crudo devuelve `[filas, n]` —el segundo es un **número**—, mientras que
 * otras rutas devuelven el `Result` completo con `rowCount` dentro. Leer solo `meta.rowCount` daba
 * `undefined`, y con el `?? 0` de rigor la migración imprimía «0 filas» mientras cambiaba 22. Un
 * log que miente en una migración es peor que no tenerlo: se da por bueno un estado que no se
 * comprobó.
 */
function filasTocadas(resultado) {
    if (!Array.isArray(resultado)) return 0;
    const meta = resultado[1];
    if (typeof meta === 'number') return meta;
    return Number(meta?.rowCount ?? 0) || 0;
}

async function unaFila(sql, replacements, transaction) {
    const filas = await sequelize.query(sql, {
        replacements,
        type: sequelize.QueryTypes.SELECT,
        transaction,
    });
    return filas?.[0] ?? null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Promociones — módulo y permisos\n');

        // Por NOMBRE y nunca por id: `id_tipo_negocio` no vale lo mismo en desarrollo que en
        // producción (CLAUDE.md), y ya costó un fallo.
        const tipo = await unaFila(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio
              WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
              ORDER BY id_tipo_negocio LIMIT 1;`,
            {},
            t,
        );
        if (!tipo) throw new Error('No se encontró el tipo de negocio RESTAURANTE.');
        const idTipoNegocio = Number(tipo.id_tipo_negocio);

        // ── 0. La lista blanca ──────────────────────────────────────────────────────────────
        console.log('0. Columna gener_negocio.permite_promociones...');
        await sequelize.query(
            `ALTER TABLE general.gener_negocio
               ADD COLUMN IF NOT EXISTS permite_promociones BOOLEAN NOT NULL DEFAULT false;`,
            { transaction: t },
        );
        await sequelize.query(
            `COMMENT ON COLUMN general.gener_negocio.permite_promociones IS
             'Lista blanca de las promociones masivas. Lo enciende EscalApp, no el dueño: apagado, el módulo no existe para el negocio (ni menú, ni API, ni campaña en curso).';`,
            { transaction: t },
        );
        console.log('   ✓');

        console.log('1. Sembrando el módulo /promociones...');
        const nivelRaiz = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = '/restaurante'
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio },
            t,
        );

        await sequelize.query(
            `INSERT INTO general.gener_nivel
                 (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
             SELECT :descripcion, :idNivelPadre, :icono, 'A', 1, :idTipoNegocio, :url, CURRENT_TIMESTAMP
              WHERE NOT EXISTS (
                  SELECT 1 FROM general.gener_nivel
                   WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
              );`,
            {
                replacements: {
                    descripcion: DESCRIPCION_MODULO,
                    icono: ICONO,
                    idTipoNegocio,
                    url: URL_MODULO,
                    idNivelPadre: nivelRaiz ? nivelRaiz.id_nivel : null,
                },
                transaction: t,
            },
        );
        console.log('   ✓');

        console.log('2. Sembrando el subnivel de acción...');
        const tipoAccion = await unaFila(
            `SELECT id_tipo_nivel FROM general.gener_tipo_nivel
              WHERE estado = 'A' AND UPPER(nombre) = 'ACCION' ORDER BY id_tipo_nivel LIMIT 1;`,
            {},
            t,
        );
        if (!tipoAccion) throw new Error('No se encontró el tipo de nivel ACCION.');
        const idTipoNivelAccion = Number(tipoAccion.id_tipo_nivel);

        const modulo = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio, url: URL_MODULO },
            t,
        );

        for (const sub of SUBNIVELES) {
            await sequelize.query(
                `INSERT INTO general.gener_nivel
                     (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
                 SELECT :descripcion, :idNivelPadre, NULL, 'A', :idTipoNivelAccion, :idTipoNegocio, :codigo, CURRENT_TIMESTAMP
                  WHERE NOT EXISTS (
                      SELECT 1 FROM general.gener_nivel
                       WHERE id_tipo_negocio = :idTipoNegocio
                         AND id_tipo_nivel = :idTipoNivelAccion
                         AND url = :codigo
                  );`,
                {
                    replacements: {
                        descripcion: sub.descripcion,
                        idNivelPadre: Number(modulo.id_nivel),
                        idTipoNivelAccion,
                        idTipoNegocio,
                        codigo: sub.codigo,
                    },
                    transaction: t,
                },
            );
        }
        console.log('   ✓');

        // ── 3. La plantilla del rol: la fila existe, y vale `false` ─────────────────────────
        //
        // Ver la cabecera. La fila hace que el módulo se vea en «Roles y permisos» —y por tanto se
        // pueda conceder a mano— sin que nadie lo tenga encendido por omisión. Y el `UPDATE`
        // después del `INSERT` porque esta migración ya corrió una vez en desarrollo concediéndolo
        // en `true`: idempotente quiere decir que **converge** al estado correcto, no solo que no
        // repite el insert.
        console.log('3. Plantilla del rol ADMINISTRADOR, cerrada...');
        await sequelize.query(
            `INSERT INTO general.gener_rol_nivel
                 (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado,
                  fecha_creacion, fecha_actualizacion)
             SELECT r.id_rol, nv.id_nivel, false, false, false, false, 'A',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
               FROM general.gener_rol r
               JOIN general.gener_nivel nv
                 ON nv.id_tipo_negocio = r.id_tipo_negocio
                AND nv.estado = 'A'
                AND nv.url IN (:urls)
              WHERE r.id_tipo_negocio = :idTipoNegocio
                AND r.estado = 'A'
                AND UPPER(r.descripcion) = 'ADMINISTRADOR'
             ON CONFLICT (id_rol, id_nivel) DO NOTHING;`,
            {
                replacements: {
                    idTipoNegocio,
                    urls: [URL_MODULO, ...SUBNIVELES.map((sub) => sub.codigo)],
                },
                transaction: t,
            },
        );
        const res3 = await sequelize.query(
            `UPDATE general.gener_rol_nivel rn
                SET puede_ver = false, puede_crear = false, puede_editar = false,
                    puede_eliminar = false, fecha_actualizacion = CURRENT_TIMESTAMP
               FROM general.gener_nivel nv
              WHERE nv.id_nivel = rn.id_nivel
                AND nv.id_tipo_negocio = :idTipoNegocio
                AND nv.url IN (:urls)
                AND (rn.puede_ver OR rn.puede_crear OR rn.puede_editar OR rn.puede_eliminar);`,
            {
                replacements: {
                    idTipoNegocio,
                    urls: [URL_MODULO, ...SUBNIVELES.map((sub) => sub.codigo)],
                },
                transaction: t,
            },
        );
        console.log(`   ✓ (${filasTocadas(res3)} fila(s) que estaban abiertas, cerradas)`);

        // ── 4. El negocio del piloto: la lista blanca y su permiso ──────────────────────────
        console.log(`4. Encendiendo solo «${NEGOCIO_PILOTO}»...`);
        let encendido = null;
        const piloto = await unaFila(
            `SELECT id_negocio, nombre FROM general.gener_negocio
              WHERE estado = 'A' AND id_tipo_negocio = :idTipoNegocio
                AND lower(trim(nombre)) = lower(trim(:nombre))
              ORDER BY id_negocio LIMIT 1;`,
            { idTipoNegocio, nombre: NEGOCIO_PILOTO },
            t,
        );

        if (!piloto) {
            console.log(
                `   ⚠ No existe un restaurante activo llamado «${NEGOCIO_PILOTO}» en esta base. `
                + 'El módulo queda sembrado y cerrado para todos, que es lo correcto.',
            );
        } else {
            encendido = String(piloto.nombre);
            const idPiloto = Number(piloto.id_negocio);

            await sequelize.query(
                `UPDATE general.gener_negocio SET permite_promociones = true
                  WHERE id_negocio = :idPiloto;`,
                { replacements: { idPiloto }, transaction: t },
            );

            // ⚠️ La trampa de `gener_nivel_negocio`, que es la razón de este bloque entero: cuando
            // un negocio tiene ajustes propios, esa tabla **manda como lista blanca** y la
            // plantilla del rol se filtra por ella (`dashboardService.getPermisosVistaNegocio`).
            // Consecuencia: a un negocio que NO tenga ninguna fila no se le puede conceder una
            // vista metiéndole una sola, porque esa única fila pasaría a ser su lista blanca entera
            // y le quitaría del menú todo lo demás. Así que si no tiene ajustes se materializa
            // primero lo que hoy ve, y después se añade el módulo.
            const tieneAjustes = await unaFila(
                `SELECT 1 AS si FROM general.gener_nivel_negocio
                  WHERE id_negocio = :idPiloto LIMIT 1;`,
                { idPiloto },
                t,
            );

            if (!tieneAjustes) {
                console.log('   · sin ajustes propios: materializando su matriz actual primero');
                await sequelize.query(
                    `INSERT INTO general.gener_nivel_negocio
                         (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion,
                          fecha_actualizacion)
                     SELECT :idPiloto, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                       FROM general.gener_rol_nivel rn
                       JOIN general.gener_rol r
                         ON r.id_rol = rn.id_rol
                        AND r.estado = 'A'
                        AND r.id_tipo_negocio = :idTipoNegocio
                       JOIN general.gener_nivel nv
                         ON nv.id_nivel = rn.id_nivel
                        AND nv.estado = 'A'
                        AND nv.id_tipo_negocio = :idTipoNegocio
                      WHERE rn.estado = 'A'
                     ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;`,
                    { replacements: { idPiloto, idTipoNegocio }, transaction: t },
                );
            }

            await sequelize.query(
                `INSERT INTO general.gener_nivel_negocio
                     (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion,
                      fecha_actualizacion)
                 SELECT :idPiloto, r.id_rol, nv.id_nivel, true, 'A',
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                   FROM general.gener_rol r
                   JOIN general.gener_nivel nv
                     ON nv.id_tipo_negocio = r.id_tipo_negocio
                    AND nv.estado = 'A'
                    AND nv.url IN (:urls)
                  WHERE r.id_tipo_negocio = :idTipoNegocio
                    AND r.estado = 'A'
                    AND UPPER(r.descripcion) = 'ADMINISTRADOR'
                 ON CONFLICT (id_negocio, id_rol, id_nivel)
                 DO UPDATE SET puede_ver = true, estado = 'A',
                               fecha_actualizacion = CURRENT_TIMESTAMP;`,
                {
                    replacements: {
                        idPiloto,
                        idTipoNegocio,
                        urls: [URL_MODULO, ...SUBNIVELES.map((sub) => sub.codigo)],
                    },
                    transaction: t,
                },
            );
            console.log(`   ✓ id_negocio ${idPiloto} — ADMINISTRADOR ve /promociones`);
        }

        // ── 5. Y a los demás, cerrado y por escrito ─────────────────────────────────────────
        //
        // Para las vistas no haría falta —sin fila en `true` no la ven— pero la fila explícita en
        // `false` hace dos cosas que sí importan: deja dicho en la matriz que la opción existe y
        // está desactivada (lo que el dueño ve en «Roles y permisos» es entonces la verdad), y le
        // quita el trabajo a la siembra automática de `usuarioAdminDao`, que para un subnivel y un
        // rol ADMINISTRADOR lo pondría en `true` por su cuenta.
        //
        // `DO UPDATE` y no `DO NOTHING`, y esto lo encontró la base de desarrollo: ahí esta misma
        // migración ya había corrido en su primera versión, que **sí** lo concedía a todos, y nueve
        // restaurantes se habían quedado con el `true`. Un `DO NOTHING` los habría dejado así y la
        // migración habría dicho «✓». Lo que tiene que ser idempotente no es el INSERT: es el
        // ESTADO. El `WHERE puede_ver` del final es para no reescribir —ni auditar— las filas que
        // ya estaban en `false`.
        console.log('5. Dejando la opción desactivada en los demás restaurantes...');
        const res5 = await sequelize.query(
            `INSERT INTO general.gener_nivel_negocio
                 (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion,
                  fecha_actualizacion)
             SELECT n.id_negocio, r.id_rol, nv.id_nivel, false, 'A',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
               FROM general.gener_negocio n
               JOIN general.gener_rol r
                 ON r.id_tipo_negocio = n.id_tipo_negocio
                AND r.estado = 'A'
               JOIN general.gener_nivel nv
                 ON nv.id_tipo_negocio = n.id_tipo_negocio
                AND nv.estado = 'A'
                AND nv.url IN (:urls)
              WHERE n.estado = 'A'
                AND n.id_tipo_negocio = :idTipoNegocio
                AND n.permite_promociones = false
             ON CONFLICT (id_negocio, id_rol, id_nivel)
             DO UPDATE SET puede_ver = false, fecha_actualizacion = CURRENT_TIMESTAMP
                     WHERE general.gener_nivel_negocio.puede_ver;`,
            {
                replacements: {
                    idTipoNegocio,
                    urls: [URL_MODULO, ...SUBNIVELES.map((sub) => sub.codigo)],
                },
                transaction: t,
            },
        );
        console.log(`   ✓ (${filasTocadas(res5)} fila(s) de «desactivado» escritas o corregidas)`);

        await t.commit();
        console.log('\n✓ Módulo /promociones sembrado y CERRADO para todos.');
        console.log(
            encendido
                ? `  Encendido solo en «${encendido}», y solo para el rol ADMINISTRADOR.`
                : '  No se encendió en ninguno: aquí no existe el negocio del piloto.',
        );
        console.log('  Para encenderlo en otro negocio, el día que se decida:');
        console.log('    UPDATE general.gener_negocio SET permite_promociones = true WHERE id_negocio = N;');
        console.log('    ...y concederle la vista PROMOCIONES al rol en Usuarios -> Roles y permisos.');
        console.log('  Quien ya tenga sesión abierta tiene que volver a entrar para verlo.');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
