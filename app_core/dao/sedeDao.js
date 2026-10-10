'use strict';

const Models = require('../models/conection');
const { asegurarCajaPrincipal } = require('../helpers/cajaPrincipal');
const { initTransaction } = require('../helpers/funcionesAdicionales');
const { generarSlugUnico } = require('../helpers/slug');
const { clonarConfiguracion } = require('../sede/clonarConfiguracion');
const datosFiscales = require('../facturacion/datosFiscales');
const usuarioAdminDao = require('./usuarioAdminDao');
const negocioDao = require('./negocioDao');

/**
 * Sedes de un negocio.
 *
 * Una sede ES un negocio: tiene su `id_negocio`, su caja, su inventario, su personal y su plan.
 * Lo único que la distingue es `id_negocio_padre`, que dice de qué matriz cuelga. El aislamiento
 * entre inquilinos no cambia (ADR-002): sigue siendo por `id_negocio`, y la sede es un
 * `id_negocio` más. Ver `migrate:negocio-sede`.
 *
 * ## Qué hereda y qué no
 *
 * **Hereda de la matriz, sin preguntar:** el aplicativo y el rubro (una sede de una pizzería es
 * una pizzería — si pudiera ser de otro vertical no sería una sede), el país, la paleta, los
 * colores y los interruptores `permite_*` / `controla_inventario`. Son decisiones de la empresa,
 * no del local.
 *
 * **Propio de la sede:** nombre, dirección, teléfono, correo, slug (su URL pública), ficha
 * fiscal, caja y **plan**. El plan es propio a propósito: cada sede es un cliente pagador con su
 * propia vigencia, así que una puede estar al día y otra vencida.
 *
 * **Copiado al nacer y luego independiente:** la configuración del vertical (carta, servicios,
 * mesas, formas de pago, permisos por rol). Ver `app_core/sede/pasosDeClonado.js`.
 *
 * **No se copia nunca:** el personal, el stock, los movimientos de caja, los pedidos, los
 * clientes y el canal de WhatsApp. El personal porque son personas que trabajan en un local
 * concreto; el resto porque es historia de la matriz.
 *
 * ## Un solo nivel
 *
 * Una sede no puede tener sedes. No lo pide nadie y convertiría cada consulta de parentesco en
 * un recursivo. El `CHECK` de la migración impide que un negocio sea su propio padre; esto
 * impide el nieto.
 */

/** El negocio con lo que hace falta para decidir si puede ser matriz y qué hereda la sede. */
async function getMatriz(idNegocio, transaction = null) {
    const filas = await Models.sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.nit, n.id_negocio_padre, n.estado,
                n.id_tipo_negocio, n.id_rubro, n.pais, n.id_paleta, n.colores,
                n.permite_multipago, n.permite_pago_domicilio, n.permite_descuento,
                n.pregunta_cobro_envio, n.permite_cuentas_cliente, n.controla_inventario,
                n.asistente_mira_stock, n.muestra_iconos_productos, n.permite_domicilio_personal,
                t.nombre AS aplicativo
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
          WHERE n.id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, type: Models.sequelize.QueryTypes.SELECT, transaction },
    );
    return filas[0] || null;
}

/** Las sedes de una matriz, con su plan vigente. Vacío si no tiene ninguna. */
async function listarSedes(idNegocioPadre) {
    return Models.sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.direccion, n.telefono, n.email_contacto,
                n.slug, n.estado, n.fecha_registro,
                p.id_plan, pl.nombre AS plan_nombre, p.fecha_fin AS plan_fecha_fin
           FROM general.gener_negocio n
           LEFT JOIN general.gener_negocio_plan p
                  ON p.id_negocio = n.id_negocio AND p.estado = 'A'
           LEFT JOIN general.gener_plan pl ON pl.id_plan = p.id_plan
          WHERE n.id_negocio_padre = :idNegocioPadre
          ORDER BY n.nombre ASC;`,
        {
            replacements: { idNegocioPadre },
            type: Models.sequelize.QueryTypes.SELECT,
        },
    );
}

/**
 * Quién administra la matriz hoy.
 *
 * Es el modo por defecto al abrir una sede, y es el que casi siempre se quiere: el dueño que
 * administra la matriz administra también la sede nueva. Obligar a elegir un usuario o a crear
 * uno sería preguntar por algo que ya se sabe.
 *
 * Deja fuera al usuario del asistente (`ASISTENTE-%`, que no es una persona) y a quien tenga un
 * rol GLOBAL activo —el super administrador—, porque esos ya lo ven todo y ocuparían un sitio del
 * cupo de la sede sin necesidad.
 */
async function administradoresDe(idNegocio, idRolAdmin, transaction = null) {
    return Models.sequelize.query(
        `SELECT DISTINCT u.id_usuario
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_usuario u ON u.id_usuario = nu.id_usuario AND u.estado = 'A'
           JOIN general.gener_usuario_rol ur
                ON ur.id_usuario = u.id_usuario
               AND ur.id_negocio = nu.id_negocio
               AND ur.id_rol = :idRolAdmin
               AND ur.estado = 'A'
          WHERE nu.id_negocio = :idNegocio
            AND nu.estado = 'A'
            AND u.num_identificacion NOT LIKE 'ASISTENTE-%'
            AND NOT EXISTS (
                SELECT 1 FROM general.gener_usuario_rol g
                 WHERE g.id_usuario = u.id_usuario AND g.id_negocio IS NULL AND g.estado = 'A'
            )
          ORDER BY u.id_usuario;`,
        {
            replacements: { idNegocio, idRolAdmin },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        },
    );
}

function errorDominio(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

/**
 * Abre una sede de `idNegocioPadre`.
 *
 * Todo en una transacción: el negocio, su ficha fiscal, su caja, su plan, el usuario que la
 * administra y la copia de la configuración. Si el clonado falla, la sede no llega a existir —
 * una sede con categorías pero sin productos sería peor que ninguna, porque nadie sabría qué le
 * falta.
 *
 * @param {number} idNegocioPadre
 * @param {Object} payload
 * @param {Object} payload.sede                 { nombre, direccion?, telefono?, email_contacto?, nit? }
 * @param {Object} [payload.plan]               { id_plan?, meses?, fecha_inicio? } — sin plan, prueba de 7 días.
 * @param {Object} [payload.admin]              Usuario NUEVO que la administra.
 * @param {number} [payload.id_usuario_existente] O un usuario que ya existe.
 *   Sin ninguno de los dos, la sede hereda los administradores de la matriz, que es lo normal.
 * @param {boolean} [payload.clonar=true]        Copiar la configuración de la matriz.
 * @returns {Promise<{id_negocio:number, id_usuario:number, clonado:Array}>}
 */
async function crearSede(idNegocioPadre, {
    sede, plan, admin, id_usuario_existente, clonar = true,
} = {}) {
    // ── Validaciones previas (fallar rápido, fuera de la transacción) ─────────
    if (!sede?.nombre || !String(sede.nombre).trim()) {
        throw errorDominio('El nombre de la sede es requerido', 'SEDE_SIN_NOMBRE', 400);
    }

    const matriz = await getMatriz(idNegocioPadre);
    if (!matriz) {
        throw errorDominio('El negocio matriz no existe', 'MATRIZ_NO_EXISTE', 404);
    }
    if (matriz.estado !== 'A') {
        throw errorDominio('No se pueden abrir sedes de un negocio inactivo', 'MATRIZ_INACTIVA', 409);
    }
    if (matriz.id_negocio_padre !== null) {
        throw errorDominio(
            'Ese negocio ya es una sede. Las sedes cuelgan de la matriz, no de otra sede.',
            'SEDE_DE_SEDE', 409,
        );
    }
    if (!matriz.id_tipo_negocio) {
        throw errorDominio(
            'El negocio matriz no tiene aplicativo asignado: no hay de qué heredar.',
            'MATRIZ_SIN_APLICATIVO', 409,
        );
    }

    // El rol de administrador es POR APLICATIVO, y la sede corre el mismo que la matriz.
    const roles = await usuarioAdminDao.getRolesActivos({ idTipoNegocio: matriz.id_tipo_negocio });
    const rolAdmin = roles.find((r) => usuarioAdminDao.isAdminRoleName(r.descripcion));
    if (!rolAdmin) {
        throw errorDominio(
            'El aplicativo de la matriz no tiene un rol de administrador definido',
            'APLICATIVO_SIN_ROL_ADMIN', 409,
        );
    }

    if (id_usuario_existente) {
        const existente = await Models.GenerUsuario.findOne({
            where: { id_usuario: id_usuario_existente, estado: 'A' },
            attributes: ['id_usuario'],
        });
        if (!existente) {
            throw errorDominio('El usuario seleccionado no existe o está inactivo', 'USUARIO_NO_EXISTE', 404);
        }
    } else if (admin?.primer_nombre) {
        const duplicado = await usuarioAdminDao.findUsuarioDuplicado({
            email: admin.email,
            num_identificacion: admin.num_identificacion,
        });
        if (duplicado) {
            const campo = admin.email && duplicado.email === admin.email
                ? 'email' : 'número de identificación';
            throw errorDominio(`Ya existe un usuario con ese ${campo}`, 'USUARIO_DUPLICADO', 409);
        }
    } else {
        // Modo por defecto: la sede la administra quien administra la matriz. Si la matriz no
        // tiene ningún administrador que sea persona, no hay de dónde heredar y hay que decirlo.
        const heredables = await administradoresDe(idNegocioPadre, rolAdmin.id_rol);
        if (heredables.length === 0) {
            throw errorDominio(
                'La matriz no tiene administradores que heredar. Indica un usuario existente o crea uno.',
                'SEDE_SIN_ADMIN', 409,
            );
        }
    }

    // La sede es un cliente pagador propio: plan pagado de N meses o prueba de 7 días.
    const vigencia = await negocioDao.resolverVigencia({
        idPlan: plan?.id_plan || null,
        meses: plan?.meses,
        fechaInicio: plan?.fecha_inicio || null,
        prueba: !plan?.id_plan,
    });

    const transaction = await initTransaction();
    try {
        // 1. El negocio. Lo que hereda de la matriz no se pregunta.
        const slug = await generarSlugUnico(sede.nombre, async (candidato) => {
            const filas = await Models.sequelize.query(
                `SELECT 1 FROM general.gener_negocio WHERE lower(slug) = lower(:candidato) LIMIT 1;`,
                { replacements: { candidato }, type: Models.sequelize.QueryTypes.SELECT, transaction },
            );
            return filas.length > 0;
        });

        const nueva = await Models.GenerNegocio.create({
            nombre: String(sede.nombre).trim(),
            id_negocio_padre: matriz.id_negocio,
            // El NIT de la sede es el de la matriz salvo que se diga otro: es el mismo
            // contribuyente. El índice único quedó acotado a las matrices justo para esto.
            nit: sede.nit ?? matriz.nit ?? null,
            email_contacto: sede.email_contacto ?? null,
            telefono: sede.telefono ?? null,
            direccion: sede.direccion ?? null,
            slug,
            // Heredado: una sede de una pizzería es una pizzería.
            id_tipo_negocio: matriz.id_tipo_negocio,
            id_rubro: matriz.id_rubro,
            pais: matriz.pais,
            id_paleta: matriz.id_paleta,
            colores: matriz.colores,
            // Los interruptores son decisiones de la empresa, no del local.
            permite_multipago: matriz.permite_multipago,
            permite_pago_domicilio: matriz.permite_pago_domicilio,
            permite_descuento: matriz.permite_descuento,
            pregunta_cobro_envio: matriz.pregunta_cobro_envio,
            permite_cuentas_cliente: matriz.permite_cuentas_cliente,
            controla_inventario: matriz.controla_inventario,
            asistente_mira_stock: matriz.asistente_mira_stock,
            muestra_iconos_productos: matriz.muestra_iconos_productos,
            permite_domicilio_personal: matriz.permite_domicilio_personal,
            estado: 'A',
        }, { transaction });
        const idSede = nueva.id_negocio;

        // 2. Ficha fiscal propia, en modo NINGUNO. Es la misma razón que en `createNegocio`:
        //    mejor una ficha vacía que un negocio sin ficha. La de la matriz no se copia porque
        //    la resolución de facturación y el rango de numeración son por establecimiento.
        await datosFiscales.asegurarFicha(idSede, { transaction });

        // 3. Su caja, si corre sobre RESTAURANTE: sin ninguna no se puede tomar un pedido.
        //    Por NOMBRE del aplicativo y no por id, porque los de `gener_tipo_negocio` difieren
        //    entre desarrollo y producción. `reserva` lleva sus turnos en `reserva_caja` y no
        //    quiere una fila en `restaurante.rest_punto_caja`.
        if (String(matriz.aplicativo || '').trim().toUpperCase() === 'RESTAURANTE') {
            await asegurarCajaPrincipal(idSede, { transaction });
        }

        // 4. Su plan: propio, con su propia vigencia.
        await Models.GenerNegocioPlan.create({
            id_negocio: idSede,
            id_plan: vigencia.idPlan,
            fecha_inicio: vigencia.inicio,
            fecha_fin: vigencia.fin,
            estado: 'A',
            auto_renovacion: !vigencia.esPrueba,
        }, { transaction });

        // 5. Quién la administra. Tres modos: un usuario concreto, uno nuevo, o —por
        //    defecto— los mismos administradores que la matriz.
        let idUsuario;
        if (id_usuario_existente) {
            await usuarioAdminDao.vincularUsuarioANegocio(
                id_usuario_existente, rolAdmin.id_rol, idSede, transaction,
            );
            idUsuario = id_usuario_existente;
        } else if (!admin?.primer_nombre) {
            const heredados = await administradoresDe(matriz.id_negocio, rolAdmin.id_rol, transaction);
            for (const u of heredados) {
                await usuarioAdminDao.vincularUsuarioANegocio(
                    u.id_usuario, rolAdmin.id_rol, idSede, transaction,
                );
            }
            // El primero es el que se devuelve; los demás quedan vinculados igual.
            idUsuario = Number(heredados[0].id_usuario);
        } else {
            idUsuario = await usuarioAdminDao.createUsuario({
                primer_nombre: admin.primer_nombre,
                segundo_nombre: admin.segundo_nombre || null,
                primer_apellido: admin.primer_apellido,
                segundo_apellido: admin.segundo_apellido || null,
                num_identificacion: admin.num_identificacion,
                telefono: admin.telefono || null,
                email: admin.email,
                password: admin.password,
                id_rol: rolAdmin.id_rol,
                id_negocio: idSede,
                estado: 'A',
                es_admin_principal: false,
            }, transaction);
        }

        // 6. La copia de la configuración. Lo último: necesita la sede ya creada, y si falla
        //    se cae todo lo anterior con ella.
        const clonado = clonar
            ? await clonarConfiguracion({
                idPadre: matriz.id_negocio,
                idSede,
                aplicativo: matriz.aplicativo,
                transaction,
            })
            : [];

        await transaction.commit();
        return { id_negocio: idSede, id_usuario: idUsuario, clonado };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

module.exports = { getMatriz, listarSedes, crearSede };
