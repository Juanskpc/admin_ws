/**
 * adquirirService — comprar un plan sin tener cuenta todavía.
 *
 * Es la otra puerta de entrada al producto. La que ya existía (`registroTrialService`) regala
 * siete días y no cobra nada; esta cobra desde el primer día, y por eso no puede ser la misma:
 * un trial se activa al verificar un correo, una compra se activa cuando entra el dinero.
 *
 * ## Por qué la cuenta se crea ANTES de pagar
 *
 * Todo el cobro de EscalApp cuelga de `cobranza.cob_factura`, y una factura necesita un
 * `id_negocio` — la referencia misma es `EA-<id_negocio>-<AAAAMM>`. Guardar los datos del
 * comprador en una tabla aparte y crear el negocio al confirmar el pago habría significado un
 * segundo camino de cobro, con su propia conciliación y su propio webhook. En vez de eso, aquí
 * se crea la cuenta **sin plan**:
 *
 *   - `gener_negocio` y `gener_usuario` existen desde el primer paso,
 *   - `general.gener_negocio_plan` NO, así que `planHelper` dice «sin plan» y los guards del
 *     frontend mandan a `/sin-plan`: la cuenta existe pero no sirve para nada,
 *   - el pago de la primera factura crea esa fila (`aplicarPagoAprobado` → `fijarVencimientoPlan`)
 *     y el negocio queda vivo.
 *
 * Una compra abandonada deja exactamente el mismo estado que un trial vencido, que el sistema ya
 * sabe manejar. Y todo lo demás —pasarelas, webhook, reintentos, renovación, cartera— se reutiliza
 * tal cual.
 *
 * ## Qué se puede vender aquí
 *
 * Lo que exista en `general.gener_plan` **con precio en `cobranza.cob_precio_plan`**. Hoy son
 * «Plan Básico» y «Plan Avanzado» en COP mensual. Los planes con facturación electrónica de la
 * landing todavía no existen como fila, así que este servicio los rechaza con un error claro en
 * vez de cobrar un plan que no es el que el cliente vio.
 */
'use strict';

const { Op } = require('sequelize');

const Models = require('../../app_core/models/conection');
const { initTransaction } = require('../../app_core/helpers/funcionesAdicionales');
const { syncUsuarioRolActivo, rebuildNivelesUsuario } = require('../../app_core/dao/usuarioAdminDao');
const datosFiscales = require('../../app_core/facturacion/datosFiscales');
const { asegurarCajaPrincipal } = require('../../app_core/helpers/cajaPrincipal');
const Dao = require('../../app_core/dao/cobranzaDao');
const CobranzaService = require('./cobranzaService');
const MailService = require('./mailService');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');
const { resolverRubroElegido } = require('./registroTrialService');

const sequelize = Models.sequelize;

/**
 * La marca que este flujo deja en `cob_suscripcion.notas`.
 *
 * Es lo que distingue un alta comprada por la web de cualquier otro negocio, y de ella depende
 * que el correo de bienvenida salga solo para quien lo necesita. Si se cambia el texto, hay que
 * cambiarlo en los dos sitios a la vez: es una llave, no un comentario.
 */
const MARCA_ALTA_WEB = 'Alta desde la web (Adquirir plan).';

/** Error de dominio tipado, como el resto de servicios del módulo. */
function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/**
 * «Ana María» + «Pérez Gómez» → las tres columnas que guarda `gener_usuario`.
 *
 * El formulario pregunta nombres y apellidos por separado en vez de un «nombre completo» que haya
 * que adivinar dónde se parte: en Colombia son dos apellidos y dos nombres con la misma
 * frecuencia, y cualquier heurística se equivoca con la mitad de la gente.
 */
function partirNombre(nombres, apellidos) {
    const n = String(nombres || '').trim().split(/\s+/).filter(Boolean);
    const a = String(apellidos || '').trim().split(/\s+/).filter(Boolean);
    return {
        primer_nombre: n[0] || 'Usuario',
        segundo_nombre: n.slice(1).join(' ') || null,
        primer_apellido: a.join(' ') || '-',
    };
}

/** Hoy en Bogotá, en ISO. La factura del alta empieza hoy, no «el próximo ciclo». */
function hoyBogota() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/**
 * LOS PLANES QUE SE VENDEN EN LÍNEA, por código. Una sola lista: añadir un plan a la venta es añadir
 * su código aquí, y quitarlo es quitarlo; ni el catálogo ni la compra tienen otra.
 *
 * Los planes con facturación (`EMPRENDEDOR_FE_*`, `EMPRESARIAL_*`) se venden desde el 2026-09-24
 * por decisión del usuario, **aunque la emisión de documentos (FE-2) todavía no existe**. Cada uno
 * es una fila de `gener_plan` por paquete de documentos (S/M/L/XL).
 */
const CODIGOS_OFRECIDOS = [
    'BASICO',
    'AVANZADO',
    'EMPRENDEDOR_FE_S', 'EMPRENDEDOR_FE_M', 'EMPRENDEDOR_FE_L', 'EMPRENDEDOR_FE_XL',
    'EMPRESARIAL_S', 'EMPRESARIAL_M', 'EMPRESARIAL_L', 'EMPRESARIAL_XL',
];

/**
 * El plan que se va a cobrar, con su precio real.
 *
 * Se resuelve **por nombre** y contra `cob_precio_plan`, no por el precio que mande el navegador:
 * lo que el visitante ve en la landing es marketing, y lo que se cobra tiene que salir de la base.
 * Si la landing promete un plan que no existe aquí, esto falla a propósito — es preferible una
 * compra que no arranca a una compra que cobra otra cosa.
 */
async function resolverPlan(nombrePlan, moneda = 'COP', ciclo = 'mensual', idTipoModulo = null) {
    // Se busca por CÓDIGO ('BASICO', 'AVANZADO'…), que no cambia si el plan se renombra. El nombre
    // se sigue aceptando como referencia antigua —los enlaces publicados de la landing llevan
    // `?plan=Plan%20Avanzado`—; se quita cuando la landing mande el código.
    const referencia = String(nombrePlan || '').trim();
    const plan = await Models.GenerPlan.findOne({
        where: {
            estado: 'A',
            [Op.or]: [{ codigo: referencia.toUpperCase() }, { nombre: referencia }],
        },
        attributes: ['id_plan', 'nombre', 'codigo'],
    });
    // Encontrarlo no basta: además tiene que estar en la lista de los que se venden.
    if (!plan || !CODIGOS_OFRECIDOS.includes(plan.codigo)) {
        throw error(
            'Ese plan todavía no se puede contratar en línea. Escríbenos y lo activamos contigo.',
            'PLAN_NO_DISPONIBLE',
            409
        );
    }

    // El precio es el del APLICATIVO del negocio que se está comprando (Reserva no vale lo mismo que
    // Restaurante); sin fila propia, el de por defecto.
    const precio = await Dao.getPrecio({ idPlan: plan.id_plan, moneda, ciclo, idTipoModulo });
    if (!precio || Number(precio) <= 0) {
        throw error(
            'Ese plan todavía no tiene precio publicado para tu país. Escríbenos y lo activamos contigo.',
            'PLAN_SIN_PRECIO',
            409
        );
    }

    return {
        id_plan: plan.id_plan,
        nombre: plan.nombre,
        codigo: plan.codigo ?? null,
        precio: Number(precio),
        moneda,
        ciclo,
    };
}

/**
 * Qué se ofrece en el formulario: los planes vendibles y los oficios de la categoría elegida.
 *
 * El frontend ya conoce los rubros por `GET /admin/rubros`, pero los planes no: necesita saber
 * cuáles puede cobrar de verdad para no enseñar un botón que va a fallar en el último paso.
 */
async function catalogoCompra({ moneda = 'COP', ciclo = 'mensual', rubro = null } = {}) {
    // Con el oficio elegido se sabe el aplicativo, y con él los precios que le tocan. Sin oficio
    // (la página aún no lo pregunta) se enseñan los de por defecto.
    const rubroElegido = rubro ? await resolverRubroElegido(rubro) : null;
    const idTipoModulo = rubroElegido?.id_tipo_modulo ?? null;

    const planes = await sequelize.query(
        `SELECT id_plan, codigo, nombre, descripcion, usuarios_incluidos, cajas_incluidas
           FROM general.gener_plan
          WHERE estado = 'A' AND codigo IN (:codigos)
          ORDER BY id_plan;`,
        { replacements: { codigos: CODIGOS_OFRECIDOS }, type: sequelize.QueryTypes.SELECT }
    );

    const vendibles = [];
    for (const plan of planes) {
        // `getPrecio` lanza si no hay precio: un plan sin precio en esta moneda simplemente no
        // se ofrece, en vez de tumbar el catálogo entero.
        let precio = null;
        try {
            precio = await Dao.getPrecio({ idPlan: plan.id_plan, moneda, ciclo, idTipoModulo });
        } catch {
            continue;
        }
        if (!precio || Number(precio) <= 0) continue;

        vendibles.push({
            id_plan: plan.id_plan,
            codigo: plan.codigo,
            nombre: plan.nombre,
            descripcion: plan.descripcion ?? null,
            precio: Number(precio),
            moneda,
            ciclo,
            usuarios_incluidos: plan.usuarios_incluidos ?? null,
            cajas_incluidas: plan.cajas_incluidas ?? null,
        });
    }

    const [pasarelas, complementos] = await Promise.all([
        Dao.listarPasarelas({ pais: 'CO' }),
        Dao.listarComplementosCatalogo({ moneda, ciclo }),
    ]);

    return {
        planes: vendibles,
        complementos: complementos.map((c) => ({
            codigo: c.codigo,
            nombre: c.nombre,
            descripcion: c.descripcion,
            amplia: c.amplia,
            cantidad_maxima: c.cantidad_maxima,
            precio: c.precio,
        })),
        pasarelas: pasarelas.map((p) => ({ codigo: p.codigo, nombre: p.nombre })),
    };
}

/**
 * Traduce la elección del comprador (`[{ codigo, cantidad }]`) a filas del catálogo.
 *
 * Todo lo que decide dinero se valida aquí y no en el navegador: el código tiene que existir y
 * tener precio en la moneda, la cantidad tiene que ser entera y no pasar del tope del
 * complemento. Cantidad 0 es «no lo quiero» y se descarta sin error — es lo que manda la
 * pantalla cuando alguien sube y vuelve a bajar el contador.
 */
async function resolverComplementos(lista, moneda, ciclo) {
    if (!Array.isArray(lista) || lista.length === 0) return [];

    const catalogo = await Dao.listarComplementosCatalogo({ moneda, ciclo });
    const vistos = new Set();
    const resueltos = [];

    for (const item of lista) {
        const codigo = String(item?.codigo ?? '').trim().toUpperCase();
        const cantidad = Number(item?.cantidad ?? 0);

        if (vistos.has(codigo)) {
            throw error(`El complemento ${codigo} viene repetido.`, 'COMPLEMENTO_REPETIDO', 422);
        }
        vistos.add(codigo);

        if (!Number.isInteger(cantidad) || cantidad < 0) {
            throw error('La cantidad de un complemento no es válida.', 'COMPLEMENTO_CANTIDAD', 422);
        }
        if (cantidad === 0) continue;

        const c = catalogo.find((x) => x.codigo === codigo);
        if (!c) {
            throw error('Ese complemento no está disponible.', 'COMPLEMENTO_NO_DISPONIBLE', 422);
        }
        if (cantidad > c.cantidad_maxima) {
            throw error(
                `Puedes añadir hasta ${c.cantidad_maxima} de «${c.nombre}».`,
                'COMPLEMENTO_CANTIDAD',
                422
            );
        }

        resueltos.push({ id_complemento: c.id_complemento, cantidad, codigo: c.codigo });
    }

    return resueltos;
}

/**
 * El negocio de un alta que nunca llegó a pagarse, o `null` si no hay ninguno así.
 *
 * «A medias» es una definición estricta a propósito: el usuario tiene **un solo** negocio, ese
 * negocio **no tiene plan** (ni vigente ni vencido — nunca llegó a tenerlo) y **no tiene ninguna
 * factura pagada**. Cualquier cuenta que haya pagado algo alguna vez, o que ya tenga plan, es un
 * cliente y no se toca desde una ruta pública.
 */
async function compraSinTerminar(idUsuario) {
    const [fila] = await sequelize.query(
        `SELECT n.id_negocio
           FROM general.gener_negocio_usuario nu
           JOIN general.gener_negocio n ON n.id_negocio = nu.id_negocio
          WHERE nu.id_usuario = :idUsuario
            AND nu.estado = 'A'
            AND NOT EXISTS (
                  SELECT 1 FROM general.gener_negocio_plan np
                   WHERE np.id_negocio = n.id_negocio
                )
            AND NOT EXISTS (
                  SELECT 1 FROM cobranza.cob_factura f
                   WHERE f.id_negocio = n.id_negocio AND f.estado = 'pagada'
                );`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT }
    );

    if (!fila) return null;

    // Con más de un negocio no se adivina: eso ya es una cuenta con historia.
    const [conteo] = await sequelize.query(
        `SELECT COUNT(*)::int AS negocios
           FROM general.gener_negocio_usuario
          WHERE id_usuario = :idUsuario AND estado = 'A';`,
        { replacements: { idUsuario }, type: sequelize.QueryTypes.SELECT }
    );
    if (!conteo || conteo.negocios !== 1) return null;

    return fila;
}

/**
 * Crea la cuenta del comprador y le deja su primer cobro esperando. **No toca la pasarela.**
 *
 * Es el paso «Crear y continuar» de la compra. Separarlo del pago no es un capricho de pantalla:
 * describe lo que de verdad pasa. Antes los cuatro pasos parecían un trámite único que o salía
 * entero o no valía, y no era cierto — si el pago fallaba, la cuenta ya estaba creada y nadie se
 * lo decía al comprador, que volvía a empezar y chocaba con «ya existe una cuenta con ese
 * correo». Ahora la cuenta se confirma cuando se crea, y el pago es el paso siguiente.
 *
 * Todo lo que crea cuenta va en una sola transacción. La suscripción y la factura se arman
 * después, fuera de ella: si algo falla ahí, la cuenta ya existe y el comprador puede seguir.
 */
async function crearCuenta(datos) {
    const {
        nombres,
        apellidos,
        num_identificacion,
        email,
        telefono = null,
        rubro,
        nombre_negocio,
        plan: nombrePlan,
        pasarela = 'wompi',
        moneda = 'COP',
        ciclo = 'mensual',
        complementos: complementosPedidos = [],
        password = null,
    } = datos;

    const correo = String(email).toLowerCase().trim();
    const cedula = String(num_identificacion).trim();

    // 1. El oficio elegido y el módulo que lo atiende — de ahí salen los roles del negocio, y el
    //    aplicativo del que depende el PRECIO del plan.
    const rubroElegido = await resolverRubroElegido(rubro);
    if (!rubroElegido?.id_tipo_modulo) {
        throw error(
            'Ese tipo de negocio todavía no está disponible para contratar en línea.',
            'RUBRO_NO_DISPONIBLE',
            409
        );
    }

    // 2. Lo que se va a cobrar, antes de tocar nada: el plan (al precio de su aplicativo) y lo que
    //    se le añade.
    const plan = await resolverPlan(nombrePlan, moneda, ciclo, rubroElegido.id_tipo_modulo);
    const complementos = await resolverComplementos(complementosPedidos, moneda, ciclo);

    // 3. ¿Ya hay algo con este correo o esta cédula?
    //
    // Hay dos casos muy distintos y antes se trataban igual. El primero es un cliente de verdad:
    // ahí no se crea una segunda cuenta y se le manda a su panel. El segundo es **él mismo,
    // volviendo**: dio a pagar, no completó el checkout —cerró la pestaña, se le cayó la tarjeta,
    // lo pensó mejor— y su cuenta quedó a medias, sin plan y sin un peso pagado. Bloquearlo con
    // «ya existe una cuenta» lo deja fuera de su propia compra con su propio correo, que es lo
    // que pasó la primera vez que se probó esto.
    const [porEmail, porCedula] = await Promise.all([
        Models.GenerUsuario.findOne({
            where: { email: correo },
            attributes: ['id_usuario', 'num_identificacion'],
        }),
        Models.GenerUsuario.findOne({
            where: { num_identificacion: cedula },
            attributes: ['id_usuario', 'email'],
        }),
    ]);

    if (porEmail || porCedula) {
        // Retomar exige que coincidan **las dos** llaves: el mismo correo y la misma cédula, y una
        // sola cuenta. Con una sola bastaría para que alguien que sepa un correo ajeno reabra el
        // cobro de otro; con las dos, quien vuelve es quien empezó.
        const mismaPersona =
            porEmail && porCedula && porEmail.id_usuario === porCedula.id_usuario;
        const aMedias = mismaPersona ? await compraSinTerminar(porEmail.id_usuario) : null;

        if (aMedias) {
            console.info(
                `[Adquirir] Compra retomada: usuario=${porEmail.id_usuario} negocio=${aMedias.id_negocio}`
            );
            const cobro = await prepararFactura({
                idNegocio: aMedias.id_negocio,
                plan,
                complementos,
                pasarela,
            });
            return {
                id_negocio: aMedias.id_negocio,
                id_usuario: porEmail.id_usuario,
                email: correo,
                plan: plan.nombre,
                retomada: true,
                referencia: cobro.referencia,
                lineas: cobro.lineas,
                total: cobro.total,
                moneda: cobro.moneda,
                periodo_inicio: cobro.periodo_inicio,
                periodo_fin: cobro.periodo_fin,
            };
        }

        // No se retoma: decir **qué** dato choca es lo que permite corregirlo. «Esos datos» obliga
        // a adivinar cuál de los dos.
        throw error(
            porEmail
                ? 'Ya existe una cuenta con ese correo. Inicia sesión y contrata el plan desde tu ' +
                      'panel, o paga tu mensualidad en el portal de pagos.'
                : 'Ya existe una cuenta con ese número de identificación. Inicia sesión y contrata ' +
                      'el plan desde tu panel, o paga tu mensualidad en el portal de pagos.',
            'CUENTA_YA_EXISTE',
            409
        );
    }

    const { primer_nombre, segundo_nombre, primer_apellido } = partirNombre(nombres, apellidos);
    const idTipoNegocio = rubroElegido.id_tipo_modulo;

    // 4. La cuenta, apagada: sin `gener_negocio_plan` no hay acceso a nada.
    const transaction = await initTransaction();
    let idUsuario;
    let idNegocio;
    try {
        // Es el PRIMER usuario del negocio nuevo: no se comprueba el cupo (nunca falla el primero;
        // ver app_core/helpers/cupoUsuarios.js).
        const usuario = await Models.GenerUsuario.create(
            {
                primer_nombre,
                segundo_nombre: segundo_nombre || null,
                primer_apellido,
                num_identificacion: cedula,
                email: correo,
                // La elige el comprador en el paso de crear la cuenta. Si no llega (la ruta
                // antigua, que no la pedía) se cae a la cédula y se le obliga a cambiarla al
                // entrar, que es como funcionaba el alta web hasta 2026-09-23.
                password: password || cedula, // el hook beforeCreate aplica bcrypt
                debe_cambiar_password: !password,
                estado: 'A',
            },
            { transaction }
        );
        idUsuario = usuario.id_usuario;

        const negocio = await Models.GenerNegocio.create(
            {
                nombre: String(nombre_negocio).trim(),
                id_tipo_negocio: idTipoNegocio,
                id_rubro: rubroElegido.id_tipo_negocio ?? null,
                email_contacto: correo,
                telefono: telefono ? String(telefono).trim() : null,
                estado: 'A',
            },
            { transaction }
        );
        idNegocio = negocio.id_negocio;

        await datosFiscales.asegurarFicha(idNegocio, { transaction });

        // Caja principal: sin ninguna, el restaurante no puede tomar pedidos ni cobrar.
        if (Number(idTipoNegocio) === 1) {
            await asegurarCajaPrincipal(idNegocio, { transaction });
        }

        await Models.GenerNegocioUsuario.create(
            { id_usuario: idUsuario, id_negocio: idNegocio, estado: 'A' },
            { transaction }
        );

        // Rol ADMINISTRADOR del módulo: sin él, el dueño entra a un panel sin un solo módulo.
        const rolAdmin = await Models.GenerRol.findOne({
            where: {
                id_tipo_negocio: idTipoNegocio,
                descripcion: { [Op.iLike]: '%ADMINISTRADOR%' },
                estado: 'A',
            },
            attributes: ['id_rol'],
            transaction,
        });
        if (rolAdmin) {
            await syncUsuarioRolActivo(idUsuario, rolAdmin.id_rol, idNegocio, transaction);
            await rebuildNivelesUsuario(idUsuario, transaction);
        } else {
            console.warn(
                '[Adquirir] Rol ADMINISTRADOR no encontrado para tipo_negocio',
                idTipoNegocio,
                '— el negocio queda sin permisos.'
            );
        }

        await transaction.commit();
    } catch (err) {
        await transaction.rollback();
        console.error('[Adquirir] Error creando la cuenta:', err.message);
        throw err;
    }

    setAuditNegocio(idNegocio);
    await Audit.registrarEvento({
        modulo: 'cobranza',
        accion: 'alta_iniciada',
        idNegocio,
        detalle: { id_usuario: idUsuario, plan: plan.nombre, rubro: rubroElegido.nombre, pasarela },
    });

    // 5. Suscripción + primera factura. Fuera de la transacción a propósito.
    const cobro = await prepararFactura({ idNegocio, plan, complementos, pasarela });

    return {
        id_negocio: idNegocio,
        id_usuario: idUsuario,
        email: correo,
        plan: plan.nombre,
        retomada: false,
        referencia: cobro.referencia,
        lineas: cobro.lineas,
        total: cobro.total,
        moneda: cobro.moneda,
        periodo_inicio: cobro.periodo_inicio,
        periodo_fin: cobro.periodo_fin,
    };
}

/**
 * El alta completa en una sola llamada: cuenta + checkout.
 *
 * Es la ruta original (`POST /publico/adquirir`), que se conserva para no romper a nadie que la
 * esté llamando. La pantalla de compra ya no la usa: crea la cuenta y pide el checkout aparte,
 * para poder confirmarle al comprador que su cuenta quedó hecha aunque el pago falle después.
 */
async function iniciarCompra(datos) {
    const cuenta = await crearCuenta(datos);
    const pago = await reintentarPago(cuenta.referencia, { pasarela: datos.pasarela });
    return { ...cuenta, ...pago, id_negocio: cuenta.id_negocio, plan: cuenta.plan };
}

/**
 * La parte de cobro del alta: suscripción, factura del primer período y enlace de checkout.
 *
 * Vive aparte porque se repite tal cual cuando alguien cierra el checkout sin pagar y vuelve:
 * `generarFacturaPeriodo` es idempotente por referencia, así que reintentar no crea cobros nuevos.
 */
/**
 * Deja la cuenta con su suscripción y su primera factura pendiente, **sin hablar con la pasarela**.
 *
 * Es la mitad del antiguo `prepararCobro`, separada porque el alta ya no es un trámite único que
 * termina pagando: la cuenta se crea y se confirma en su propio paso, y el pago viene después.
 * Quien no pague se queda con su cuenta y su cobro esperando, que es lo que de verdad ocurría
 * antes aunque la pantalla diera a entender lo contrario.
 */
async function prepararFactura({ idNegocio, plan, complementos = [], pasarela }) {
    const suscripcion = await CobranzaService.configurarSuscripcion(idNegocio, {
        id_plan: plan.id_plan,
        ciclo: plan.ciclo,
        moneda: plan.moneda,
        pasarela,
        notas: MARCA_ALTA_WEB,
    });

    // Los complementos se guardan en la suscripción ANTES de facturar: así la primera factura ya
    // los cobra, y cada renovación futura también, porque `generarFacturaPeriodo` suma lo que la
    // suscripción tenga contratado. Es la misma fila que después responde cuántos usuarios y
    // cajas puede tener el negocio (`limitesNegocio`).
    await Dao.fijarComplementosSuscripcion(suscripcion.id_suscripcion, idNegocio, complementos);

    // `desde: hoy` salta las guardas pensadas para la renovación —aquí no hay plan que vencer—
    // y factura el primer ciclo a partir de hoy.
    let { factura, ya_existia } = await CobranzaService.generarFacturaPeriodo(idNegocio, {
        desde: hoyBogota(),
    });

    // Quien vuelve a una compra a medias recibe su factura pendiente de antes (la referencia es
    // la misma). Si entretanto cambió de plan o de complementos, el total de esa factura ya no es
    // verdad: se recalcula antes de abrir el checkout, que cobra exactamente `factura.total`.
    if (ya_existia && factura.estado === 'pendiente') {
        factura = await CobranzaService.recalcularFacturaPendiente(factura.id_factura);
    }

    return {
        factura,
        referencia: factura.referencia,
        lineas: await Dao.listarDetalleFactura(factura.id_factura),
        total: Number(factura.total),
        moneda: factura.moneda,
        periodo_inicio: factura.periodo_inicio,
        periodo_fin: factura.periodo_fin,
    };
}

async function prepararCobro({ idNegocio, plan, complementos = [], pasarela, origen }) {
    const cobro = await prepararFactura({ idNegocio, plan, complementos, pasarela });
    const pago = await CobranzaService.iniciarPago(cobro.factura.id_factura, { pasarela, origen });

    return {
        referencia: cobro.referencia,
        lineas: cobro.lineas,
        total: cobro.total,
        moneda: cobro.moneda,
        periodo_inicio: cobro.periodo_inicio,
        periodo_fin: cobro.periodo_fin,
        url_pago: pago.urlPago ?? null,
        // dLocal no devuelve ningún id al volver del checkout: el navegador lo guarda antes de
        // salir para poder pedir la confirmación a la vuelta (igual que hace /pagar).
        id_externo: pago.idExterno ?? null,
        estado_pago: pago.estado,
        instrucciones: pago.instrucciones ?? null,
    };
}

/**
 * Volver a intentar el pago de un alta que quedó a medias, con la referencia en la mano.
 *
 * No pide la cédula ni el correo: la referencia ya identifica la factura y el checkout que se
 * abre solo sirve para pagar esa. Es el botón «Reintentar» de la pantalla de compra.
 */
async function reintentarPago(referencia, { pasarela } = {}) {
    const factura = await Dao.getFacturaPorReferencia(String(referencia).trim());
    if (!factura) throw error('No encontramos esa compra.', 'COMPRA_NO_ENCONTRADA', 404);

    if (factura.estado === 'pagada') {
        return { ya_pagada: true, referencia: factura.referencia };
    }
    if (factura.estado !== 'pendiente') {
        throw error('Esa compra ya no está disponible.', 'COMPRA_NO_DISPONIBLE', 409);
    }

    const pago = await CobranzaService.iniciarPago(factura.id_factura, {
        pasarela: pasarela || factura.pasarela,
        origen: 'adquirir',
    });

    return {
        ya_pagada: false,
        referencia: factura.referencia,
        total: Number(factura.total),
        moneda: factura.moneda,
        url_pago: pago.urlPago ?? null,
        id_externo: pago.idExterno ?? null,
        estado_pago: pago.estado,
    };
}

/**
 * El estado de una compra, para la pantalla de vuelta del checkout.
 *
 * Responde lo mínimo: si está pagada y con qué usuario entrar. Nada de nombres ni teléfonos —
 * la referencia viaja en la URL y no puede ser la llave de una ficha de cliente.
 */
async function estadoCompra(referencia) {
    const factura = await Dao.getFacturaPorReferencia(String(referencia).trim());
    if (!factura) throw error('No encontramos esa compra.', 'COMPRA_NO_ENCONTRADA', 404);

    const [usuario] = await sequelize.query(
        `SELECT u.email
           FROM general.gener_usuario u
           JOIN general.gener_negocio_usuario nu ON nu.id_usuario = u.id_usuario
          WHERE nu.id_negocio = :idNegocio AND nu.estado = 'A'
          ORDER BY u.id_usuario ASC
          LIMIT 1;`,
        { replacements: { idNegocio: factura.id_negocio }, type: sequelize.QueryTypes.SELECT }
    );

    return {
        referencia: factura.referencia,
        estado: factura.estado, // pendiente | pagada | fallida | anulada
        total: Number(factura.total),
        moneda: factura.moneda,
        pagada_en: factura.fecha_pago ?? null,
        periodo_fin: factura.periodo_fin ?? null,
        email: usuario?.email ?? null,
    };
}

/**
 * ¿Este pago estrena una cuenta comprada por la web? Entonces hay que mandar las credenciales.
 *
 * Lo llama el webhook **con cada pago aplicado**, así que las tres condiciones importan y son
 * estrictas a propósito:
 *
 *   1. la suscripción lleva la marca de este flujo (`MARCA_ALTA_WEB`),
 *   2. es la primera factura pagada del negocio,
 *   3. el dueño todavía no ha cambiado su contraseña.
 *
 * Sin la primera, un cliente de siempre que pague su primera factura por el portal recibiría un
 * correo diciéndole que su contraseña es su cédula — que ni es verdad ni es inofensivo. Sin la
 * tercera, un segundo cobro tras reactivar una cuenta lo repetiría.
 *
 * Se miden contando, no con una bandera nueva: una columna más es una migración y un estado que
 * puede quedar mal; esto ya está en la base.
 */
async function notificarAltaPagada(idNegocio, referencia) {
    const [alta] = await sequelize.query(
        `SELECT 1 AS ok
           FROM cobranza.cob_suscripcion
          WHERE id_negocio = :idNegocio AND notas = :marca
          LIMIT 1;`,
        {
            replacements: { idNegocio, marca: MARCA_ALTA_WEB },
            type: sequelize.QueryTypes.SELECT,
        }
    );
    if (!alta) return { enviado: false, motivo: 'no es un alta comprada por la web' };

    const [fila] = await sequelize.query(
        `SELECT COUNT(*)::int AS pagadas
           FROM cobranza.cob_factura
          WHERE id_negocio = :idNegocio AND estado = 'pagada';`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
    );
    if (!fila || fila.pagadas !== 1) return { enviado: false, motivo: 'no es el primer pago' };

    const [datos] = await sequelize.query(
        `SELECT u.email, u.primer_nombre, u.num_identificacion, n.nombre AS negocio
           FROM general.gener_usuario u
           JOIN general.gener_negocio_usuario nu ON nu.id_usuario = u.id_usuario
           JOIN general.gener_negocio n ON n.id_negocio = nu.id_negocio
          WHERE nu.id_negocio = :idNegocio AND nu.estado = 'A' AND u.debe_cambiar_password = true
          ORDER BY u.id_usuario ASC
          LIMIT 1;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
    );
    if (!datos) return { enviado: false, motivo: 'sin usuario que estrene la cuenta' };

    await MailService.sendWelcomeEmail(datos.email, datos.primer_nombre, datos.num_identificacion);

    MailService.sendAdminNotificationEmail({
        nombre: datos.primer_nombre,
        numIdentificacion: datos.num_identificacion,
        email: datos.email,
        tipoNegocio: `${datos.negocio} — alta pagada (${referencia})`,
        fechaRegistro: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
    }).catch((e) => console.error('[Adquirir] Error notificando al admin:', e.message));

    console.info(`[Adquirir] Alta pagada y credenciales enviadas: negocio=${idNegocio} ref=${referencia}`);
    return { enviado: true };
}

module.exports = {
    CODIGOS_OFRECIDOS,
    catalogoCompra,
    resolverPlan,
    crearCuenta,
    iniciarCompra,
    reintentarPago,
    estadoCompra,
    notificarAltaPagada,
};
