/**
 * Permisos **por acción** dentro de cada vista del vertical `reserva`.
 *
 * Hasta ahora el permiso más fino que existía era «ve la vista o no la ve». Eso deja fuera el
 * caso normal de un salón: la recepcionista **debe** poder agendar y confirmar, y **no** debería
 * poder cancelar una cita ya cobrada ni cerrar la caja. Con solo el interruptor de la vista hay
 * que elegir entre darle todo Citas o quitárselo entero.
 *
 * ## Cómo se modela (no se inventa nada)
 *
 * `gener_tipo_nivel` ya define el tipo **4 — «Operación específica dentro de una vista»**. Un
 * subnivel es una fila de `gener_nivel` con `id_tipo_nivel = 4` y `id_nivel_padre` apuntando a
 * la vista. Su `url` es el **código** de la acción (`/citas/cancelar` → `citas_cancelar`), que es
 * lo que el frontend consulta. Los permisos viven en las mismas dos tablas de siempre:
 * `gener_rol_nivel` (plantilla del rol) y `gener_nivel_negocio` (ajuste de cada negocio).
 *
 * Es exactamente el mecanismo que `app_restaurante_api` ya consume; aquí solo se puebla el
 * catálogo del vertical de reservas.
 *
 * ## Qué se concede por defecto
 *
 * - **ADMINISTRADOR**: todo. Es el dueño.
 * - **RECEPCIONISTA**: el trabajo de mostrador —agendar, confirmar, cobrar, marcar inasistencia,
 *   mover la caja—. Se le niegan **cancelar** y **cerrar caja**: son las dos que borran dinero o
 *   cierran el día, y quien las necesite las recibe explícitamente.
 * - **PROFESIONAL**: nada. Solo mira su agenda; ya tiene sus tres vistas en solo lectura.
 *
 * Son valores de partida, no una política: cada negocio los ajusta desde Usuarios → Roles.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-subniveles
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const TIPO_NIVEL_ACCION = 4;

/**
 * Catálogo de acciones: [url de la vista, url de la acción, etiqueta, roles que la reciben].
 *
 * Solo se listan operaciones que **merecen una decisión**. Un botón que cualquiera con acceso a
 * la vista puede pulsar sin consecuencias no necesita permiso propio: multiplicar interruptores
 * que nadie va a tocar hace la pantalla de roles ilegible y no protege nada.
 */
const ACCIONES = [
    // Agenda
    ['/agenda', '/agenda/crear-cita', 'Agendar cita desde la agenda', ['ADMINISTRADOR', 'RECEPCIONISTA']],
    ['/agenda', '/agenda/cobrar', 'Completar y cobrar desde la agenda', ['ADMINISTRADOR', 'RECEPCIONISTA']],

    // Citas
    ['/citas', '/citas/crear', 'Agendar cita', ['ADMINISTRADOR', 'RECEPCIONISTA']],
    ['/citas', '/citas/confirmar', 'Confirmar cita', ['ADMINISTRADOR', 'RECEPCIONISTA']],
    ['/citas', '/citas/completar', 'Completar y cobrar', ['ADMINISTRADOR', 'RECEPCIONISTA']],
    ['/citas', '/citas/cancelar', 'Cancelar cita', ['ADMINISTRADOR']],
    ['/citas', '/citas/no-show', 'Marcar inasistencia', ['ADMINISTRADOR', 'RECEPCIONISTA']],
    ['/citas', '/citas/validar-pago', 'Validar pago adelantado', ['ADMINISTRADOR']],

    // Caja
    ['/caja', '/caja/abrir', 'Abrir caja', ['ADMINISTRADOR', 'RECEPCIONISTA']],
    ['/caja', '/caja/cerrar', 'Cerrar caja', ['ADMINISTRADOR']],
    ['/caja', '/caja/movimiento', 'Registrar ingresos y egresos', ['ADMINISTRADOR', 'RECEPCIONISTA']],

    // Horarios
    ['/horarios', '/horarios/editar', 'Editar el horario semanal', ['ADMINISTRADOR']],
    ['/horarios', '/horarios/bloqueos', 'Crear y quitar bloqueos', ['ADMINISTRADOR', 'RECEPCIONISTA']],

    // Configuración
    ['/configuracion', '/configuracion/cobros', 'Cambiar los ajustes de cobro y caja', ['ADMINISTRADOR']],
    ['/configuracion', '/configuracion/metodos-pago', 'Gestionar las formas de pago', ['ADMINISTRADOR']],
];

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: permisos por acción (reserva) ===\n');

        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        const idTipo = tipo.id_tipo_negocio;
        console.log(`1. Tipo RESERVA = ${idTipo}`);

        // El tipo de nivel 4 debe existir; lo crea `migrate_niveles`.
        const [[tipoNivel]] = await sequelize.query(`
            SELECT id_tipo_nivel FROM general.gener_tipo_nivel WHERE id_tipo_nivel = :t;
        `, { replacements: { t: TIPO_NIVEL_ACCION }, transaction: t });
        if (!tipoNivel) throw new Error('No existe gener_tipo_nivel = 4. Ejecuta antes `npm run migrate:niveles`.');

        // Vistas del vertical, por url, para colgar de ellas las acciones.
        const vistas = await sequelize.query(`
            SELECT id_nivel, url FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url IS NOT NULL;
        `, { replacements: { tipo: idTipo }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const vistaPorUrl = new Map(vistas.map(v => [v.url, v.id_nivel]));
        console.log(`2. Vistas encontradas: ${vistas.length}`);

        console.log('3. Insertando acciones...');
        let nuevas = 0, omitidas = 0;
        for (const [urlVista, urlAccion, etiqueta] of ACCIONES) {
            const idPadre = vistaPorUrl.get(urlVista);
            if (!idPadre) {
                // Una vista que aún no existe (p. ej. si falta su migración) no debe tumbar el
                // resto del catálogo: se omite y se avisa.
                console.log(`   ⚠️  ${urlVista} no existe — se omite ${urlAccion}`);
                omitidas++;
                continue;
            }
            const [res] = await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, NULL, 'A', :tn, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn AND url = :url
                )
                RETURNING id_nivel;
            `, {
                replacements: { desc: etiqueta, padre: idPadre, url: urlAccion, tipo: idTipo, tn: TIPO_NIVEL_ACCION },
                transaction: t,
            });
            if (res.length > 0) nuevas++;
        }
        console.log(`   OK — ${nuevas} nueva(s), ${omitidas} omitida(s)\n`);

        // Ids reales de las acciones ya creadas.
        const accionesBD = await sequelize.query(`
            SELECT id_nivel, url FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const accionPorUrl = new Map(accionesBD.map(a => [a.url, a.id_nivel]));

        const roles = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipo }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolPorNombre = new Map(roles.map(r => [r.descripcion, r.id_rol]));

        console.log('4. Concediendo acciones por rol...');
        let concedidas = 0;
        for (const [, urlAccion, , rolesConcedidos] of ACCIONES) {
            const idNivel = accionPorUrl.get(urlAccion);
            if (!idNivel) continue;
            for (const nombreRol of rolesConcedidos) {
                const idRol = rolPorNombre.get(nombreRol);
                if (!idRol) continue;
                const [res] = await sequelize.query(`
                    INSERT INTO general.gener_rol_nivel
                        (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
                    VALUES (:rol, :nivel, true, false, false, false, 'A')
                    ON CONFLICT (id_rol, id_nivel) DO NOTHING
                    RETURNING id_rol;
                `, { replacements: { rol: idRol, nivel: idNivel }, transaction: t });
                concedidas += res.length;
            }
        }
        console.log(`   OK — ${concedidas} concesión(es) nuevas\n`);

        // Backfill por negocio.
        //
        // `gener_nivel_negocio` filtra: un negocio que ya tenga ajustes propios y no incluya
        // estas filas dejaría a todo el mundo sin ninguna acción. Se siembra con lo que dice la
        // plantilla del rol, que es el estado que el negocio tenía de hecho hasta ahora.
        console.log('5. Backfill gener_nivel_negocio...');
        const [backfill] = await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.estado = 'A'
            JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                        AND niv.id_tipo_negocio = :tipo
                                        AND niv.id_tipo_nivel = :tn
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION }, transaction: t });
        console.log(`   OK — ${backfill.length} fila(s) nuevas\n`);

        await t.commit();

        const resumen = await sequelize.query(`
            SELECT r.descripcion AS rol, COUNT(*) FILTER (WHERE rn.puede_ver) AS acciones
            FROM general.gener_rol_nivel rn
            JOIN general.gener_rol r ON r.id_rol = rn.id_rol
            JOIN general.gener_nivel n ON n.id_nivel = rn.id_nivel
            WHERE n.id_tipo_negocio = :tipo AND n.id_tipo_nivel = :tn
            GROUP BY r.descripcion ORDER BY r.descripcion;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION }, type: sequelize.QueryTypes.SELECT });

        console.log('=== Resultado ===');
        console.log(`   Acciones en el catálogo: ${accionPorUrl.size}`);
        resumen.forEach(r => console.log(`   ${r.rol}: ${r.acciones} acción(es)`));
        console.log('\nMigración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
