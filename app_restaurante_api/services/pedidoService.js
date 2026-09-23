const Models = require('../../app_core/models/conection');
const cajaService = require('./cajaService');
const puntoCajaService = require('./puntoCajaService');
const { avisar, avisarTrasCommit, TEMAS } = require('./avisoService');
const cuentaService = require('./cuentaService');
const horarioService = require('./horarioService');
const personaNegocioDao = require('../../app_core/dao/personaNegocioDao');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');
// La costura de entitlements (ADR-021). Es lo único que este servicio sabe de lo comercial, y
// pregunta por la FEATURE, nunca por el nombre del plan.
const features = require('../../intelligence/core/features');
// El estado de entrega de un aviso vive en el Ledger, y leerlo desde aquí sería que la vertical
// supiera de `intelligence.mensaje`. Se pregunta al adaptador, que es la frontera (ADR-009). No
// cierra ciclo: `avisoPedido` lee la orden con SQL en crudo justamente para no depender de este
// servicio.
const avisoPedido = require('../../intelligence/adapters/restaurante/avisoPedido');
const { Op } = require('sequelize');

const SUBNIVEL_CANCELAR_NO_PAGADO = 'despacho_cancelar_no_pagado';
const SUBNIVEL_VER_TODOS = 'despacho_ver_todos';

/**
 * pedidoService — Lógica de negocio para órdenes / pedidos del restaurante.
 *
 * Reglas de caja (ver cajaService):
 *  - crearOrden, agregarItemsOrden y cerrarOrden requieren caja abierta.
 *  - cerrarOrden registra automáticamente un movimiento INGRESO en la caja
 *    activa y persiste id_caja en la orden.
 */

function buildStockInsuficienteError(faltantes) {
    const error = new Error('No hay stock suficiente para uno o más ingredientes.');
    error.code = 'STOCK_INSUFICIENTE';
    error.statusCode = 409;
    error.faltantes = faltantes;
    return error;
}

function normalizePermissionCode(rawCode = '') {
    return String(rawCode)
        .trim()
        .toLowerCase()
        .replace(/^\/+/, '')
        .replace(/\//g, '_');
}

function isAdminRoleName(nombreRol = '') {
    return String(nombreRol).toUpperCase().includes('ADMINISTRADOR');
}

async function usuarioPuedeCancelarPedidoNoPagado({ idUsuario, idNegocio }) {
    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
            [Op.or]: [{ id_negocio: idNegocio }, { id_negocio: null }],
        },
        attributes: ['id_rol'],
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            required: true,
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    if (!rolesUsuario.length) return false;

    const roles = rolesUsuario
        .map((r) => ({
            id_rol: Number(r.id_rol),
            descripcion: String(r.rol?.descripcion || ''),
        }))
        .filter((r) => Number.isInteger(r.id_rol));

    if (!roles.length) return false;
    if (roles.some((r) => isAdminRoleName(r.descripcion))) return true;

    const roleIds = [...new Set(roles.map((r) => r.id_rol))];
    const whereNivelCodigo = normalizePermissionCode(SUBNIVEL_CANCELAR_NO_PAGADO);

    const permisoNegocio = await Models.GenerNivelNegocio.findOne({
        where: {
            id_negocio: idNegocio,
            id_rol: roleIds,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_nivel_negocio'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                url: whereNivelCodigo,
            },
            attributes: ['id_nivel'],
        }],
    });
    if (permisoNegocio) return true;

    const permisoGlobal = await Models.GenerRolNivel.findOne({
        where: {
            id_rol: roleIds,
            estado: 'A',
            puede_ver: true,
        },
        attributes: ['id_rol_nivel'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 4,
                url: whereNivelCodigo,
            },
            attributes: ['id_nivel'],
        }],
    });

    return Boolean(permisoGlobal);
}

async function usuarioPuedeVerTodosDespacho({ idUsuario, idNegocio }) {
    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: {
            id_usuario: idUsuario,
            estado: 'A',
            [Op.or]: [{ id_negocio: idNegocio }, { id_negocio: null }],
        },
        attributes: ['id_rol'],
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            required: true,
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    if (!rolesUsuario.length) return false;

    const roles = rolesUsuario
        .map((r) => ({
            id_rol: Number(r.id_rol),
            descripcion: String(r.rol?.descripcion || ''),
        }))
        .filter((r) => Number.isInteger(r.id_rol));

    if (!roles.length) return false;
    if (roles.some((r) => isAdminRoleName(r.descripcion))) return true;

    const roleIds = [...new Set(roles.map((r) => r.id_rol))];
    const whereNivelCodigo = normalizePermissionCode(SUBNIVEL_VER_TODOS);

    const nivelInclude = {
        model: Models.GenerNivel,
        as: 'nivel',
        required: true,
        where: { estado: 'A', id_tipo_nivel: 4, url: whereNivelCodigo },
        attributes: ['id_nivel'],
    };

    const permisoNegocio = await Models.GenerNivelNegocio.findOne({
        where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: true },
        attributes: ['id_nivel_negocio'],
        include: [nivelInclude],
    });
    if (permisoNegocio) return true;

    // Si el negocio denegó explícitamente este permiso, no consultar el global.
    const negadoNegocio = await Models.GenerNivelNegocio.findOne({
        where: { id_negocio: idNegocio, id_rol: roleIds, estado: 'A', puede_ver: false },
        attributes: ['id_nivel_negocio'],
        include: [nivelInclude],
    });
    if (negadoNegocio) return false;

    const permisoGlobal = await Models.GenerRolNivel.findOne({
        where: { id_rol: roleIds, estado: 'A', puede_ver: true },
        attributes: ['id_rol_nivel'],
        include: [nivelInclude],
    });

    return Boolean(permisoGlobal);
}

/**
 * Genera el siguiente número de orden para un negocio.
 */
async function generarNumeroOrden(idNegocio) {
    const [result] = await Models.sequelize.query(`
        SELECT COALESCE(MAX(CAST(SUBSTRING(numero_orden FROM 5) AS INTEGER)), 0) + 1 AS siguiente
        FROM restaurante.pedid_orden
        WHERE id_negocio = :idNegocio
    `, {
        replacements: { idNegocio },
        type: Models.sequelize.QueryTypes.SELECT,
    });
    const num = String(result.siguiente).padStart(4, '0');
    return `ORD-${num}`;
}

/**
 * ¿Este negocio lleva control de inventario?
 *
 * Es un opt-OUT (`gener_negocio.controla_inventario`, ENCENDIDO por defecto): la mayoría de
 * los negocios pequeños no tienen la receta cargada, así que la comprobación de stock solo
 * les servía para que el POS les preguntara en cada venta por insumos que nunca registraron.
 *
 * Si el negocio no aparece, se responde que SÍ controla: ante la duda se conserva el
 * comportamiento de siempre, nunca se retira una comprobación por un dato que falta.
 */
async function negocioControlaInventario(idNegocio, { transaction = null } = {}) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'controla_inventario'],
        transaction,
    });
    return negocio ? negocio.controla_inventario !== false : true;
}

/**
 * Descuenta del inventario los insumos que se lleva el pedido, y rechaza el pedido si no
 * alcanzan (salvo que quien llama ya haya aceptado dejar el stock en negativo).
 *
 * Con el control de inventario apagado no hace NADA: ni consulta, ni bloquea, ni descuenta.
 * Descontar sin bloquear habría sido la media tinta peor de las dos — el negocio que apaga
 * esto no lleva stock, y dejarle los insumos cayendo a negativo llena Inventario de alertas
 * rojas que son justo lo que quería quitarse de encima.
 *
 * La comprobación vive AQUÍ y no en quien llama a propósito: son dos rutas las que mueven
 * inventario (tomar el pedido y añadirle ítems) y mañana pueden ser tres. Preguntarlo en el
 * punto donde se toca el stock hace imposible que una ruta nueva se olvide.
 */
async function consumirIngredientesPorItems({ idNegocio, items, permitirStockNegativo = false, transaction }) {
    if (!(await negocioControlaInventario(idNegocio, { transaction }))) return;

    const ingredientesNecesarios = new Map();

    for (const item of items) {
        const receta = await Models.CartaProductoIngred.findAll({
            where: {
                id_producto: item.id_producto,
                estado: 'A',
            },
            attributes: ['id_ingrediente', 'porcion'],
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                where: { id_negocio: idNegocio, estado: 'A' },
                required: true,
                attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
            }],
            transaction,
        });

        const excluidas = new Set(item.exclusiones || []);
        receta.forEach((recetaIng) => {
            if (excluidas.has(recetaIng.id_ingrediente)) return;

            const porcion = Number(recetaIng.porcion || 0);
            if (porcion <= 0) return;

            const consumo = porcion * Number(item.cantidad || 1);
            const entry = ingredientesNecesarios.get(recetaIng.id_ingrediente);

            if (entry) {
                entry.consumo += consumo;
            } else {
                ingredientesNecesarios.set(recetaIng.id_ingrediente, {
                    id_ingrediente: recetaIng.id_ingrediente,
                    nombre: recetaIng.ingrediente?.nombre || 'Ingrediente',
                    consumo,
                });
            }
        });
    }

    if (ingredientesNecesarios.size === 0) return;

    const idsIngredientes = Array.from(ingredientesNecesarios.keys());
    const ingredientesStock = await Models.CartaIngrediente.findAll({
        where: {
            id_negocio: idNegocio,
            id_ingrediente: idsIngredientes,
            estado: 'A',
        },
        attributes: ['id_ingrediente', 'nombre', 'stock_actual'],
        transaction,
        lock: transaction.LOCK.UPDATE,
    });

    const stockMap = new Map(ingredientesStock.map((i) => [
        i.id_ingrediente,
        Number(i.stock_actual ?? 0),
    ]));

    const faltantes = [];
    for (const reqIng of ingredientesNecesarios.values()) {
        const stock = stockMap.get(reqIng.id_ingrediente);
        if (stock === undefined) {
            throw new Error(`Ingrediente no encontrado en inventario: ${reqIng.nombre}`);
        }
        if (stock < reqIng.consumo) {
            faltantes.push({
                id_ingrediente: reqIng.id_ingrediente,
                nombre: reqIng.nombre,
                stock_actual: stock,
                requerido: reqIng.consumo,
                faltante: reqIng.consumo - stock,
            });
        }
    }

    if (faltantes.length > 0 && !permitirStockNegativo) {
        throw buildStockInsuficienteError(faltantes);
    }

    for (const ing of ingredientesStock) {
        const consumo = ingredientesNecesarios.get(ing.id_ingrediente)?.consumo || 0;
        if (consumo <= 0) continue;

        const nuevoStock = Number(ing.stock_actual ?? 0) - consumo;
        await ing.update({ stock_actual: nuevoStock }, { transaction });
    }

    // El pedido que se acaba de tomar pudo dejar sin stock un ingrediente que usan OTROS
    // productos, no solo los de esta orden — dos platos que comparten una papa, por ejemplo.
    // Sin esto, el bot seguía ofreciendo algo que ya no se puede preparar, y el cliente se
    // enteraba de que no había hasta después de pedirlo y confirmarlo: la peor forma posible
    // de decir que no hay.
    await desactivarProductosSinStock({
        idNegocio,
        idsIngredientes: Array.from(ingredientesNecesarios.keys()),
        transaction,
    });
}

/**
 * Apaga `disponible` en cualquier producto ACTIVO cuya receta ya no se pueda preparar con el
 * stock que quedó tras un consumo.
 *
 * ## Por qué mira TODOS los productos que usan estos ingredientes, no solo los del pedido
 *
 * Un ingrediente compartido —la misma papa en dos platos distintos— puede dejar sin stock a un
 * producto que ni siquiera estaba en esta orden. Revisar solo lo que se acaba de pedir dejaría
 * ese otro plato ofreciéndose igual, con cero unidades posibles.
 *
 * ## Por qué NO vuelve a encender nada
 *
 * Es deliberadamente de una sola vía. Si se reabasteciera el ingrediente y esto reactivara el
 * producto solo, un negocio que lo apagó por otra razón —cambió la receta, es de temporada, lo
 * retiró de la carta— lo vería reaparecer sin haberlo decidido. Volver a activarlo es una
 * decisión del negocio, a mano, desde Configuración de la carta — igual que hoy.
 */
async function desactivarProductosSinStock({ idNegocio, idsIngredientes, transaction }) {
    if (!idsIngredientes || idsIngredientes.length === 0) return;

    const candidatos = await Models.CartaProducto.findAll({
        where: { id_negocio: idNegocio, estado: 'A', disponible: true },
        attributes: ['id_producto', 'nombre'],
        include: [{
            model: Models.CartaProductoIngred,
            as: 'ingredientes',
            where: { estado: 'A', id_ingrediente: idsIngredientes },
            required: true,
            attributes: ['id_producto'],
        }],
        transaction,
    });
    if (candidatos.length === 0) return;

    for (const producto of candidatos) {
        const receta = await Models.CartaProductoIngred.findAll({
            where: { id_producto: producto.id_producto, estado: 'A' },
            attributes: ['id_ingrediente', 'porcion'],
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                where: { id_negocio: idNegocio, estado: 'A' },
                required: true,
                attributes: ['stock_actual'],
            }],
            transaction,
        });

        const alcanzaParaUno = receta.every((r) => {
            const porcion = Number(r.porcion || 0);
            if (porcion <= 0) return true;
            return Number(r.ingrediente?.stock_actual ?? 0) >= porcion;
        });

        if (!alcanzaParaUno) {
            await Models.CartaProducto.update(
                { disponible: false },
                { where: { id_producto: producto.id_producto }, transaction }
            );
            console.log(
                `[inventario] "${producto.nombre}" (id ${producto.id_producto}) se apagó solo: ` +
                    'ya no hay stock para preparar uno más.'
            );
        }
    }
}

async function crearDetallesOrden({ idOrden, items, transaction }) {
    for (const item of items) {
        const detalle = await Models.PedidDetalle.create({
            id_orden: idOrden,
            id_producto: item.id_producto,
            cantidad: item.cantidad,
            precio_unitario: item.precio_unitario,
            subtotal: item.precio_unitario * item.cantidad,
            nota: item.nota || null,
            estado: 'PENDIENTE',
        }, { transaction });

        if (item.exclusiones && item.exclusiones.length > 0) {
            const exclusiones = item.exclusiones.map(idIng => ({
                id_detalle: detalle.id_detalle,
                id_ingrediente: idIng,
            }));
            await Models.PedidDetalleExclu.bulkCreate(exclusiones, { transaction });
        }
    }
}

async function validarMetodoPagoParaNegocio({ idMetodoPago, idNegocio, transaction }) {
    if (!idMetodoPago) return null;

    const mp = await Models.RestMetodoPago.findOne({
        where: { id_metodo_pago: idMetodoPago, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!mp) {
        const e = new Error('Método de pago inválido para este negocio.');
        e.statusCode = 422;
        e.code = 'METODO_PAGO_INVALIDO';
        throw e;
    }
    return mp;
}

/**
 * Normaliza el valor del domicilio que se cobra al cliente.
 *
 * Devuelve 0 salvo que el negocio tenga `permite_pago_domicilio` activo y el pedido
 * sea LLEVAR o DOMICILIO. Es una funcionalidad opt-in: para un negocio que no la
 * activó, cualquier valor que llegue en el body se ignora y la orden se comporta
 * exactamente como antes.
 */
async function resolverValorDomicilio({ idNegocio, tipoPedido, valorDomicilio, transaction }) {
    const monto = Number(valorDomicilio);
    if (!Number.isFinite(monto) || monto <= 0) return 0;
    if (!['LLEVAR', 'DOMICILIO'].includes(tipoPedido)) return 0;

    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_pago_domicilio'],
        transaction,
    });
    if (!negocio || !negocio.permite_pago_domicilio) return 0;

    return Math.round(monto * 100) / 100;
}

/**
 * Normaliza el descuento de una orden.
 *  - 0 si el negocio no tiene `permite_descuento` (opt-in, ver Configuración).
 *  - Nunca mayor que `baseCobrable`, cuando se conoce: un descuento no puede dejar el
 *    total en negativo. Sin ella el recorte queda para `recalcularTotalesOrden`, que
 *    conoce el subtotal definitivo.
 * `undefined` significa "el body no lo trae": el llamante conserva lo que ya tuviera la orden.
 */
async function resolverDescuento({ idNegocio, descuento, baseCobrable = null, transaction }) {
    const monto = Number(descuento);
    if (!Number.isFinite(monto) || monto <= 0) return 0;

    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_descuento'],
        transaction,
    });
    if (!negocio || !negocio.permite_descuento) return 0;

    // `baseCobrable` ausente se comprueba contra null ANTES de convertir: `Number(null)`
    // es 0, no NaN, así que con `Number.isFinite` el «no me dieron base» se leía como
    // «la base es 0» y el descuento se acotaba a cero. Por eso las rutas que no pasan
    // base —`actualizarDescuento` y `agregarItemsOrden`— guardaban siempre 0.
    const base = baseCobrable == null ? null : Number(baseCobrable);
    const acotado = base !== null && Number.isFinite(base)
        ? Math.min(monto, Math.max(base, 0))
        : monto;
    return Math.round(acotado * 100) / 100;
}

async function recalcularTotalesOrden({ idOrden, porcentajeImpuesto = 0, valorDomicilio, descuento, transaction }) {
    const subtotalRaw = await Models.PedidDetalle.sum('subtotal', {
        where: { id_orden: idOrden },
        transaction,
    });
    const subtotal = Number(subtotalRaw ?? 0);
    const impuesto = Math.round(subtotal * porcentajeImpuesto * 100) / 100;

    // Con `valorDomicilio`/`descuento` ausentes se relee lo que ya tenga la orden: quien
    // solo agrega productos no debe perder el domicilio ni el descuento ya pactados.
    const guardada = await Models.PedidOrden.findByPk(idOrden, {
        attributes: ['id_orden', 'valor_domicilio', 'descuento'],
        transaction,
    });

    // El domicilio lo paga el cliente, así que viaja DENTRO de `total`: el multipago
    // y el cierre de caja cuadran siempre contra un único número.
    let domicilio = Number(valorDomicilio);
    if (!Number.isFinite(domicilio) || domicilio < 0) {
        domicilio = Number(guardada?.valor_domicilio ?? 0);
    }

    // El descuento viaja RESTADO dentro de `total`, por el mismo motivo.
    let rebaja = Number(descuento);
    if (!Number.isFinite(rebaja) || rebaja < 0) {
        rebaja = Number(guardada?.descuento ?? 0);
    }
    // Al quitar productos la base baja: se recorta el descuento para no bajar de cero.
    rebaja = Math.min(rebaja, subtotal + impuesto + domicilio);

    const total = subtotal + impuesto + domicilio - rebaja;

    await Models.PedidOrden.update(
        { subtotal, impuesto, total, valor_domicilio: domicilio, descuento: rebaja },
        { where: { id_orden: idOrden }, transaction }
    );
}

/**
 * Crea una orden completa con sus detalles y exclusiones.
 *
 * @param {Object} params
 * @param {number} params.idNegocio
 * @param {number} params.idUsuario
 * @param {number|null} params.idMesa
 * @param {string} [params.nota]
 * @param {Array}  params.items — [{ id_producto, cantidad, precio_unitario, nota, exclusiones: [id_ingrediente] }]
 * @param {number} params.porcentajeImpuesto — ej: 0.19
 */
async function crearOrden({
    idNegocio, idMetodoPago = null, idCuenta = null, pagos = null, idUsuario, idMesa, nota, items, porcentajeImpuesto = 0, permitirStockNegativo = false,
    // En qué caja (rubro) va el pedido. Opcional: con una sola caja —o una sola asignada al
    // usuario— se resuelve sola y el POS no pregunta nada. Con varias sin elegir, el servicio
    // devuelve PUNTO_CAJA_REQUERIDO con la lista para que el POS muestre el selector.
    idPuntoCaja = null,
    tipoPedido = 'MESA', contactoNombre = null, contactoTelefono = null,
    direccionDomicilio = null, notaDomicilio = null, idDomiciliario = null,
    valorDomicilio = 0, descuento = 0,
}, { transaction = null } = {}) {
    // Si el llamante trae su propia transacción, esta función NO la confirma ni la deshace:
    // solo trabaja dentro. Quien la abre, la cierra.
    //
    // Hace falta para que el Policy Gate de Intelligence pueda invocar esto: el Gate envuelve
    // toda ejecución en una transacción propia —así el `dry-run` es genérico y no algo que cada
    // capacidad deba implementar y olvidar—, y una transacción anidada aquí dentro haría que ni
    // el dry-run deshiciera nada ni el rollback del Gate alcanzara a la orden. Es el mismo paso
    // que F3 dio en `reserva` con `citaService.crearCita`.
    //
    // El POS sigue llamando sin opciones y se comporta exactamente igual que antes.
    const transaccionPropia = !transaction;
    const t = transaction || (await Models.sequelize.transaction());
    try {
        const punto = await puntoCajaService.resolverPuntoCaja({
            idNegocio, idUsuario, idPuntoCaja, transaction: t,
        });
        await cajaService.requireCajaAbierta(idNegocio, { punto, transaction: t });

        if (tipoPedido === 'DOMICILIO' && idDomiciliario) {
            const valido = await esDomiciliarioValido({ idNegocio, idDomiciliario, transaction: t });
            if (!valido) {
                const e = new Error('Ese domiciliario no existe o no está activo en este negocio.');
                e.code = 'DOMICILIARIO_INVALIDO'; e.statusCode = 422;
                throw e;
            }
        }

        const numeroOrden = await generarNumeroOrden(idNegocio);

        await consumirIngredientesPorItems({
            idNegocio,
            items,
            permitirStockNegativo,
            transaction: t,
        });

        await validarMetodoPagoParaNegocio({
            idMetodoPago,
            idNegocio,
            transaction: t,
        });

        // Calcular totales
        let subtotal = 0;
        items.forEach(item => {
            subtotal += item.precio_unitario * item.cantidad;
        });
        const impuesto = Math.round(subtotal * porcentajeImpuesto * 100) / 100;

        // Valor del domicilio (opt-in por negocio). Se cobra al cliente dentro del
        // total y sale como EGRESO de caja cuando la orden se cobra.
        const domicilio = await resolverValorDomicilio({
            idNegocio,
            tipoPedido,
            valorDomicilio,
            transaction: t,
        });

        const rebaja = await resolverDescuento({
            idNegocio,
            descuento,
            baseCobrable: subtotal + impuesto + domicilio,
            transaction: t,
        });

        const total = subtotal + impuesto + domicilio - rebaja;

        // Resolver la identidad del cliente (platform.persona_negocio). Es best-effort a
        // propósito: si falla, la orden se crea igual con id_persona_negocio = NULL — una
        // vertical funciona sin persona (ADR-006). Devuelve null también cuando el teléfono
        // no es utilizable, que es el caso del ~5% de lo que se captura.
        //
        // ⚠️ **No solo el domicilio.** Hasta el 2026-09-08 esto era `=== 'DOMICILIO'`, de cuando
        // un «para llevar» solo podía ser alguien de pie en el mostrador. Desde que el asistente
        // toma pedidos para recoger, un LLEVAR también tiene una persona detrás con su número.
        const conCliente = tipoPedido === 'DOMICILIO' || tipoPedido === 'LLEVAR';
        const idPersonaNegocio =
            conCliente && contactoTelefono
                ? await personaNegocioDao.resolverOCrearBestEffort(
                      { idNegocio, telefono: contactoTelefono, nombre: contactoNombre },
                      { transaction: t }
                  )
                : null;

        // 1. Crear la orden
        const orden = await Models.PedidOrden.create({
            id_negocio: idNegocio,
            id_punto_caja: punto.id_punto_caja,
            id_usuario: idUsuario,
            numero_orden: numeroOrden,
            id_mesa: tipoPedido === 'MESA' ? (idMesa || null) : null,
            nota,
            subtotal,
            impuesto,
            total,
            estado: 'ABIERTA',
            id_metodo_pago: idMetodoPago || null,
            // Intención, igual que la forma de pago: se guarda al tomar el pedido para que
            // cobrar desde Mesas o Despacho no vuelva a preguntar de quién es la tiquetera.
            // Nada se descuenta hasta el cobro.
            id_cuenta: idCuenta || null,
            tipo_pedido: tipoPedido,
            valor_domicilio: domicilio,
            descuento: rebaja,
            id_persona_negocio:  idPersonaNegocio,
            // Quién es el cliente y su nota valen para LLEVAR igual que para DOMICILIO: los dos
            // son pedidos de despacho con una persona esperando. Descartarlos en LLEVAR fue un
            // fallo real: los pedidos que el asistente tomaba para recoger nacían sin nombre ni
            // teléfono, y el botón de «ya está listo» no tenía a quién escribirle. Un MESA sí
            // los deja nulos: ahí lo que hay es una mesa, no una persona a la que avisar.
            contacto_nombre:     conCliente ? contactoNombre   : null,
            contacto_telefono:   conCliente ? contactoTelefono : null,
            // Éstas sí son solo del domicilio: no hay a dónde llevar un pedido que se recoge.
            direccion_domicilio: tipoPedido === 'DOMICILIO' ? direccionDomicilio : null,
            // La nota la pinta el despacho como «Nota» para cualquier tipo, así que se guarda
            // también en LLEVAR — «sin cebolla» importa lo mismo se recoja o se lleve.
            nota_domicilio:      conCliente ? notaDomicilio    : null,
            id_domiciliario:     tipoPedido === 'DOMICILIO' ? (idDomiciliario || null) : null,
        }, { transaction: t });

        await crearDetallesOrden({
            idOrden: orden.id_orden,
            items,
            transaction: t,
        });

        // Multipago elegido al tomar el pedido: se guarda ya, aunque el cobro venga
        // después, para que Despacho y Mesas lo muestren y lo puedan editar.
        if (Array.isArray(pagos) && pagos.length > 0) {
            await validarYGuardarPagos({ orden, pagos, transaction: t, exigirCuadre: false });
        }

        // Va ANTES del commit porque se registra un gancho, no se emite: Sequelize lo dispara
        // solo si esta transacción confirma. Con la transacción del Policy Gate —que simula y
        // deshace— eso es la diferencia entre avisar de un pedido real y mandar a doce tablets
        // a buscar uno que nunca existió.
        avisarTrasCommit(
            t,
            idNegocio,
            TEMAS.PEDIDOS,
            ...(idMesa ? [TEMAS.MESAS] : []),
        );

        if (transaccionPropia) await t.commit();

        // Retornar orden con detalles. Con transacción ajena aún sin confirmar hay que leer
        // DENTRO de ella: desde fuera, la orden que se acaba de crear todavía no existe.
        return getOrdenById(orden.id_orden, { transaction: transaccionPropia ? null : t });
    } catch (err) {
        if (transaccionPropia) await t.rollback();
        throw err;
    }
}

/**
 * Agrega items a una orden ABIERTA existente (flujo de ajuste POS por mesa).
 */
async function agregarItemsOrden({
    idOrden,
    idNegocio,
    idMetodoPago = null,
    idCuenta = null,
    pagos = null,
    nota,
    items,
    porcentajeImpuesto = 0,
    permitirStockNegativo = false,
    valorDomicilio,
    descuento,
}) {
    const t = await Models.sequelize.transaction();
    try {
        // La caja la manda el pedido, no quien añade los productos.
        await cajaService.requireCajaAbierta(idNegocio, {
            punto: await cajaService.puntoDeOrden({ idOrden, transaction: t }),
            transaction: t,
        });

        const orden = await Models.PedidOrden.findOne({
            where: {
                id_orden: idOrden,
                id_negocio: idNegocio,
                estado: 'ABIERTA',
            },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!orden) {
            throw new Error('ORDEN_NO_ENCONTRADA');
        }

        await validarMetodoPagoParaNegocio({
            idMetodoPago,
            idNegocio,
            transaction: t,
        });

        await consumirIngredientesPorItems({
            idNegocio,
            items,
            permitirStockNegativo,
            transaction: t,
        });

        await crearDetallesOrden({
            idOrden,
            items,
            transaction: t,
        });

        const patchOrden = {};
        if (typeof nota === 'string') {
            patchOrden.nota = nota.trim() || null;
        }
        if (idMetodoPago) {
            patchOrden.id_metodo_pago = idMetodoPago;
        }
        if (idCuenta !== undefined && idCuenta !== null) {
            patchOrden.id_cuenta = idCuenta;
        }
        if (Object.keys(patchOrden).length > 0) {
            await orden.update(patchOrden, { transaction: t });
        }

        // Sin `valor_domicilio` en el body se deja el que ya tenía la orden.
        const domicilio = valorDomicilio === undefined
            ? undefined
            : await resolverValorDomicilio({
                idNegocio,
                tipoPedido: orden.tipo_pedido,
                valorDomicilio,
                transaction: t,
            });

        // Ídem con el descuento. Aquí solo se valida contra el flag del negocio: el
        // recorte contra el total lo hace `recalcularTotalesOrden`, que ya conoce el
        // subtotal con los productos recién agregados.
        const rebaja = descuento === undefined
            ? undefined
            : await resolverDescuento({ idNegocio, descuento, transaction: t });

        await recalcularTotalesOrden({
            idOrden,
            porcentajeImpuesto,
            valorDomicilio: domicilio,
            descuento: rebaja,
            transaction: t,
        });

        // Sobre una orden ya cobrada el desglose es el pago real y no se toca; aquí
        // solo se corrige la intención de una orden que sigue pendiente de pago.
        if (orden.estado_pago !== 'pagado') {
            if (Array.isArray(pagos) && pagos.length > 0) {
                await validarYGuardarPagos({ orden, pagos, transaction: t, exigirCuadre: false });
            } else if (idMetodoPago) {
                // Volvió a pago simple: el desglose que había queda obsoleto.
                await Models.RestPagoOrden.destroy({ where: { id_orden: idOrden }, transaction: t });
            }
        }

        avisarTrasCommit(
            t,
            idNegocio,
            TEMAS.PEDIDOS,
            TEMAS.MESAS,
            // Agregar productos a una orden que ya está en cocina cambia la comanda.
            TEMAS.COCINA,
        );

        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/**
 * Agrega ítems a un pedido YA PUESTO, A PETICIÓN DEL PROPIO CLIENTE (asistente de WhatsApp,
 * Policy Gate).
 *
 * No es `agregarItemsOrden` con otro nombre: esa es la función del POS y conoce método de
 * pago, cuenta de cliente, multipago, descuento y valor de domicilio — nada de eso es una
 * decisión que un cliente deba poder tocar por WhatsApp con un "también quiero...". Tampoco
 * acepta `{ transaction }`, el mismo obstáculo #1 que ya tuvo `tomar_pedido`: el Policy Gate
 * envuelve toda invocación en su propia transacción para que el dry-run sea genérico, y sin
 * esto la adición de prueba de un dry-run se habría confirmado igual.
 *
 * Misma ventana de negocio que `cancelarPorCliente`: **la cocina no puede haber empezado a
 * prepararlo.** Agregar algo después de que el resto ya se está cocinando es una comanda que
 * llega tarde y a medias — el negocio tiene que enterarse por teléfono, no por una comanda
 * fantasma apareciendo sola en la pantalla de cocina.
 */
async function agregarItemsPorCliente(idOrden, { idNegocio, items, transaction }) {
    const orden = await Models.PedidOrden.findOne({
        where: { id_orden: idOrden, id_negocio: idNegocio },
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!orden) {
        const e = new Error('No encuentro ese pedido.');
        e.code = 'PEDIDO_NO_ENCONTRADO'; e.statusCode = 404;
        throw e;
    }
    if (orden.estado !== 'ABIERTA') {
        const e = new Error('Ese pedido ya no está abierto y no le puedo agregar nada. Llama al restaurante.');
        e.code = 'ORDEN_NO_ABIERTA'; e.statusCode = 409;
        throw e;
    }
    if (orden.estado_pago === 'pagado') {
        const e = new Error('Ese pedido ya se cobró y no le puedo agregar nada. Llama al restaurante.');
        e.code = 'ORDEN_NO_EDITABLE'; e.statusCode = 409;
        throw e;
    }
    // Misma regla y mismo comentario que en `cancelarPorCliente`: `estado_cocina` es NULL
    // hasta que el restaurante lo manda a preparar, y solo entonces avanza a
    // EN_PREPARACION/LISTO. NULL o PENDIENTE = todavía no se ha tocado nada en cocina.
    if (['EN_PREPARACION', 'LISTO'].includes(orden.estado_cocina)) {
        const e = new Error(
            'Tu pedido ya está en preparación y no le puedo agregar nada. Llama al restaurante.'
        );
        e.code = 'ORDEN_EN_PREPARACION'; e.statusCode = 409;
        throw e;
    }

    try {
        await cajaService.requireCajaAbierta(idNegocio, { transaction });
    } catch (_) {
        const e = new Error('El restaurante está cerrado ahora mismo y no puedo agregar nada al pedido.');
        e.code = 'RESTAURANTE_CERRADO'; e.statusCode = 409;
        throw e;
    }

    await consumirIngredientesPorItems({
        idNegocio,
        items,
        permitirStockNegativo: false,
        transaction,
    });

    await crearDetallesOrden({ idOrden, items, transaction });

    // Sin impuesto ni domicilio ni descuento nuevos: `recalcularTotalesOrden` relee lo que la
    // orden ya tenía pactado y solo suma el subtotal de lo recién agregado. Es la misma
    // decisión que `tomar_pedido`, que tampoco pregunta impuesto.
    await recalcularTotalesOrden({ idOrden, porcentajeImpuesto: 0, transaction });

    avisarTrasCommit(transaction, idNegocio, TEMAS.PEDIDOS, TEMAS.MESAS, TEMAS.COCINA);
    return getOrdenById(idOrden, { transaction });
}

/**
 * Quita (reduce o borra) items de una orden ABIERTA existente.
 *
 * Simétrica de `agregarItemsOrden`: mismo flujo de edición desde Despacho/Mesas, pero
 * para lo que el usuario retiró del pedido. Antes de esto no existía manera de que un
 * producto quitado en el POS dejara de estar en la orden — el edit solo podía AGREGAR,
 * así que quitar algo en pantalla no se reflejaba en el backend y volvía a aparecer.
 *
 * Empareja por la misma clave que agrupa en el frontend (producto + exclusiones + nota):
 * reduce la cantidad del detalle que matchea, o lo borra si se queda en cero. Si piden
 * quitar más de lo que hay, se quita lo que exista y se ignora el resto en silencio —no
 * hay nada más que restar.
 *
 * Igual que `cancelarOrden`, el stock consumido NO se restaura: es la misma decisión ya
 * tomada para pedidos cancelados, y automatizarlo contra la receta actual (que puede
 * haber cambiado desde que se tomó el pedido) sería una cuenta aproximada sobre un
 * negocio real.
 */
async function quitarItemsOrden({ idOrden, idNegocio, items, porcentajeImpuesto = 0 }) {
    const t = await Models.sequelize.transaction();
    try {
        await cajaService.requireCajaAbierta(idNegocio, { transaction: t });

        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden, id_negocio: idNegocio, estado: 'ABIERTA' },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            throw new Error('ORDEN_NO_ENCONTRADA');
        }

        // Sin `include` a propósito: Postgres no deja aplicar FOR UPDATE del lado nulo de
        // un LEFT JOIN, y `exclusiones` es opcional (no todo detalle tiene ingredientes
        // excluidos), así que el join lo generaba OUTER y el lock fallaba siempre.
        const detalles = await Models.PedidDetalle.findAll({
            where: { id_orden: idOrden },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        const exclusionesPorDetalle = await Models.PedidDetalleExclu.findAll({
            where: { id_detalle: detalles.map((d) => d.id_detalle) },
            attributes: ['id_detalle', 'id_ingrediente'],
            transaction: t,
        });
        const exclusionesMap = new Map();
        for (const e of exclusionesPorDetalle) {
            if (!exclusionesMap.has(e.id_detalle)) exclusionesMap.set(e.id_detalle, []);
            exclusionesMap.get(e.id_detalle).push(e.id_ingrediente);
        }

        const claveDe = (idProducto, exclusiones, nota) => {
            const excl = [...new Set(exclusiones || [])].sort((a, b) => a - b).join(',');
            return `${idProducto}|${excl}|${String(nota || '').trim()}`;
        };

        const porClave = new Map();
        for (const d of detalles) {
            const clave = claveDe(
                d.id_producto,
                exclusionesMap.get(d.id_detalle) || [],
                d.nota,
            );
            if (!porClave.has(clave)) porClave.set(clave, []);
            porClave.get(clave).push(d);
        }

        for (const item of items) {
            let restante = Number(item.cantidad || 0);
            if (restante <= 0) continue;

            const clave = claveDe(item.id_producto, item.exclusiones, item.nota);
            const candidatos = porClave.get(clave) || [];

            for (const detalle of candidatos) {
                if (restante <= 0) break;
                const cantidadActual = Number(detalle.cantidad);
                if (cantidadActual <= restante) {
                    await Models.PedidDetalleExclu.destroy({
                        where: { id_detalle: detalle.id_detalle },
                        transaction: t,
                    });
                    await detalle.destroy({ transaction: t });
                    restante -= cantidadActual;
                } else {
                    const nuevaCantidad = cantidadActual - restante;
                    await detalle.update({
                        cantidad: nuevaCantidad,
                        subtotal: Number(detalle.precio_unitario) * nuevaCantidad,
                    }, { transaction: t });
                    restante = 0;
                }
            }
        }

        await recalcularTotalesOrden({
            idOrden,
            porcentajeImpuesto,
            transaction: t,
        });

        avisarTrasCommit(t, idNegocio, TEMAS.PEDIDOS, TEMAS.MESAS, TEMAS.COCINA);

        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Obtiene una orden por su ID, con detalles, exclusiones, producto e ingrediente.
 */
/**
 * @param {number} idOrden
 * @param {Object} [opciones]
 * @param {Object} [opciones.transaction] — para leer DENTRO de una transacción sin confirmar.
 *        Sin esto, releer la orden recién creada desde fuera de su transacción no la encuentra.
 */
async function getOrdenById(idOrden, { transaction = null } = {}) {
    return Models.PedidOrden.findByPk(idOrden, {
        transaction,
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono', 'precio'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }, {
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }, {
            model: Models.RestMesa,
            as: 'mesaRef',
            attributes: ['id_mesa', 'nombre', 'numero'],
            required: false,
        }, {
            model: Models.RestMetodoPago,
            as: 'metodoPago',
            attributes: ['id_metodo_pago', 'nombre'],
            required: false,
        }, {
            // Desglose de formas de pago cuando la orden se cobró con Multipago.
            model: Models.RestPagoOrden,
            as: 'pagos',
            attributes: ['id_pago', 'id_metodo_pago', 'valor'],
            required: false,
            include: [{
                model: Models.RestMetodoPago,
                as: 'metodoPago',
                attributes: ['id_metodo_pago', 'nombre'],
                required: false,
            }],
        }, {
            model: Models.GenerUsuario,
            as: 'domiciliario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
            required: false,
        }],
    });
}

/**
 * Lista pedidos LLEVAR/DOMICILIO para el módulo Despacho.
 * Si verTodos=false, filtra por id_domiciliario = idUsuario.
 *
 * ## `de_whatsapp`, y por qué no hay una columna nueva
 *
 * Cada orden sale con una bandera que dice si la tomó el asistente. **No se guarda en ninguna
 * parte**: se deduce de `id_usuario`, porque los pedidos del bot ya nacen a nombre del usuario
 * «Asistente» de ese negocio (ver `usuarioAsistenteDao`, que existe desde el 2026-08-24 para que
 * el informe de ventas por usuario diga la verdad).
 *
 * Una columna `origen` habría sido más explícita, y se descartó por eso mismo: sería una segunda
 * verdad sobre lo mismo, que hay que rellenar en cada sitio que cree una orden y que el día que
 * alguien olvide se queda callada. El autor de la orden ya lo sabe, y no puede desincronizarse
 * de sí mismo. El día que haga falta distinguir el chat del menú digital —hoy los dos entran por
 * el bot— sí hará falta el dato aparte; ese día se añade, con un motivo.
 *
 * ## Y por qué las dos banderas dependen del PLAN
 *
 * El asistente es una feature de pago (`asistente_ia`, que hoy solo incluye «Plan Avanzado»), y
 * para un negocio que no la tiene esta parte de la pantalla **no debe existir**: ni el filtro, ni
 * la etiqueta, ni el botón. Por eso las dos banderas se apagan enteras sin la feature, en vez de
 * apagar solo el botón y dejar la mitad del módulo asomando.
 *
 * Se pregunta por la **feature** y no por el nombre del plan (ADR-021): sembrar
 * `if (plan === 'avanzado')` por el código ata la lógica al catálogo comercial, y el día que
 * ventas mueva la feature de plan hay que tocar veinte sitios.
 *
 * Consecuencia que conviene saber: un negocio que se dé de baja de Avanzado deja de ver **qué
 * pedidos viejos le habían entrado por WhatsApp**. Es el precio de que el módulo desaparezca
 * entero, y es el lado correcto por el que equivocarse: enseñar media función de pago es peor
 * que esconder un dato histórico.
 */
async function getOrdenesDespacho({ idNegocio, idUsuario }) {
    const { Op } = Models.Sequelize;
    const verTodos = await usuarioPuedeVerTodosDespacho({ idUsuario, idNegocio });
    const where = {
        id_negocio: idNegocio,
        tipo_pedido: { [Op.in]: ['LLEVAR', 'DOMICILIO'] },
        estado: 'ABIERTA',
    };
    if (!verTodos) where.id_domiciliario = idUsuario;

    const [ordenes, idAsistente, asistenteHabilitado] = await Promise.all([
        Models.PedidOrden.findAll({
            where,
            include: [
                { model: Models.GenerUsuario, as: 'usuario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'] },
                { model: Models.GenerUsuario, as: 'domiciliario', attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'], required: false },
                            { model: Models.PedidDetalle, as: 'detalles',
                                attributes: ['id_detalle', 'cantidad', 'precio_unitario', 'nota'],
                                include: [{ model: Models.CartaProducto, as: 'producto', attributes: ['id_producto', 'nombre'] }] },
                // Desglose de multipago: el elegido al tomar el pedido (aún sin cobrar) o
                // el ya cobrado. Despacho lo pinta para poder revisarlo y ajustarlo.
                { model: Models.RestPagoOrden, as: 'pagos',
                    attributes: ['id_pago', 'id_metodo_pago', 'valor'], required: false },
            ],
            order: [['fecha_creacion', 'DESC']],
        }),
        // `buscar` y no `resolverOCrear`: mirar el despacho no debe crear nada. Un negocio que
        // nunca ha usado el asistente devuelve `null`, y entonces ninguna orden es suya.
        usuarioAsistenteDao.buscar(idNegocio),
        features.estaHabilitado(idNegocio, features.FEATURE.ASISTENTE_IA),
    ]);

    const planos = ordenes.map((o) => {
        const plano = typeof o.toJSON === 'function' ? o.toJSON() : { ...o };
        plano.de_whatsapp =
            asistenteHabilitado && idAsistente != null && plano.id_usuario === idAsistente;
        return plano;
    });

    // ── El estado real de cada aviso ──────────────────────────────────────────────────────
    //
    // Se consulta **solo** para los que tienen marca, que son pocos: no hay una consulta por
    // pedido, hay una por pedido ya avisado.
    //
    // Y se consulta porque `aviso_listo_en` dice «se intentó», que no es «llegó». El primer
    // aviso real de producción quedó marcado y murió en dead letter —la plantilla no existía
    // todavía en Meta—, así que el negocio creyó haber avisado a alguien que no recibió nada.
    await Promise.all(
        planos
            .filter((p) => p.aviso_listo_en)
            .map(async (p) => {
                p.aviso_listo_estado = await avisoPedido.estadoDelAviso(p);
            })
    );

    return planos.map((plano) => {
        // El botón se decide aquí y no en la pantalla porque son cuatro condiciones y una es
        // comercial: repetirlas en el frontend garantiza que un día discrepen, y el lado que
        // discrepe sería el que ofrece un botón que el backend rechaza. Allí se vuelven a
        // comprobar de todos modos — esto decide qué se ENSEÑA, no qué se permite.
        const avisoVivo = plano.aviso_listo_en && plano.aviso_listo_estado !== 'fallido';
        // LLEVAR y DOMICILIO llevan aviso, cada uno con su plantilla («puedes recogerlo» /
        // «el domiciliario va en camino» — ver `avisoPedido.plantillaParaTipo`); MESA no.
        plano.puede_avisar_listo =
            plano.de_whatsapp
            && (plano.tipo_pedido === 'LLEVAR' || plano.tipo_pedido === 'DOMICILIO')
            && !avisoVivo;
        return plano;
    });
}

/**
 * Lista usuarios elegibles como domiciliario para un pedido.
 *
 * Por defecto, solo quienes tienen el rol DOMICILIARIO. Con `permite_domicilio_personal`
 * encendido (negocios sin domiciliario dedicado, donde reparte el mesero, el cajero o el
 * dueño), lista a TODO el personal activo del negocio en su lugar — no se mezclan las dos
 * listas porque el personal ya las incluye a todas: quien tiene el rol también está en
 * `gener_negocio_usuario`.
 */
/**
 * ¿Este usuario es domiciliario de ESTE negocio? Misma regla de dos caminos que
 * `listarDomiciliarios` —personal propio (`permite_domicilio_personal`) o el rol
 * DOMICILIARIO— pero comprobando UN candidato, no listando a todos.
 *
 * ## Por qué hace falta
 *
 * Hasta ahora `id_domiciliario` solo pasaba por `isInt({ min: 1 })` en el controlador y por la
 * FK a `gener_usuario` en la base: la comprobación de que sea un entero positivo que exista EN
 * ALGUNA PARTE del sistema. Ninguna de las dos comprueba que sea domiciliario **de este
 * negocio** — un id de un empleado de otro negocio, o de un usuario sin ningún rol de
 * domiciliario, pasaba igual. Sin explotarse porque hoy solo lo escribe el propio panel del
 * negocio (no llega del bot), pero es la clase de comprobación que no debe depender de que
 * quien llama se porte bien.
 */
async function esDomiciliarioValido({ idNegocio, idDomiciliario, transaction }) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio },
        attributes: ['permite_domicilio_personal'],
        transaction,
    });

    if (negocio?.permite_domicilio_personal) {
        const link = await Models.GenerNegocioUsuario.findOne({
            where: { id_negocio: idNegocio, id_usuario: idDomiciliario, estado: 'A' },
            include: [{
                model: Models.GenerUsuario, as: 'usuario', where: { estado: 'A' }, attributes: ['id_usuario'],
            }],
            transaction,
        });
        return Boolean(link);
    }

    const rolDom = await Models.GenerRol.findOne({
        where: { descripcion: 'DOMICILIARIO', id_tipo_negocio: 1 },
        transaction,
    });
    if (!rolDom) return false;

    const link = await Models.GenerUsuarioRol.findOne({
        where: { id_negocio: idNegocio, id_rol: rolDom.id_rol, id_usuario: idDomiciliario, estado: 'A' },
        include: [{
            model: Models.GenerUsuario, as: 'usuario', where: { estado: 'A' }, attributes: ['id_usuario'],
        }],
        transaction,
    });
    return Boolean(link);
}

async function listarDomiciliarios(idNegocio, { transaction } = {}) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio },
        attributes: ['permite_domicilio_personal'],
        transaction,
    });

    if (negocio?.permite_domicilio_personal) {
        const links = await Models.GenerNegocioUsuario.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            include: [{
                model: Models.GenerUsuario, as: 'usuario',
                where: { estado: 'A' },
                attributes: ['id_usuario', 'primer_nombre', 'primer_apellido', 'num_identificacion', 'telefono'],
            }],
            transaction,
        });
        return links.map(l => ({
            id_usuario: l.usuario.id_usuario,
            nombre: `${l.usuario.primer_nombre} ${l.usuario.primer_apellido}`.trim(),
            num_identificacion: l.usuario.num_identificacion,
            telefono: l.usuario.telefono,
        }));
    }

    const rolDom = await Models.GenerRol.findOne({
        where: { descripcion: 'DOMICILIARIO', id_tipo_negocio: 1 },
        transaction,
    });
    if (!rolDom) return [];
    const links = await Models.GenerUsuarioRol.findAll({
        where: { id_negocio: idNegocio, id_rol: rolDom.id_rol, estado: 'A' },
        include: [{
            model: Models.GenerUsuario, as: 'usuario',
            where: { estado: 'A' },
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido', 'num_identificacion', 'telefono'],
        }],
        transaction,
    });
    return links.map(l => ({
        id_usuario: l.usuario.id_usuario,
        nombre: `${l.usuario.primer_nombre} ${l.usuario.primer_apellido}`.trim(),
        num_identificacion: l.usuario.num_identificacion,
        telefono: l.usuario.telefono,
    }));
}

/**
 * Elige un domiciliario para un pedido a domicilio que toma el asistente de WhatsApp, para que
 * nunca llegue a Despacho sin nadie asignado.
 *
 * ## Dos pasos, y el segundo es el que ya existía
 *
 * 1. **Quien esté EN TURNO ahora, según `rest_horario`.** Si el negocio cargó horarios de sus
 *    domiciliarios, lo natural es asignarle el pedido a quien dice estar trabajando a esta
 *    hora, no a cualquiera. Al azar entre los que están en turno si hay más de uno — repartir
 *    la carga de verdad (quién anda más cerca, quién lleva menos pedidos hoy) sigue siendo una
 *    decisión de negocio que nadie ha tomado todavía.
 * 2. **Si nadie está en turno —o el negocio no cargó horarios de domiciliarios—, al azar entre
 *    TODOS los que tiene.** Es el comportamiento con el que nació esta función: un negocio sin
 *    horarios cargados no debe quedarse sin poder asignar a nadie.
 *
 * Mismo criterio arbitrario que `elegirProfesional` en el adaptador de `reserva`: no hay «el
 * primero» razonable entre domiciliarios, así que un orden fijo repartiría siempre a favor del
 * mismo.
 *
 * @returns {Promise<number|null>} `id_usuario` del domiciliario elegido, o `null` si el
 *   negocio no tiene ninguno — quien llama decide qué hacer con eso.
 */
async function elegirDomiciliarioAlAzar(idNegocio, { transaction, ahora = new Date() } = {}) {
    const domiciliarios = await listarDomiciliarios(idNegocio, { transaction });
    if (domiciliarios.length === 0) return null;

    const enTurno = await horarioService.usuariosEnTurnoAhora({ idNegocio, ahora, transaction });
    if (enTurno.length > 0) {
        const idsEnTurno = new Set(enTurno);
        const candidatos = domiciliarios.filter((d) => idsEnTurno.has(d.id_usuario));
        if (candidatos.length > 0) {
            return candidatos[Math.floor(Math.random() * candidatos.length)].id_usuario;
        }
    }

    return domiciliarios[Math.floor(Math.random() * domiciliarios.length)].id_usuario;
}

/**
 * Lista órdenes abiertas de un negocio.
 */
async function getOrdenesAbiertas(idNegocio) {
    return Models.PedidOrden.findAll({
        where: { id_negocio: idNegocio, estado: 'ABIERTA' },
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [{
                model: Models.CartaProducto,
                as: 'producto',
                attributes: ['id_producto', 'nombre', 'icono'],
            }],
        }],
        order: [['fecha_creacion', 'DESC']],
    });
}

/**
 * Envía una orden a cocina (cambia estado_cocina → PENDIENTE y detalles → EN_COCINA).
 */
async function enviarACocina(idOrden) {
    await Models.PedidDetalle.update(
        { estado: 'EN_COCINA' },
        { where: { id_orden: idOrden, estado: 'PENDIENTE' } }
    );
    await Models.PedidOrden.update(
        { estado_cocina: 'PENDIENTE' },
        { where: { id_orden: idOrden } }
    );

    const orden = await getOrdenById(idOrden);
    avisar(orden?.id_negocio, TEMAS.COCINA, TEMAS.PEDIDOS);
    return orden;
}

/**
 * Cambia el estado del KDS para una orden (flujo kanban).
 * PENDIENTE → EN_PREPARACION → LISTO → ENTREGADO.
 * Al pasar a LISTO, los detalles EN_COCINA se marcan LISTO.
 */
async function cambiarEstadoCocina(idOrden, nuevoEstado) {
    const updateOrden = { estado_cocina: nuevoEstado };
    await Models.PedidOrden.update(updateOrden, { where: { id_orden: idOrden } });
    if (nuevoEstado === 'LISTO') {
        await Models.PedidDetalle.update(
            { estado: 'LISTO' },
            { where: { id_orden: idOrden, estado: 'EN_COCINA' } }
        );
    } else if (nuevoEstado === 'EN_PREPARACION') {
        // Si se deshace desde LISTO → EN_PREPARACION, revertir detalles LISTO → EN_COCINA
        await Models.PedidDetalle.update(
            { estado: 'EN_COCINA' },
            { where: { id_orden: idOrden, estado: 'LISTO' } }
        );
    }

    const orden = await getOrdenById(idOrden);
    // También `pedidos`: Despacho muestra qué está listo para salir, y es justo la pantalla
    // que tiene que enterarse en el momento en que cocina marca el plato.
    avisar(orden?.id_negocio, TEMAS.COCINA, TEMAS.PEDIDOS);
    return orden;
}

/**
 * Lista órdenes activas en el KDS (estado_cocina IN [PENDIENTE, EN_PREPARACION, LISTO]).
 */
async function getOrdenesCocina(idNegocio) {
    const { Op } = Models.Sequelize;
    return Models.PedidOrden.findAll({
        where: {
            id_negocio: idNegocio,
            estado_cocina: { [Op.in]: ['PENDIENTE', 'EN_PREPARACION', 'LISTO'] },
        },
        include: [{
            model: Models.PedidDetalle,
            as: 'detalles',
            include: [
                {
                    model: Models.CartaProducto,
                    as: 'producto',
                    attributes: ['id_producto', 'nombre', 'icono'],
                },
                {
                    model: Models.PedidDetalleExclu,
                    as: 'exclusiones',
                    include: [{
                        model: Models.CartaIngrediente,
                        as: 'ingrediente',
                        attributes: ['id_ingrediente', 'nombre'],
                    }],
                },
            ],
        }, {
            model: Models.GenerUsuario,
            as: 'usuario',
            attributes: ['id_usuario', 'primer_nombre', 'primer_apellido'],
        }, {
            model: Models.RestMesa,
            as: 'mesaRef',
            attributes: ['id_mesa', 'nombre', 'numero'],
            required: false,
        }],
        order: [['fecha_creacion', 'ASC']],
    });
}

/**
 * Marca un detalle como LISTO (lo elimina de la vista de cocina).
 */
async function marcarDetalleCompleto(idDetalle) {
    const detalle = await Models.PedidDetalle.findByPk(idDetalle);
    if (!detalle) return null;
    await detalle.update({ estado: 'LISTO' });

    // El detalle no guarda el negocio: cuelga de la orden.
    const orden = await Models.PedidOrden.findByPk(detalle.id_orden, { attributes: ['id_negocio'] });
    avisar(orden?.id_negocio, TEMAS.COCINA);
    return detalle;
}

/**
 * ¿Cuánto de este cobro se paga con la cuenta del cliente (tiquetera o fiado)?
 *
 * La forma de pago «Cuenta / Tiquetera» está marcada con `es_cuenta` en la tabla, no se
 * reconoce por el nombre: un negocio puede renombrarla y el cobro tiene que seguir sabiendo
 * que ese dinero no entra al cajón.
 *
 * Devuelve 0 cuando el cobro no la usa, que es el caso normal.
 */
async function importeContraCuenta({ idNegocio, idMetodoPago, pagos, total, transaction }) {
    const metodoCuenta = await cuentaService.getMetodoPagoCuenta(idNegocio, { transaction });
    if (!metodoCuenta) return 0;

    if (Array.isArray(pagos) && pagos.length > 0) {
        return pagos
            .filter((p) => Number(p.id_metodo_pago) === metodoCuenta.id_metodo_pago)
            .reduce((suma, p) => suma + Number(p.valor || 0), 0);
    }

    return Number(idMetodoPago) === metodoCuenta.id_metodo_pago ? Number(total || 0) : 0;
}

/** El desglose de multipago ya guardado de una orden, para releerlo al cerrar. */
async function leerPagosDeOrden(idOrden, transaction) {
    const filas = await Models.RestPagoOrden.findAll({
        where: { id_orden: idOrden },
        attributes: ['id_metodo_pago', 'valor'],
        transaction,
    });
    return filas.map((f) => ({ id_metodo_pago: f.id_metodo_pago, valor: Number(f.valor) }));
}

/**
 * Carga contra la cuenta del cliente la parte del cobro que se pagó con ella.
 *
 * Exige `idCuenta` explícito y no lo deduce del `id_persona_negocio` del pedido a propósito:
 * un pedido para llevar puede llevar el teléfono de quien lo recoge, y adivinar de quién es la
 * tiquetera es exactamente el error que le descontaría el almuerzo al cliente equivocado.
 */
async function aplicarCobroConCuenta({ orden, idCuenta, importe, idCaja, idUsuario, transaction }) {
    if (!idCuenta) {
        const e = new Error('Indica de qué cliente es la cuenta con la que se paga.');
        e.code = 'CUENTA_REQUERIDA'; e.statusCode = 422;
        throw e;
    }
    if (!idCaja) {
        // Sin turno abierto el pedido no queda en ninguna caja, y el consumo de la tiquetera
        // tiene que salir en el turno donde se sirvió (su ingreso de la parte no cubierta, o de cero).
        const e = new Error('Para cobrar con la cuenta del cliente debe haber una caja abierta.');
        e.code = 'CAJA_CERRADA'; e.statusCode = 409;
        throw e;
    }

    return cuentaService.aplicarConsumo({
        idNegocio: orden.id_negocio,
        idCuenta: Number(idCuenta),
        idOrden: orden.id_orden,
        numeroOrden: orden.numero_orden,
        monto: importe,
        idUsuario,
        transaction,
    });
}

/**
 * Valida y persiste el desglose de pagos (Multipago) de una orden.
 *  - Requiere que el negocio tenga permite_multipago = true.
 *  - Exige al menos 2 formas de pago, todas activas y del negocio.
 *  - La suma de los valores debe ser EXACTAMENTE igual al total de la orden.
 * Reemplaza cualquier desglose previo de la orden (idempotente ante recobro).
 * Devuelve la lista de pagos normalizada.
 *
 * @param {boolean} [exigirCuadre=true] — en false guarda el desglose como
 *   INTENCIÓN de una orden aún sin cobrar (lo que eligió quien tomó el pedido,
 *   para que Despacho y Mesas lo muestren y lo puedan editar). Ahí el total
 *   todavía puede moverse —se agregan productos, se cobra el domicilio—, así que
 *   exigir el cuadre haría fallar la toma del pedido. Al cobrar se vuelve a
 *   validar con `exigirCuadre` en true, que es donde el cuadre sí es innegociable.
 */
async function validarYGuardarPagos({ orden, pagos, transaction, exigirCuadre = true }) {
    const negocio = await Models.GenerNegocio.findByPk(orden.id_negocio, {
        attributes: ['id_negocio', 'permite_multipago'],
        transaction,
    });
    if (!negocio || !negocio.permite_multipago) {
        const e = new Error('El multipago no está habilitado para este negocio.');
        e.code = 'MULTIPAGO_NO_HABILITADO'; e.statusCode = 422;
        throw e;
    }

    if (!Array.isArray(pagos) || pagos.length < 2) {
        const e = new Error('El multipago requiere al menos dos formas de pago.');
        e.code = 'MULTIPAGO_MINIMO'; e.statusCode = 422;
        throw e;
    }

    const ids = pagos.map((p) => Number(p.id_metodo_pago));
    const metodos = await Models.RestMetodoPago.findAll({
        where: { id_metodo_pago: ids, id_negocio: orden.id_negocio, estado: 'A' },
        attributes: ['id_metodo_pago'],
        transaction,
    });
    const validos = new Set(metodos.map((m) => m.id_metodo_pago));

    let suma = 0;
    const normalizados = pagos.map((p) => {
        const idm = Number(p.id_metodo_pago);
        const val = Number(p.valor);
        if (!validos.has(idm)) {
            const e = new Error('Una de las formas de pago no es válida para este negocio.');
            e.code = 'METODO_PAGO_INVALIDO'; e.statusCode = 422;
            throw e;
        }
        if (!(val > 0)) {
            const e = new Error('Cada forma de pago debe tener un valor mayor a cero.');
            e.code = 'MULTIPAGO_VALOR_INVALIDO'; e.statusCode = 422;
            throw e;
        }
        suma += val;
        return { id_orden: orden.id_orden, id_metodo_pago: idm, valor: val };
    });

    // Comparar en centavos para evitar problemas de coma flotante.
    const total = Number(orden.total);
    if (exigirCuadre && Math.round(suma * 100) !== Math.round(total * 100)) {
        const e = new Error(
            `La suma de las formas de pago (${suma}) debe ser igual al total de la orden (${total}).`
        );
        e.code = 'MULTIPAGO_DESCUADRE'; e.statusCode = 422;
        throw e;
    }

    await Models.RestPagoOrden.destroy({ where: { id_orden: orden.id_orden }, transaction });
    await Models.RestPagoOrden.bulkCreate(normalizados, { transaction });
    return normalizados;
}

/**
 * Registra el cobro de una orden sin cerrarla.
 * Usado en el flujo de despacho: el pedido queda ABIERTO pero marcado como pagado.
 * Registra inmediatamente el INGRESO en la caja activa del negocio.
 *
 * Acepta pago simple (`idMetodoPago`) o Multipago (`pagos: [{id_metodo_pago, valor}]`).
 */
async function marcarPagado(idOrden, { idMetodoPago, pagos, origenCobro = 'CAJA', idCuenta = null, idUsuario = null } = {}) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findByPk(idOrden, {
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            await t.rollback();
            return null;
        }

        const esMultipago = Array.isArray(pagos) && pagos.length > 0;

        if (esMultipago) {
            await validarYGuardarPagos({ orden, pagos, transaction: t });
        } else {
            if (!idMetodoPago) {
                const e = new Error('La forma de pago es obligatoria para registrar el cobro.');
                e.code = 'METODO_PAGO_REQUERIDO';
                e.statusCode = 422;
                throw e;
            }

            const mp = await Models.RestMetodoPago.findOne({
                where: { id_metodo_pago: idMetodoPago, id_negocio: orden.id_negocio, estado: 'A' },
                transaction: t,
            });
            if (!mp) {
                const e = new Error('Método de pago inválido para este negocio.');
                e.code = 'METODO_PAGO_INVALIDO';
                e.statusCode = 422;
                throw e;
            }

            // Se cobra con una sola forma de pago: si la orden traía un desglose de
            // multipago pendiente, deja de valer. Sin esto quedaría en la tabla un
            // reparto que nadie cobró y que `cerrarOrden` leería como pago real.
            await Models.RestPagoOrden.destroy({ where: { id_orden: orden.id_orden }, transaction: t });
        }

        // Lo que paga la cuenta del cliente se calcula ANTES de anotar el ingreso: esa parte no
        // entra al cajón, y el ingreso tiene que nacer ya sin ella.
        const contraCuenta = await importeContraCuenta({
            idNegocio: orden.id_negocio,
            idMetodoPago,
            pagos,
            total: orden.total,
            transaction: t,
        });

        const registraEnCaja = origenCobro !== 'DOMICILIARIO';
        const caja = registraEnCaja
            ? await cajaService.registrarIngresoOrden({
                idNegocio:   orden.id_negocio,
                idOrden:     orden.id_orden,
                idUsuario:   orden.id_usuario,
                monto:       orden.total,
                numeroOrden: orden.numero_orden,
                valorDomicilio: orden.valor_domicilio,
                montoContraCuenta: contraCuenta,
                transaction: t,
            })
            : null;

        if (contraCuenta > 0) {
            await aplicarCobroConCuenta({
                orden,
                // Lo que mande quien cobra manda; si no dice nada, vale la cuenta que se eligió
                // al tomar el pedido.
                idCuenta: idCuenta || orden.id_cuenta,
                importe: contraCuenta,
                idCaja: caja?.id_caja ?? null,
                idUsuario: idUsuario || orden.id_usuario,
                transaction: t,
            });
        }

        await orden.update({
            estado_pago:    'pagado',
            // En multipago el detalle vive en rest_pago_orden; la columna queda null.
            id_metodo_pago: esMultipago ? null : idMetodoPago,
            id_caja:        caja ? caja.id_caja : null,
        }, { transaction: t });

        avisarTrasCommit(
            t,
            orden.id_negocio,
            TEMAS.PEDIDOS,
            // El cobro entra en el turno salvo que lo cobre el domiciliario en la calle.
            ...(registraEnCaja ? [TEMAS.CAJA] : []),
            ...(orden.id_mesa ? [TEMAS.MESAS] : []),
        );

        await t.commit();
        return orden;
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Actualiza SOLO el valor del domicilio de una orden abierta y recalcula su total.
 *
 * Existe aparte de `agregarItemsOrden` porque corregir el cobro del domicilio no
 * implica tocar los productos, y esa ruta exige al menos un item nuevo.
 *
 * Se rechaza sobre órdenes ya pagadas: el INGRESO y el EGRESO de caja se calcularon
 * con el total anterior, y moverlo ahora dejaría la caja descuadrada.
 */
async function actualizarValorDomicilio(idOrden, { idNegocio, valorDomicilio }) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!orden) {
            const e = new Error('Orden no encontrada.');
            e.code = 'ORDEN_NO_ENCONTRADA'; e.statusCode = 404;
            throw e;
        }
        if (orden.estado !== 'ABIERTA') {
            const e = new Error('Solo se puede ajustar el domicilio de una orden abierta.');
            e.code = 'ORDEN_NO_ABIERTA'; e.statusCode = 409;
            throw e;
        }
        if (orden.estado_pago === 'pagado') {
            const e = new Error('No se puede cambiar el valor del domicilio de un pedido ya cobrado.');
            e.code = 'ORDEN_PAGADA'; e.statusCode = 409;
            throw e;
        }

        const domicilio = await resolverValorDomicilio({
            idNegocio,
            tipoPedido: orden.tipo_pedido,
            valorDomicilio,
            transaction: t,
        });

        await recalcularTotalesOrden({
            idOrden,
            porcentajeImpuesto: 0,
            valorDomicilio: domicilio,
            transaction: t,
        });

        avisarTrasCommit(t, idNegocio, TEMAS.PEDIDOS);
        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Asigna o cambia el domiciliario de un pedido a domicilio ya creado.
 *
 * Hasta ahora `id_domiciliario` solo se podía poner AL CREAR la orden — no existía forma de
 * corregirlo después. Hacía falta para dos casos reales: el bot lo asigna al azar (o por
 * turno) y el negocio quiere cambiarlo por el que de verdad va a salir, o un domiciliario se
 * reporta enfermo a mitad de turno y hay que repartir sus pedidos pendientes entre los demás.
 *
 * Reutiliza `esDomiciliarioValido` — la misma comprobación que ya evita que `crearOrden`
 * acepte un id de cualquier usuario del sistema que no sea domiciliario de ESTE negocio.
 */
async function asignarDomiciliario(idOrden, { idNegocio, idDomiciliario }) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            const e = new Error('Orden no encontrada.');
            e.code = 'ORDEN_NO_ENCONTRADA'; e.statusCode = 404;
            throw e;
        }
        if (orden.estado !== 'ABIERTA') {
            const e = new Error('Solo se puede asignar domiciliario a una orden abierta.');
            e.code = 'ORDEN_NO_ABIERTA'; e.statusCode = 409;
            throw e;
        }
        if (orden.tipo_pedido !== 'DOMICILIO') {
            const e = new Error('Solo los pedidos a domicilio llevan domiciliario.');
            e.code = 'ORDEN_NO_ES_DOMICILIO'; e.statusCode = 409;
            throw e;
        }

        const valido = await esDomiciliarioValido({ idNegocio, idDomiciliario, transaction: t });
        if (!valido) {
            const e = new Error('Ese domiciliario no existe o no está activo en este negocio.');
            e.code = 'DOMICILIARIO_INVALIDO'; e.statusCode = 422;
            throw e;
        }

        await orden.update({ id_domiciliario: idDomiciliario }, { transaction: t });

        avisarTrasCommit(t, idNegocio, TEMAS.PEDIDOS, TEMAS.MESAS);
        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Actualiza SOLO el descuento de una orden abierta y recalcula su total.
 *
 * Existe aparte de `agregarItemsOrden` por el mismo motivo que el del domicilio:
 * corregir la rebaja no implica tocar los productos, y esa ruta exige al menos
 * un item nuevo.
 *
 * Se rechaza sobre órdenes ya pagadas: el INGRESO de caja se calculó con el total
 * anterior, y moverlo ahora dejaría la caja descuadrada.
 */
async function actualizarDescuento(idOrden, { idNegocio, descuento }) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });

        if (!orden) {
            const e = new Error('Orden no encontrada.');
            e.code = 'ORDEN_NO_ENCONTRADA'; e.statusCode = 404;
            throw e;
        }
        if (orden.estado !== 'ABIERTA') {
            const e = new Error('Solo se puede ajustar el descuento de una orden abierta.');
            e.code = 'ORDEN_NO_ABIERTA'; e.statusCode = 409;
            throw e;
        }
        if (orden.estado_pago === 'pagado') {
            const e = new Error('No se puede cambiar el descuento de un pedido ya cobrado.');
            e.code = 'ORDEN_PAGADA'; e.statusCode = 409;
            throw e;
        }

        const rebaja = await resolverDescuento({ idNegocio, descuento, transaction: t });

        await recalcularTotalesOrden({
            idOrden,
            porcentajeImpuesto: 0,
            descuento: rebaja,
            transaction: t,
        });

        avisarTrasCommit(t, idNegocio, TEMAS.PEDIDOS);
        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        if (!t.finished) await t.rollback();
        throw err;
    }
}

/**
 * Cancela una orden (solo si NO ha sido pagada).
 * Se usa desde el módulo de Despacho para eliminar pedidos pendientes de pago.
 * No registra nada en caja. El stock consumido NO se restaura automáticamente
 * (la orden sigue existiendo para auditoría, simplemente marcada CANCELADA).
 */
async function cancelarOrden(idOrden, { idUsuario } = {}) {
    const orden = await Models.PedidOrden.findByPk(idOrden);
    if (!orden) return null;

    const puedeCancelar = await usuarioPuedeCancelarPedidoNoPagado({
        idUsuario,
        idNegocio: orden.id_negocio,
    });
    if (!puedeCancelar) {
        const e = new Error('No tienes permiso para eliminar pedidos pendientes de pago.');
        e.code = 'SIN_PERMISO_CANCELAR_NO_PAGADO';
        e.statusCode = 403;
        throw e;
    }

    if (orden.estado_pago === 'pagado') {
        const e = new Error('No se puede cancelar un pedido ya pagado.');
        e.code = 'ORDEN_PAGADA'; e.statusCode = 409;
        throw e;
    }
    if (orden.estado === 'CERRADA') {
        const e = new Error('No se puede cancelar una orden cerrada.');
        e.code = 'ORDEN_CERRADA'; e.statusCode = 409;
        throw e;
    }
    await orden.update({ estado: 'CANCELADA', cancelado_por: 'negocio', fecha_cierre: new Date() });
    avisar(orden.id_negocio, TEMAS.PEDIDOS, TEMAS.MESAS, TEMAS.COCINA);
    return orden;
}

/**
 * Cancela un pedido A PETICIÓN DEL PROPIO CLIENTE (asistente de WhatsApp, Policy Gate).
 *
 * No es `cancelarOrden` con otro nombre: esa exige un `idUsuario` con permiso de rol
 * (`usuarioPuedeCancelarPedidoNoPagado`), que es la comprobación correcta para un empleado
 * cancelando desde el panel, pero no tiene sentido para un cliente cancelando el suyo por
 * WhatsApp — no hay ningún rol que darle. Aquí lo que autoriza es la pertenencia (ya
 * comprobada por el adaptador contra `telefono_verificado`, igual que en
 * `consultar_estado_pedido`) y una ventana de negocio distinta: **la cocina no puede haber
 * empezado a prepararlo**. Pasado ese punto, cancelar por su cuenta tira comida ya hecha —
 * de ahí el mensaje remite al restaurante en vez de ejecutar.
 *
 * Acepta `{ transaction }` (a diferencia de `cancelarOrden`) porque el Policy Gate envuelve
 * toda invocación en su propia transacción para que el dry-run sea genérico: sin esto, la
 * cancelación de prueba de un dry-run se habría confirmado igual.
 */
async function cancelarPorCliente(idOrden, { idNegocio, transaction }) {
    const orden = await Models.PedidOrden.findOne({
        where: { id_orden: idOrden, id_negocio: idNegocio },
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!orden) {
        const e = new Error('No encuentro ese pedido.');
        e.code = 'PEDIDO_NO_ENCONTRADO'; e.statusCode = 404;
        throw e;
    }
    if (orden.estado === 'CANCELADA') {
        const e = new Error('Ese pedido ya estaba cancelado.');
        e.code = 'ORDEN_YA_CANCELADA'; e.statusCode = 409;
        throw e;
    }
    if (orden.estado_pago === 'pagado' || orden.estado === 'CERRADA') {
        const e = new Error(
            'Ese pedido ya se cobró y no lo puedo cancelar por aquí. Llama al restaurante.'
        );
        e.code = 'ORDEN_NO_CANCELABLE'; e.statusCode = 409;
        throw e;
    }
    // `estado_cocina` es NULL hasta que el restaurante lo manda a preparar (`enviarACocina`)
    // y solo entonces avanza a EN_PREPARACION/LISTO. NULL o PENDIENTE = todavía no se ha
    // tocado nada en cocina; a partir de ahí ya no es una decisión que el cliente pueda
    // tomar solo.
    if (['EN_PREPARACION', 'LISTO'].includes(orden.estado_cocina)) {
        const e = new Error(
            'Tu pedido ya está en preparación y no lo puedo cancelar por aquí. Llama al restaurante.'
        );
        e.code = 'ORDEN_EN_PREPARACION'; e.statusCode = 409;
        throw e;
    }

    await orden.update(
        { estado: 'CANCELADA', cancelado_por: 'cliente', fecha_cierre: new Date() },
        { transaction }
    );
    avisarTrasCommit(transaction, idNegocio, TEMAS.PEDIDOS, TEMAS.MESAS, TEMAS.COCINA);
    return orden;
}

/**
 * Los pedidos de despacho (LLEVAR/DOMICILIO) cancelados HOY, para que Despacho pueda
 * mostrarlos aparte de los activos y decir quién los canceló.
 *
 * ## Por qué existe esto
 *
 * `getOrdenesDespacho` filtra por `estado: 'ABIERTA'`: un pedido cancelado desaparece de la
 * pantalla en el mismo instante en que se cancela. Para uno que cancela el propio empleado
 * desde ahí, es lo correcto — lo vio irse. Para uno que cancela EL CLIENTE por WhatsApp, sin
 * que nadie del negocio tocara nada, la orden se esfuma sin dejar ningún rastro visible: el
 * negocio solo nota que ya no está, nunca que pasó ni por qué.
 *
 * Se acota a HOY (`fecha_cierre >= hoy`) y no a todo el histórico: esto es una alerta
 * operativa de lo que acaba de pasar en el turno, no un reporte — para eso está la base
 * misma, que la fila cancelada nunca se borra.
 *
 * Mismo filtro de visibilidad que `getOrdenesDespacho` (LLEVAR/DOMICILIO, y por
 * `id_domiciliario` si el usuario no puede ver todos): un domiciliario no debe ver que se
 * canceló un pedido que nunca fue suyo.
 */
async function getOrdenesCanceladasRecientes({ idNegocio, idUsuario }) {
    const { Op } = Models.Sequelize;
    const verTodos = await usuarioPuedeVerTodosDespacho({ idUsuario, idNegocio });
    const where = {
        id_negocio: idNegocio,
        tipo_pedido: { [Op.in]: ['LLEVAR', 'DOMICILIO'] },
        estado: 'CANCELADA',
        fecha_cierre: { [Op.gte]: sequelizeInicioDeHoy() },
    };
    if (!verTodos) where.id_domiciliario = idUsuario;

    return Models.PedidOrden.findAll({
        where,
        attributes: [
            'id_orden', 'numero_orden', 'tipo_pedido', 'total', 'contacto_nombre',
            'cancelado_por', 'fecha_cierre',
        ],
        order: [['fecha_cierre', 'DESC']],
        limit: 30,
    });
}

/**
 * La medianoche de HOY, en hora de Bogotá — no en la del proceso de Node, que en el VPS y en
 * cualquier entorno con `TZ` distinto puede ser otra. El pool de Postgres ya está fijado a
 * `America/Bogota` (`app_core/models/conection.js`), así que `CURRENT_DATE` en el propio
 * servidor es la fuente de verdad, no una fecha calculada aquí y mandada como parámetro.
 */
function sequelizeInicioDeHoy() {
    return Models.Sequelize.literal("date_trunc('day', now())");
}

/**
 * Cierra (cobra) una orden.
 *
 * Atómico dentro de una transacción:
 *  1. Verifica caja abierta del negocio.
 *  2. Registra movimiento INGRESO por el total de la orden.
 *  3. Marca la orden CERRADA y persiste id_caja para auditoría.
 *
 * @param {number} idOrden
 * @param {{ idUsuario: number }} ctx — usuario que ejecuta el cobro
 */
async function cerrarOrden(idOrden, { idUsuario, idMetodoPago, pagos, idCuenta = null } = {}) {
    const t = await Models.sequelize.transaction();
    try {
        const orden = await Models.PedidOrden.findOne({
            where: { id_orden: idOrden },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!orden) {
            await t.rollback();
            return null;
        }
        if (orden.estado === 'CERRADA') {
            await t.commit();
            return getOrdenById(idOrden);
        }

        // Multipago: llega el desglose ahora, o la orden ya fue cobrada con
        // multipago (rest_pago_orden con filas) desde el flujo de despacho.
        //
        // Las filas de una orden AÚN NO COBRADA son solo la intención de quien tomó
        // el pedido, no un cobro: si aquí llega un pago simple, mandan las de ahora.
        let esMultipago = Array.isArray(pagos) && pagos.length > 0;
        if (esMultipago) {
            await validarYGuardarPagos({ orden, pagos, transaction: t });
        } else if (orden.estado_pago === 'pagado') {
            const pagosExistentes = await Models.RestPagoOrden.count({
                where: { id_orden: orden.id_orden },
                transaction: t,
            });
            esMultipago = pagosExistentes > 0;
        } else {
            await Models.RestPagoOrden.destroy({ where: { id_orden: orden.id_orden }, transaction: t });
        }

        let metodoPagoFinal = null;
        if (!esMultipago) {
            metodoPagoFinal = idMetodoPago || orden.id_metodo_pago || null;
            if (!metodoPagoFinal) {
                const e = new Error('La forma de pago es obligatoria para cerrar la orden.');
                e.statusCode = 422; e.code = 'METODO_PAGO_REQUERIDO';
                throw e;
            }

            // Validar que el método de pago final pertenezca al negocio.
            const mp = await Models.RestMetodoPago.findOne({
                where: { id_metodo_pago: metodoPagoFinal, id_negocio: orden.id_negocio, estado: 'A' },
                transaction: t,
            });
            if (!mp) {
                const e = new Error('Método de pago inválido para este negocio.');
                e.statusCode = 422; e.code = 'METODO_PAGO_INVALIDO';
                throw e;
            }
        }

        // Si marcarPagado ya registró el ingreso en caja, reusar ese id_caja
        let idCaja = orden.id_caja || null;
        const yaEstabaCobrada = Boolean(idCaja);

        // Solo si el ingreso se registra AHORA. Si la orden ya venía cobrada desde despacho, su
        // ingreso y su consumo contra la cuenta se anotaron entonces: repetirlos aquí le cobraría
        // dos veces la misma comida al cliente, y eso solo se descubre cuando él reclama.
        if (!yaEstabaCobrada) {
            // Antes del ingreso: la parte que paga la cuenta del cliente no entra al cajón.
            const contraCuenta = await importeContraCuenta({
                idNegocio: orden.id_negocio,
                idMetodoPago: metodoPagoFinal,
                pagos: esMultipago ? await leerPagosDeOrden(orden.id_orden, t) : null,
                total: orden.total,
                transaction: t,
            });

            const caja = await cajaService.registrarIngresoOrden({
                idNegocio:   orden.id_negocio,
                idOrden:     orden.id_orden,
                idUsuario:   idUsuario || orden.id_usuario,
                monto:       orden.total,
                numeroOrden: orden.numero_orden,
                valorDomicilio: orden.valor_domicilio,
                montoContraCuenta: contraCuenta,
                transaction: t,
            });
            idCaja = caja.id_caja;

            if (contraCuenta > 0) {
                await aplicarCobroConCuenta({
                    orden,
                    idCuenta: idCuenta || orden.id_cuenta,
                    importe: contraCuenta,
                    idCaja,
                    idUsuario: idUsuario || orden.id_usuario,
                    transaction: t,
                });
            }
        }

        await orden.update(
            {
                estado: 'CERRADA',
                fecha_cierre: new Date(),
                id_caja: idCaja,
                // En multipago el detalle vive en rest_pago_orden; la columna queda null.
                id_metodo_pago: esMultipago ? null : metodoPagoFinal,
            },
            { transaction: t },
        );

        avisarTrasCommit(
            t,
            orden.id_negocio,
            TEMAS.PEDIDOS,
            TEMAS.CAJA,
            TEMAS.COCINA,
            ...(orden.id_mesa ? [TEMAS.MESAS] : []),
        );

        await t.commit();
        return getOrdenById(idOrden);
    } catch (err) {
        if (!t.finished) {
            await t.rollback();
        }
        throw err;
    }
}

module.exports = {
    crearOrden,
    agregarItemsOrden,
    agregarItemsPorCliente,
    quitarItemsOrden,
    getOrdenById,
    getOrdenesAbiertas,
    getOrdenesCocina,
    getOrdenesDespacho,
    listarDomiciliarios,
    esDomiciliarioValido,
    elegirDomiciliarioAlAzar,
    enviarACocina,
    cambiarEstadoCocina,
    marcarDetalleCompleto,
    marcarPagado,
    actualizarValorDomicilio,
    asignarDomiciliario,
    actualizarDescuento,
    cancelarOrden,
    cancelarPorCliente,
    getOrdenesCanceladasRecientes,
    cerrarOrden,
    usuarioPuedeVerTodosDespacho,
};
