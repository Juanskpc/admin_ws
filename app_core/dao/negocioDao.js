const Models = require('../models/conection');
const { asegurarCajaPrincipal } = require('../helpers/cajaPrincipal');
const { initTransaction } = require('../helpers/funcionesAdicionales');
const planHelper = require('../helpers/planHelper');
const usuarioAdminDao = require('./usuarioAdminDao');
const datosFiscales = require('../facturacion/datosFiscales');
const tipoOperativo = require('../helpers/tipoNegocioOperativo');

/**
 * Obtiene la lista de negocios activos.
 * @returns {Array} Lista de negocios
 */
function getListaNegocios() {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A' },
        attributes: ['id_negocio', 'nombre', 'nit', 'email_contacto', 'telefono', 'fecha_registro']
    });
}

/**
 * Obtiene un negocio por su ID.
 * @param {number} idNegocio
 * @returns {Object|null}
 */
function getNegocioById(idNegocio) {
    return Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' }
    });
}

/**
 * Crea un nuevo negocio.
 * @param {Object} negocio Datos del negocio
 * @param {Object} t Transacción (opcional)
 */
// El módulo del que cuelga el vertical restaurante. Es el único que necesita caja.
const MODULO_RESTAURANTE = 1;

async function createNegocio(negocio, t) {
    const options = t ? { transaction: t } : {};
    // Lo que llega es el OFICIO del cliente (heladería, barbería…). De ahí salen las dos cosas
    // que se guardan: el rubro, para hablar con él, y el módulo, del que cuelgan roles y
    // permisos. Ver helpers/tipoNegocioOperativo.js.
    const elegido = negocio.id_rubro ?? negocio.id_tipo_negocio;
    const datos = { ...negocio };
    if (elegido) {
        const { idRubro, idModulo } = await tipoOperativo.resolverRubro(elegido, { transaction: t });
        datos.id_rubro = idRubro;
        datos.id_tipo_negocio = idModulo;
    }
    const creado = await Models.GenerNegocio.create(datos, options);
    // Todo negocio nace con su ficha fiscal, en modo NINGUNO: no le pide nada al cliente, pero
    // evita que existan negocios sin ficha, que es un segundo estado posible para lo mismo.
    await datosFiscales.asegurarFicha(creado.id_negocio, { transaction: t });
    // Y con su caja, si es de restaurante: sin ninguna no se puede tomar un pedido.
    if (Number(datos.id_tipo_negocio) === MODULO_RESTAURANTE) {
        await asegurarCajaPrincipal(creado.id_negocio, { transaction: t });
    }
    return creado;
}

/**
 * Obtiene todos los negocios activos asociados a un usuario.
 * JOIN con gener_negocio_usuario para verificar membresía.
 * @param {number} idUsuario
 * @returns {Array}
 */
function getNegociosByUsuario(idUsuario) {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A' },
        include: [{
            model: Models.GenerNegocioUsuario,
            as: 'usuarios',
            where: { id_usuario: idUsuario, estado: 'A' },
            attributes: [],
            required: true,
        }],
        attributes: [
            'id_negocio', 'nombre', 'nit',
            'email_contacto', 'telefono',
            'id_tipo_negocio', 'id_paleta',
            'estado', 'fecha_registro',
        ],
        order: [['nombre', 'ASC']],
    });
}

/**
 * Obtiene los negocios a los que un usuario tiene acceso, filtrados por tipo de negocio.
 * JOIN con gener_negocio_usuario para verificar membresía.
 * @param {number} idUsuario
 * @param {number} idTipoNegocio
 * @returns {Array}
 */
function getNegociosByUsuarioAndTipo(idUsuario, idTipoNegocio) {
    return Models.GenerNegocio.findAll({
        where: { estado: 'A', id_tipo_negocio: idTipoNegocio },
        include: [{
            model: Models.GenerNegocioUsuario,
            as: 'usuarios',
            where: { id_usuario: idUsuario, estado: 'A' },
            attributes: [],
            required: true,
        }],
        attributes: [
            'id_negocio', 'nombre', 'nit',
            'email_contacto', 'telefono',
            'id_tipo_negocio', 'id_paleta',
            'estado', 'fecha_registro',
        ],
        order: [['nombre', 'ASC']],
    });
}

/**
 * Convierte una fecha 'YYYY-MM-DD' (o ISO) a un Date anclado a Bogotá (-05:00),
 * para que se almacene con la pared horaria correcta (sin corrimiento de día).
 */
function fechaBogota(valor, finDeDia = false) {
    if (!valor) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        return new Date(`${valor}T${finDeDia ? '23:59:59' : '00:00:00'}-05:00`);
    }
    return new Date(valor);
}

/** Días que dura la prueba sin plan pagado. Los mismos que el registro trial de la landing. */
const DIAS_PRUEBA = 7;

/** El plan con el que corre una prueba —el mismo que asigna el registro trial—, por CÓDIGO. */
const CODIGO_PLAN_PRUEBA = 'BASICO';

/** La fecha de calendario de hoy en Bogotá, 'YYYY-MM-DD'. */
function hoyBogota() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/**
 * Suma meses y/o días a una fecha de calendario 'YYYY-MM-DD' y devuelve otra igual.
 *
 * Es aritmética de calendario, no de horas: se usa UTC solo como contenedor para que la zona
 * del servidor no corra el día. Al sumar meses el día se recorta al último del mes destino
 * (31-ene + 1 mes = 28-feb), que es lo que espera quien lee «un mes». El frontend repite
 * exactamente esta cuenta para la vista previa (`core/utils/vigencia.ts`): si cambia una,
 * cambia la otra, o la consola prometería una fecha y la base guardaría otra.
 */
function sumarPeriodo(fecha, { meses = 0, dias = 0 } = {}) {
    const [y, m, d] = String(fecha).split('-').map(Number);
    const mesDestino = m - 1 + Number(meses || 0);
    const ultimoDia = new Date(Date.UTC(y, mesDestino + 1, 0)).getUTCDate();
    const base = new Date(Date.UTC(y, mesDestino, Math.min(d, ultimoDia)));
    base.setUTCDate(base.getUTCDate() + Number(dias || 0));
    return base.toISOString().slice(0, 10);
}

/**
 * Decide con qué plan y entre qué fechas corre una vigencia.
 *
 * Las dos puertas —registrar cliente y cambiar el plan desde Negocios— pasan por aquí para que
 * la misma elección dé siempre las mismas fechas:
 *
 *   · **Plan pagado:** empieza el día elegido y termina ese mismo día N meses después.
 *   · **Prueba** (el «Sin plan» de la consola): Plan Básico durante DIAS_PRUEBA días, sin
 *     auto-renovación. Sin fila de plan el negocio no tiene fechas contra las que validar el
 *     acceso, y eso es justo lo que se necesita tener claro.
 *
 * El inicio va a las 00:00:00 y el fin a las 23:59:59, ambos hora de Bogotá: el día que la
 * consola enseña como «termina» es un día de acceso completo.
 *
 * @returns {Promise<{ idPlan:number, inicio:Date, fin:Date, esPrueba:boolean }>}
 */
async function resolverVigencia({ idPlan = null, meses = 1, fechaInicio = null, fechaFin = null, prueba = false } = {}) {
    const esPrueba = Boolean(prueba);

    const plan = await Models.GenerPlan.findOne({
        where: esPrueba
            ? { codigo: CODIGO_PLAN_PRUEBA, estado: 'A' }
            : { id_plan: idPlan, estado: 'A' },
        attributes: ['id_plan'],
    });
    if (!plan) {
        const err = new Error(esPrueba
            ? `No hay un plan ${CODIGO_PLAN_PRUEBA} activo con el que correr la prueba`
            : 'Plan no encontrado o inactivo');
        err.statusCode = esPrueba ? 409 : 404;
        throw err;
    }

    const diaInicio = fechaInicio ? String(fechaInicio).slice(0, 10) : hoyBogota();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(diaInicio)) {
        const err = new Error('Fecha de inicio inválida');
        err.statusCode = 400;
        throw err;
    }

    const diaFin = fechaFin
        ? String(fechaFin).slice(0, 10)
        : sumarPeriodo(diaInicio, esPrueba ? { dias: DIAS_PRUEBA } : { meses: Number(meses) || 1 });

    const inicio = fechaBogota(diaInicio, false);
    const fin = fechaBogota(diaFin, true);
    if (fin < inicio) {
        const err = new Error('La fecha de fin no puede ser anterior a la de inicio');
        err.statusCode = 400;
        throw err;
    }

    return { idPlan: plan.id_plan, inicio, fin, esPrueba };
}

/**
 * Asigna (o cambia) el plan de un negocio.
 * Desactiva el plan vigente y crea una nueva vigencia, todo en una transacción.
 *
 * @param {number} idNegocio
 * @param {number|null} idPlan           Ignorado si `opts.prueba`.
 * @param {Object} [opts]
 * @param {number} [opts.meses=1]        Duración si no se da fecha de fin.
 * @param {string} [opts.fechaInicio]    Fecha de inicio ('YYYY-MM-DD' o ISO). Por defecto, hoy.
 * @param {string} [opts.fechaFin]       Fecha de fin ('YYYY-MM-DD' o ISO).
 * @param {boolean} [opts.prueba]        Prueba de DIAS_PRUEBA días con el Plan Básico.
 * @returns {Promise<Object>} La fila gener_negocio_plan creada.
 */
async function asignarPlan(idNegocio, idPlan, { meses = 1, fechaInicio = null, fechaFin = null, prueba = false } = {}) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_negocio'],
    });
    if (!negocio) {
        const err = new Error('Negocio no encontrado');
        err.statusCode = 404;
        throw err;
    }

    const vigencia = await resolverVigencia({ idPlan, meses, fechaInicio, fechaFin, prueba });

    const transaction = await initTransaction();
    try {
        // Cierra la vigencia anterior (solo puede haber un plan activo a la vez).
        await Models.GenerNegocioPlan.update(
            { estado: 'I' },
            { where: { id_negocio: idNegocio, estado: 'A' }, transaction },
        );

        const row = await Models.GenerNegocioPlan.create(
            {
                id_negocio: idNegocio,
                id_plan: vigencia.idPlan,
                fecha_inicio: vigencia.inicio,
                fecha_fin: vigencia.fin,
                estado: 'A',
                // Una prueba termina sola: renovarla sería regalar el Plan Básico.
                auto_renovacion: !vigencia.esPrueba,
            },
            { transaction },
        );

        await transaction.commit();
        return row;
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

/**
 * Lista TODOS los negocios (activos e inactivos) con su tipo y plan vigente.
 * Para la vista de gestión del Super Admin.
 */
async function getListaNegociosAdmin() {
    const negocios = await Models.GenerNegocio.findAll({
        attributes: [
            'id_negocio', 'nombre', 'nit', 'email_contacto', 'telefono',
            'direccion', 'id_tipo_negocio', 'id_rubro', 'pais', 'estado', 'fecha_registro',
        ],
        include: [{
            model: Models.GenerTipoNegocio,
            as: 'tipoNegocio',
            attributes: ['id_tipo_negocio', 'nombre', 'icono', 'color_hex'],
            required: false,
        }, {
            // El oficio que dijo ser el cliente. Es lo que se enseña en la consola; el módulo
            // se queda para quien necesite saber sobre qué software corre.
            model: Models.GenerTipoNegocio,
            as: 'rubro',
            attributes: ['id_tipo_negocio', 'nombre', 'descripcion', 'icono', 'color_hex'],
            required: false,
        }],
        order: [['fecha_registro', 'DESC']],
    });

    const ids = negocios.map((n) => n.id_negocio);
    const planMap = await planHelper.getPlanesActivosPorNegocio(ids);

    return negocios.map((n) => ({
        id_negocio: n.id_negocio,
        nombre: n.nombre,
        nit: n.nit,
        email_contacto: n.email_contacto,
        telefono: n.telefono,
        direccion: n.direccion,
        id_tipo_negocio: n.id_tipo_negocio,
        id_rubro: n.id_rubro ?? null,
        pais: n.pais ?? 'CO',
        // `tipo_*` describe el OFICIO cuando se conoce, porque es lo que el usuario reconoce.
        // El módulo viaja aparte en `modulo_nombre` para quien lo necesite.
        tipo_nombre: n.rubro?.descripcion ?? n.rubro?.nombre ?? n.tipoNegocio?.nombre ?? null,
        tipo_icono: n.rubro?.icono ?? n.tipoNegocio?.icono ?? null,
        tipo_color: n.rubro?.color_hex ?? n.tipoNegocio?.color_hex ?? null,
        modulo_nombre: n.tipoNegocio?.nombre ?? null,
        estado: n.estado,
        fecha_registro: n.fecha_registro,
        plan: planMap.get(n.id_negocio) || null,
    }));
}

/**
 * Actualiza los datos de un negocio.
 *
 * Cambiar `id_tipo_negocio` no es un cambio de etiqueta: los roles cuelgan del tipo, así que el
 * negocio arrastra usuarios con roles que ya no le corresponden y su vertical deja de abrirse sin
 * decir por qué. Por eso el cambio de tipo va en transacción con la traducción de roles, y se
 * niega antes de tocar nada si el tipo nuevo no tiene módulo.
 */
async function updateNegocio(idNegocio, data) {
    const negocio = await Models.GenerNegocio.findOne({ where: { id_negocio: idNegocio } });
    if (!negocio) {
        const err = new Error('Negocio no encontrado');
        err.statusCode = 404;
        throw err;
    }

    // Pasar de «Restaurante» a «Heladería» cambia el oficio pero NO el módulo, así que los
    // roles siguen valiendo y no hay nada que traducir. Solo un cambio de módulo de verdad
    // —de restaurante a barbería— obliga a rehacerlos.
    const elegido = data.id_rubro ?? data.id_tipo_negocio;
    let rubroNuevo = null;
    let moduloNuevo = null;
    if (elegido) {
        const r = await tipoOperativo.resolverRubro(elegido);
        rubroNuevo = r.idRubro;
        moduloNuevo = r.idModulo;
    }
    const cambiaModulo = moduloNuevo !== null && moduloNuevo !== Number(negocio.id_tipo_negocio);

    const transaction = await initTransaction();
    try {
        await negocio.update({
            nombre: data.nombre,
            nit: data.nit ?? null,
            email_contacto: data.email_contacto ?? null,
            telefono: data.telefono ?? null,
            direccion: data.direccion ?? null,
            ...(moduloNuevo ? { id_tipo_negocio: moduloNuevo, id_rubro: rubroNuevo } : {}),
            ...(data.pais ? { pais: String(data.pais).toUpperCase() } : {}),
        }, { transaction });

        if (cambiaModulo) {
            await tipoOperativo.remapearRolesDeNegocio(idNegocio, moduloNuevo, { transaction });
        }

        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }

    return negocio;
}

/**
 * Cambia el estado (A/I) de un negocio.
 * @returns {number} filas afectadas
 */
async function setEstadoNegocio(idNegocio, estado) {
    const [affected] = await Models.GenerNegocio.update(
        { estado },
        { where: { id_negocio: idNegocio } },
    );
    return affected;
}

/**
 * Registra un cliente nuevo: crea el negocio, le asigna un plan (opcional)
 * y crea (o vincula) su usuario administrador — todo en una sola transacción.
 *
 * @param {Object} payload { negocio, plan, admin?, id_usuario_existente? }
 * @returns {Promise<{id_negocio:number, id_usuario:number}>}
 */
async function registrarCliente({ negocio, plan, admin, id_usuario_existente }) {
    // ── Validaciones previas (fallar rápido, fuera de la transacción) ──────────

    // El cliente elige su oficio; de ahí sale el módulo. `resolverRubro` comprueba las dos
    // cosas de una vez: que el tipo exista y que haya un módulo detrás capaz de atenderlo.
    const { idRubro, idModulo } = await tipoOperativo.resolverRubro(
        negocio.id_rubro ?? negocio.id_tipo_negocio,
    );

    const roles = await usuarioAdminDao.getRolesActivos({ idTipoNegocio: idModulo });
    const rolAdmin = roles.find((r) => usuarioAdminDao.isAdminRoleName(r.descripcion));
    if (!rolAdmin) {
        const err = new Error('El tipo de negocio no tiene un rol de administrador definido');
        err.statusCode = 409;
        throw err;
    }

    if (id_usuario_existente) {
        // Modo "usuario existente": verificar que el usuario exista y esté activo.
        const existente = await Models.GenerUsuario.findOne({
            where: { id_usuario: id_usuario_existente, estado: 'A' },
            attributes: ['id_usuario'],
        });
        if (!existente) {
            const err = new Error('El usuario seleccionado no existe o está inactivo');
            err.statusCode = 404;
            throw err;
        }
    } else {
        // Modo "usuario nuevo": evitar duplicados de email / identificación.
        const duplicado = await usuarioAdminDao.findUsuarioDuplicado({
            email: admin.email,
            num_identificacion: admin.num_identificacion,
        });
        if (duplicado) {
            const campo = admin.email && duplicado.email === admin.email ? 'email' : 'número de identificación';
            const err = new Error(`Ya existe un usuario con ese ${campo}`);
            err.statusCode = 409;
            throw err;
        }
    }

    // Con plan pagado, N meses desde la fecha de inicio; sin plan pero con fecha de inicio, la
    // prueba de DIAS_PRUEBA días. Sin ninguna de las dos (llamadas antiguas) no se crea vigencia.
    const vigencia = (plan?.id_plan || plan?.fecha_inicio)
        ? await resolverVigencia({
            idPlan: plan.id_plan || null,
            meses: plan.meses,
            fechaInicio: plan.fecha_inicio || null,
            prueba: !plan.id_plan,
        })
        : null;

    const transaction = await initTransaction();
    try {
        // 1. Negocio
        const nuevo = await Models.GenerNegocio.create({
            nombre: negocio.nombre,
            nit: negocio.nit ?? null,
            email_contacto: negocio.email_contacto ?? null,
            telefono: negocio.telefono ?? null,
            direccion: negocio.direccion ?? null,
            id_tipo_negocio: idModulo,
            id_rubro: idRubro,
            // Sin país explícito queda 'CO' por el DEFAULT de la columna: es lo que eran
            // todos los negocios hasta que apareció el primero chileno.
            ...(negocio.pais ? { pais: String(negocio.pais).toUpperCase() } : {}),
            estado: 'A',
        }, { transaction });
        const idNegocio = nuevo.id_negocio;

        // 1b. Ficha fiscal (modo NINGUNO: no se le pide nada todavía)
        await datosFiscales.asegurarFicha(idNegocio, { transaction });

        // 1c. Caja principal del restaurante
        if (Number(idModulo) === MODULO_RESTAURANTE) {
            await asegurarCajaPrincipal(idNegocio, { transaction });
        }

        // 2. Vigencia: plan pagado o prueba (ver resolverVigencia)
        if (vigencia) {
            await Models.GenerNegocioPlan.create({
                id_negocio: idNegocio,
                id_plan: vigencia.idPlan,
                fecha_inicio: vigencia.inicio,
                fecha_fin: vigencia.fin,
                estado: 'A',
                auto_renovacion: !vigencia.esPrueba,
            }, { transaction });
        }

        // 3. Usuario: vincular existente O crear nuevo
        let idUsuario;
        if (id_usuario_existente) {
            await usuarioAdminDao.vincularUsuarioANegocio(
                id_usuario_existente, rolAdmin.id_rol, idNegocio, transaction,
            );
            idUsuario = id_usuario_existente;
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
                id_negocio: idNegocio,
                estado: 'A',
                es_admin_principal: false,
            }, transaction);
        }

        await transaction.commit();
        return { id_negocio: idNegocio, id_usuario: idUsuario };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

module.exports = {
    getListaNegocios,
    getNegocioById,
    createNegocio,
    getNegociosByUsuario,
    getNegociosByUsuarioAndTipo,
    asignarPlan,
    getListaNegociosAdmin,
    updateNegocio,
    setEstadoNegocio,
    registrarCliente,
    resolverVigencia,
};