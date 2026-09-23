'use strict';
/**
 * negocioCicloVidaService — inactivar, reactivar, eliminar un negocio y su historial.
 *
 * ## Eliminar: siempre se puede, con todo lo que cuelga del negocio
 *
 * Es definitivo, así que el flujo es en dos tiempos:
 *
 * 1. `previsualizarEliminacion` — no toca nada. Cuenta qué usuarios se verán afectados y cuántas
 *    filas hay en CADA tabla del negocio, operativa o de configuración, para que quien lo pide vea
 *    lo que va a destruir antes de decidir.
 * 2. `eliminarNegocio` — exige escribir el nombre exacto del negocio y hace todo en UNA
 *    transacción: usuarios, datos, negocio y evento de auditoría. Si algo falla, rollback completo.
 *
 * ## Qué se borra, y cómo se sabe
 *
 * No hay una lista fija de tablas: se recorre el catálogo de Postgres.
 *  - Toda FK que cuelga de `general.gener_negocio`, y recursivamente las FK que cuelgan de esas
 *    tablas (ítems de pedido, líneas de factura… que no tienen `id_negocio`). Cada tabla se
 *    filtra por las filas que alcanza desde el negocio y se borra de las hojas hacia la raíz.
 *  - Las tablas con columna `id_negocio` pero SIN FK (el Ledger particionado de `intelligence`:
 *    Postgres no deja FK hacia tablas particionadas por fecha). También se borran.
 *  - `auditoria.*` NO se borra nunca: es la memoria de quién eliminó qué, incluido este evento.
 * Una tabla nueva con FK se incluye sola; que nadie tenga que acordarse de tocar este archivo es
 * justo lo que impide dejar datos huérfanos en silencio.
 *
 * ## Personas
 * - Quien SOLO está en este negocio (y no tiene rol global) se elimina con `softDeleteUsuario`, el
 *   mismo borrado lógico de `DELETE /usuarios/admin/:id`.
 * - Quien también está en otros negocios, o tiene un rol global, NO se elimina: solo pierde el
 *   vínculo con este. Nunca se toca un rol o vínculo de otro negocio ni un rol global.
 *
 * ## Auditoría
 * Cada cambio deja un evento `modulo = 'negocios'` DENTRO de la transacción. Un negocio eliminado
 * ya no tiene fila: su nombre y el resumen del borrado viajan en `detalle`.
 */
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const UsuarioAdminDao = require('../../app_core/dao/usuarioAdminDao');
const { initTransaction } = require('../../app_core/helpers/funcionesAdicionales');

const sequelize = Models.sequelize;
const MODULO_AUDITORIA = 'negocios';
const RAIZ = 'general.gener_negocio';

/**
 * Tablas que jamás deben entrar en un borrado por negocio. Si el recorrido llegara a alcanzar
 * alguna (alguien le pone una FK a una tabla del negocio) el borrado se niega en vez de arrasar
 * catálogos o personas compartidas.
 */
const TABLAS_PROTEGIDAS = [
    'general.gener_usuario',
    'general.gener_rol',
    'general.gener_tipo_negocio',
    'general.gener_plan',
];

/** Esquemas cuyas tablas con `id_negocio` se conservan: la auditoría es la historia del sistema. */
const ESQUEMAS_CONSERVADOS = ['auditoria'];

/**
 * Cuáles son CONFIGURACIÓN (lo que se monta al dar de alta el negocio) y cuáles DATOS del cliente.
 * Solo sirve para presentar el resumen: el borrado no depende de esta lista. Una tabla hija se
 * considera configuración si todas las tablas de las que cuelga lo son.
 */
const TABLAS_DE_CONFIG = new Set([
    'general.gener_negocio_usuario', 'general.gener_usuario_rol', 'general.gener_negocio_plan',
    'general.gener_negocio_fiscal', 'general.gener_nivel_negocio', 'general.gener_notificacion',
    'cobranza.cob_suscripcion_complemento', 'cobranza.cob_suscripcion', 'cobranza.cob_metodo_pago',
    'platform.capacidad_habilitada', 'platform.capacidad_idempotencia', 'platform.numero_canal',
    'platform.outbox',
    'reserva.reserva_config', 'reserva.reserva_horario', 'reserva.reserva_hold',
    'reserva.reserva_bloqueo_unidad', 'reserva.reserva_bloqueo', 'reserva.reserva_calendario_externo',
    'reserva.reserva_tarifa_temporada', 'reserva.reserva_servicio_variante', 'reserva.reserva_servicio',
    'reserva.reserva_profesional_imagen', 'reserva.reserva_profesional', 'reserva.reserva_categoria',
    'reserva.reserva_metodo_pago', 'reserva.reserva_recurso', 'reserva.reserva_tipo_recurso',
    'reserva.reserva_unidad', 'reserva.reserva_unidad_tipo',
    'restaurante.rest_punto_caja_usuario', 'restaurante.rest_punto_caja', 'restaurante.rest_horario',
    'restaurante.rest_mesa', 'restaurante.rest_metodo_pago', 'restaurante.carta_diseno',
    'restaurante.carta_producto', 'restaurante.carta_ingrediente', 'restaurante.carta_categoria',
    'tienda.tienda_producto', 'tienda.tienda_categoria', 'tienda.tienda_proveedor',
    'gym.gym_plan', 'gym.gym_producto',
    'parqueadero.parq_capacidad', 'parqueadero.parq_configuracion', 'parqueadero.parq_metodo_pago',
    'parqueadero.parq_tarifa', 'parqueadero.parq_tipo_vehiculo',
]);

/** Nombre humano de cada tabla en el resumen. Lo que falte se deduce del nombre (`etiquetaDe`). */
const ETIQUETAS = {
    'restaurante.pedid_orden': 'pedidos',
    'restaurante.pedid_detalle': 'ítems de pedidos',
    'restaurante.pedid_detalle_exclu': 'ingredientes excluidos en pedidos',
    'restaurante.rest_pago_orden': 'pagos de pedidos',
    'restaurante.rest_caja': 'turnos de caja',
    'restaurante.rest_movimiento_caja': 'movimientos de caja',
    'restaurante.rest_cuenta': 'cuentas de clientes (fiado/tiqueteras)',
    'restaurante.rest_cuenta_movimiento': 'movimientos de cuentas de clientes',
    'restaurante.carta_producto': 'productos de la carta',
    'restaurante.carta_categoria': 'categorías de la carta',
    'restaurante.carta_ingrediente': 'ingredientes',
    'restaurante.carta_producto_ingred': 'ingredientes por producto',
    'restaurante.carta_diseno': 'diseño de la carta',
    'restaurante.rest_mesa': 'mesas',
    'restaurante.rest_horario': 'horarios de atención',
    'restaurante.rest_metodo_pago': 'métodos de pago',
    'restaurante.rest_punto_caja': 'puntos de caja',
    'restaurante.rest_punto_caja_usuario': 'personal por punto de caja',
    'reserva.reserva_cita': 'citas',
    'reserva.reserva_cita_servicio': 'servicios de las citas',
    'reserva.reserva_pago_cita': 'pagos de citas',
    'reserva.reserva_caja': 'turnos de caja',
    'reserva.reserva_movimiento_caja': 'movimientos de caja',
    'reserva.reserva_servicio': 'servicios',
    'reserva.reserva_servicio_variante': 'variantes de servicios',
    'reserva.reserva_profesional': 'profesionales',
    'reserva.reserva_profesional_servicio': 'servicios por profesional',
    'reserva.reserva_profesional_imagen': 'imágenes de profesionales',
    'reserva.reserva_categoria': 'categorías de servicios',
    'reserva.reserva_horario': 'horarios',
    'reserva.reserva_config': 'configuración de reservas',
    'reserva.reserva_metodo_pago': 'métodos de pago',
    'reserva.reserva_estancia': 'estancias',
    'reserva.reserva_estancia_cargo': 'cargos de estancias',
    'reserva.reserva_ficha': 'fichas de clientes',
    'reserva.reserva_mascota': 'mascotas',
    'cobranza.cob_factura': 'facturas de cobro',
    'cobranza.cob_factura_detalle': 'líneas de facturas de cobro',
    'cobranza.cob_transaccion': 'transacciones de pago',
    'cobranza.cob_suscripcion': 'suscripción',
    'cobranza.cob_suscripcion_complemento': 'complementos de la suscripción',
    'cobranza.cob_metodo_pago': 'métodos de pago de cobranza',
    'general.gener_negocio_plan': 'planes del negocio',
    'general.gener_negocio_fiscal': 'datos fiscales',
    'general.gener_nivel_negocio': 'permisos del negocio',
    'general.gener_notificacion': 'notificaciones',
    'general.gener_negocio_usuario': 'vínculos de usuarios',
    'general.gener_usuario_rol': 'roles de usuarios',
    'general.gener_aviso_plan_enviado': 'avisos de plan enviados',
    'platform.persona_negocio': 'clientes del negocio',
    'platform.numero_canal': 'números de WhatsApp',
    'platform.capacidad_habilitada': 'capacidades del asistente',
    'platform.capacidad_idempotencia': 'registros de idempotencia',
    'platform.outbox': 'eventos internos',
    'intelligence.conversacion': 'conversaciones del asistente',
    'intelligence.mensaje': 'mensajes del asistente',
    'intelligence.turno': 'turnos del asistente',
    'intelligence.paso': 'pasos del asistente',
    'intelligence.invocacion_capacidad': 'acciones del asistente',
    'intelligence.costo': 'costos del asistente',
    'intelligence.ingesta_recibida': 'mensajes recibidos',
    'intelligence.reporte': 'reportes del asistente',
    'intelligence.recordatorio': 'recordatorios',
    'tienda.tienda_venta': 'ventas',
    'tienda.tienda_venta_detalle': 'ítems de ventas',
    'tienda.tienda_movimiento': 'movimientos de inventario',
    'tienda.tienda_producto': 'productos',
    'tienda.tienda_cliente': 'clientes',
    'gym.gym_miembro': 'miembros',
    'gym.gym_membresia': 'membresías',
    'parqueadero.parq_vehiculo': 'vehículos',
    'parqueadero.parq_caja': 'turnos de caja',
};

/** Error de dominio: `.code` + `.statusCode` (+ `.data`) para que el controlador lo reenvíe tal cual. */
function errorDominio(message, code, statusCode, data) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    if (data !== undefined) err.data = data;
    return err;
}

/** `restaurante.rest_mesa` → «rest mesa». Solo para lo que no está en ETIQUETAS. */
const etiquetaDe = (tabla) => ETIQUETAS[tabla] ?? tabla.split('.')[1].replace(/_/g, ' ');

const ident = (nombre) => `"${String(nombre).replace(/"/g, '""')}"`;

// ── Plan de borrado guiado por el catálogo ───────────────────────────────────

/**
 * Lee las FK del catálogo y arma el plan: tablas en orden de borrado (hojas primero, negocio al
 * final) y, para cada una, el SQL que selecciona SUS filas de este negocio.
 *
 * `conparentid = 0` y `NOT relispartition` dejan solo las FK y tablas "de verdad": una tabla
 * particionada cuenta una vez, y su DELETE ya recorre las particiones.
 */
async function construirPlan(transaction) {
    const [fks] = await sequelize.query(
        `SELECT format('%I.%I', hn.nspname, hc.relname) AS hijo,
                format('%I.%I', pn.nspname, pc.relname) AS padre,
                (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols_hijo,
                (SELECT array_agg(a.attname::text ORDER BY k.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS cols_padre
           FROM pg_constraint con
           JOIN pg_class hc ON hc.oid = con.conrelid
           JOIN pg_namespace hn ON hn.oid = hc.relnamespace
           JOIN pg_class pc ON pc.oid = con.confrelid
           JOIN pg_namespace pn ON pn.oid = pc.relnamespace
          WHERE con.contype = 'f' AND con.conparentid = 0
            AND NOT hc.relispartition AND NOT pc.relispartition`,
        { transaction },
    );

    // Clausura: todo lo que cuelga, directa o indirectamente, del negocio. Las FK de una tabla a
    // sí misma (movimiento que anula a otro) no crean dependencia entre tablas: las resuelve el
    // propio DELETE, que comprueba las FK al terminar la sentencia.
    const nodos = new Set([RAIZ]);
    const aristas = [];
    for (let cambio = true; cambio;) {
        cambio = false;
        for (const f of fks) {
            if (!nodos.has(f.padre) || f.hijo === f.padre || aristas.includes(f)) continue;
            aristas.push(f);
            if (!nodos.has(f.hijo)) { nodos.add(f.hijo); cambio = true; }
        }
    }

    const protegida = TABLAS_PROTEGIDAS.find((t) => nodos.has(t));
    if (protegida) {
        throw errorDominio(
            `El recorrido de borrado alcanzó ${protegida}, que es compartida. Se cancela por seguridad.`,
            'NEGOCIO_ELIMINACION_INSEGURA',
            500,
        );
    }

    const aristasDeHijo = new Map();
    for (const a of aristas) {
        if (!aristasDeHijo.has(a.hijo)) aristasDeHijo.set(a.hijo, []);
        aristasDeHijo.get(a.hijo).push(a);
    }

    // Orden de borrado (Kahn): una tabla sale cuando ya no queda ninguna hija sin borrar.
    const pendientesHijas = new Map([...nodos].map((n) => [n, 0]));
    for (const a of aristas) pendientesHijas.set(a.padre, pendientesHijas.get(a.padre) + 1);
    const cola = [...nodos].filter((n) => pendientesHijas.get(n) === 0);
    const orden = [];
    while (cola.length > 0) {
        const t = cola.shift();
        orden.push(t);
        for (const a of aristasDeHijo.get(t) ?? []) {
            pendientesHijas.set(a.padre, pendientesHijas.get(a.padre) - 1);
            if (pendientesHijas.get(a.padre) === 0) cola.push(a.padre);
        }
    }
    if (orden.length !== nodos.size) {
        throw errorDominio(
            'Las tablas del negocio se referencian en ciclo y no hay orden seguro de borrado.',
            'NEGOCIO_ELIMINACION_INSEGURA',
            500,
        );
    }

    // Alcance: "las filas de esta tabla que pertenecen al negocio".
    let n = 0;
    const alcance = (tabla, alias) => {
        if (tabla === RAIZ) return `${alias}.id_negocio = :id`;
        const partes = (aristasDeHijo.get(tabla) ?? []).map((a) => {
            const pa = `p${n++}`;
            const propias = a.cols_hijo.map((c) => `${alias}.${ident(c)}`).join(', ');
            const ajenas = a.cols_padre.map((c) => `${pa}.${ident(c)}`).join(', ');
            return `(${propias}) IN (SELECT ${ajenas} FROM ${a.padre} ${pa} WHERE ${alcance(a.padre, pa)})`;
        });
        return partes.length === 1 ? partes[0] : `(${partes.join(' OR ')})`;
    };

    const tablas = orden.map((tabla) => ({ tabla, donde: alcance(tabla, 't') }));

    // El Ledger particionado no tiene FK (Postgres no las admite hacia tablas particionadas por
    // fecha): se encuentra por su columna `id_negocio`.
    const [conColumna] = await sequelize.query(
        `SELECT format('%I.%I', n.nspname, c.relname) AS tabla
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE a.attname = 'id_negocio' AND NOT a.attisdropped
            AND c.relkind IN ('r', 'p') AND NOT c.relispartition
            AND n.nspname NOT IN ('pg_catalog', 'information_schema', ${ESQUEMAS_CONSERVADOS.map((e) => `'${e}'`).join(', ')})
          ORDER BY 1`,
        { transaction },
    );
    const sinFk = conColumna
        .map((r) => r.tabla)
        .filter((t) => !nodos.has(t))
        .map((tabla) => ({ tabla, donde: 't.id_negocio = :id' }));

    // Presentación: ¿configuración o datos del cliente?
    const memo = new Map();
    const esConfig = (tabla) => {
        if (memo.has(tabla)) return memo.get(tabla);
        let r;
        if (TABLAS_DE_CONFIG.has(tabla)) r = true;
        else if (tabla === RAIZ || !aristasDeHijo.has(tabla)) r = false;
        else r = aristasDeHijo.get(tabla).every((a) => a.padre !== RAIZ && esConfig(a.padre));
        memo.set(tabla, r);
        return r;
    };

    // Las tablas sin FK van antes de la raíz: da igual entre sí, pero la raíz cierra el borrado.
    const raiz = tablas.pop();
    return { pasos: [...sinFk, ...tablas, raiz], esConfig };
}

// ── Personas ─────────────────────────────────────────────────────────────────

/**
 * Personas con vínculo ACTIVO al negocio (por membresía o por rol), sin contar las ya eliminadas.
 *
 * `accion` es lo que les pasaría al eliminar el negocio: se ELIMINA a quien solo está aquí; se
 * DESVINCULA a quien también está en otros negocios o tiene un rol global (borrarlo le quitaría
 * el acceso a lo que no es de este negocio).
 */
async function usuariosVinculados(idNegocio, transaction) {
    const [rows] = await sequelize.query(
        `SELECT u.id_usuario,
                TRIM(COALESCE(u.primer_nombre, '') || ' ' || COALESCE(u.primer_apellido, '')) AS nombre,
                u.num_identificacion AS identificacion,
                (SELECT COUNT(DISTINCT x.id_negocio)::int
                   FROM (
                       SELECT nu2.id_negocio FROM general.gener_negocio_usuario nu2
                        WHERE nu2.id_usuario = u.id_usuario AND nu2.estado = 'A'
                          AND nu2.id_negocio <> :id
                       UNION
                       SELECT ur2.id_negocio FROM general.gener_usuario_rol ur2
                        WHERE ur2.id_usuario = u.id_usuario AND ur2.estado = 'A'
                          AND ur2.id_negocio IS NOT NULL AND ur2.id_negocio <> :id
                   ) x) AS otros_negocios,
                EXISTS (SELECT 1 FROM general.gener_usuario_rol ur3
                         WHERE ur3.id_usuario = u.id_usuario AND ur3.estado = 'A'
                           AND ur3.id_negocio IS NULL) AS tiene_rol_global
           FROM general.gener_usuario u
          WHERE u.estado <> 'E'
            AND (
                EXISTS (SELECT 1 FROM general.gener_negocio_usuario nu
                         WHERE nu.id_usuario = u.id_usuario AND nu.id_negocio = :id AND nu.estado = 'A')
             OR EXISTS (SELECT 1 FROM general.gener_usuario_rol ur
                         WHERE ur.id_usuario = u.id_usuario AND ur.id_negocio = :id AND ur.estado = 'A')
            )
          ORDER BY nombre`,
        { replacements: { id: idNegocio }, transaction },
    );
    return rows.map((u) => ({
        id_usuario: u.id_usuario,
        nombre: u.nombre,
        identificacion: u.identificacion,
        otros_negocios: u.otros_negocios,
        accion: u.otros_negocios === 0 && !u.tiene_rol_global ? 'eliminar' : 'desvincular',
    }));
}

// ── Estado (inactivar / reactivar) ───────────────────────────────────────────

/**
 * Cambia el estado A/I y deja constancia de quién y por qué.
 * @returns {Promise<{ cambio: boolean, nombre: string }>} `cambio` = false si ya estaba así
 */
async function cambiarEstado(idNegocio, estado, motivo = null) {
    const transaction = await initTransaction();
    try {
        const [[negocio]] = await sequelize.query(
            `SELECT nombre, estado FROM general.gener_negocio WHERE id_negocio = :id FOR UPDATE`,
            { replacements: { id: idNegocio }, transaction },
        );
        if (!negocio) throw errorDominio('Negocio no encontrado', 'NEGOCIO_NO_ENCONTRADO', 404);

        const cambio = negocio.estado !== estado;
        if (cambio) {
            await sequelize.query(
                `UPDATE general.gener_negocio SET estado = :estado WHERE id_negocio = :id`,
                { replacements: { id: idNegocio, estado }, transaction },
            );
            await Audit.registrarEvento({
                modulo: MODULO_AUDITORIA,
                accion: estado === 'I' ? 'negocio_inactivado' : 'negocio_reactivado',
                idNegocio,
                detalle: { nombre: negocio.nombre, ...(motivo ? { motivo } : {}) },
                transaction,
            });
        }

        await transaction.commit();
        return { cambio, nombre: negocio.nombre };
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

// ── Eliminar ─────────────────────────────────────────────────────────────────

/**
 * Qué se llevaría por delante eliminar el negocio. NO modifica nada.
 * @returns {Promise<{negocio, usuarios, datos, totales}>}
 */
async function previsualizarEliminacion(idNegocio) {
    const [[negocio]] = await sequelize.query(
        `SELECT id_negocio, nombre, nit, estado FROM general.gener_negocio WHERE id_negocio = :id`,
        { replacements: { id: idNegocio } },
    );
    if (!negocio) throw errorDominio('Negocio no encontrado', 'NEGOCIO_NO_ENCONTRADO', 404);

    const usuarios = await usuariosVinculados(idNegocio);
    const { pasos, esConfig } = await construirPlan();

    const datos = [];
    for (const { tabla, donde } of pasos) {
        const [[{ filas }]] = await sequelize.query(
            `SELECT COUNT(*)::int AS filas FROM ${tabla} t WHERE ${donde}`,
            { replacements: { id: idNegocio } },
        );
        // La fila del negocio no es "un dato": es lo que se está eliminando.
        if (filas === 0 || tabla === RAIZ) continue;
        datos.push({
            tabla,
            etiqueta: etiquetaDe(tabla),
            filas,
            tipo: esConfig(tabla) ? 'configuracion' : 'operativo',
        });
    }
    datos.sort((a, b) => (a.tipo === b.tipo ? b.filas - a.filas : a.tipo === 'operativo' ? -1 : 1));

    const suma = (tipo) => datos.filter((d) => d.tipo === tipo).reduce((s, d) => s + d.filas, 0);
    return {
        negocio,
        usuarios,
        datos,
        totales: {
            usuarios: usuarios.length,
            usuarios_eliminados: usuarios.filter((u) => u.accion === 'eliminar').length,
            usuarios_desvinculados: usuarios.filter((u) => u.accion === 'desvincular').length,
            filas_operativas: suma('operativo'),
            filas_configuracion: suma('configuracion'),
            filas: suma('operativo') + suma('configuracion'),
        },
    };
}

/**
 * Elimina el negocio y todo lo suyo, en una sola transacción. Ver la cabecera del archivo.
 * @param {number} idNegocio
 * @param {string} confirmacion El nombre exacto del negocio, escrito por quien lo elimina.
 */
async function eliminarNegocio(idNegocio, confirmacion) {
    const transaction = await initTransaction();
    try {
        // Bloquea la fila: mientras se elimina, nadie puede vincular gente ni cambiarle el estado.
        const [[negocio]] = await sequelize.query(
            `SELECT nombre, nit FROM general.gener_negocio WHERE id_negocio = :id FOR UPDATE`,
            { replacements: { id: idNegocio }, transaction },
        );
        if (!negocio) throw errorDominio('Negocio no encontrado', 'NEGOCIO_NO_ENCONTRADO', 404);

        if (typeof confirmacion !== 'string' || confirmacion.trim() !== negocio.nombre.trim()) {
            throw errorDominio(
                'Para eliminar el negocio hay que escribir su nombre exacto.',
                'CONFIRMACION_INVALIDA',
                400,
            );
        }

        // 1. Personas.
        const usuarios = await usuariosVinculados(idNegocio, transaction);
        const eliminados = usuarios.filter((u) => u.accion === 'eliminar');
        const desvinculados = usuarios.filter((u) => u.accion === 'desvincular');
        for (const u of eliminados) {
            await UsuarioAdminDao.softDeleteUsuario(u.id_usuario, transaction);
        }
        // Los desvinculados no necesitan UPDATE: sus vínculos y roles de ESTE negocio son filas
        // del negocio y se borran con el resto (`gener_negocio_usuario`, `gener_usuario_rol`).

        // 2 y 3. Datos, de las hojas a la raíz; la última es la fila del negocio.
        const { pasos } = await construirPlan(transaction);
        const filasPorTabla = {};
        for (const { tabla, donde } of pasos) {
            const [, meta] = await sequelize.query(
                `DELETE FROM ${tabla} t WHERE ${donde}`,
                { replacements: { id: idNegocio }, transaction },
            );
            if (meta?.rowCount > 0) filasPorTabla[tabla] = meta.rowCount;
        }

        // 4. Constancia.
        await Audit.registrarEvento({
            modulo: MODULO_AUDITORIA,
            accion: 'negocio_eliminado',
            idNegocio,
            detalle: {
                nombre: negocio.nombre,
                nit: negocio.nit ?? null,
                usuarios_eliminados: eliminados.map((u) => ({ id_usuario: u.id_usuario, nombre: u.nombre })),
                usuarios_desvinculados: desvinculados.map((u) => ({ id_usuario: u.id_usuario, nombre: u.nombre })),
                filas_por_tabla: filasPorTabla,
            },
            transaction,
        });

        await transaction.commit();
        return {
            id_negocio: idNegocio,
            nombre: negocio.nombre,
            usuarios_eliminados: eliminados.length,
            usuarios_desvinculados: desvinculados.length,
            filas_por_tabla: filasPorTabla,
        };
    } catch (error) {
        await transaction.rollback();
        if (error.statusCode) throw error;
        // Cualquier otro fallo (una FK que el recorrido no vio, un trigger…) deshace todo.
        console.error('[negocioCicloVida] Falló eliminarNegocio, se revirtió todo:', error);
        throw errorDominio(
            'No se pudo eliminar el negocio y no se cambió nada. ' +
            `Detalle técnico: ${error.parent?.detail ?? error.parent?.message ?? error.message}`,
            'NEGOCIO_ELIMINACION_FALLIDA',
            500,
        );
    }
}

// ── Historial ────────────────────────────────────────────────────────────────

/** Línea de tiempo del negocio: quién lo inactivó, reactivó o eliminó, y cuándo. */
async function historial(idNegocio, limite = 50) {
    const [rows] = await sequelize.query(
        `SELECT e.id_evento, e.fecha, e.accion, e.resultado, e.id_usuario, e.detalle,
                TRIM(COALESCE(u.primer_nombre, '') || ' ' || COALESCE(u.primer_apellido, '')) AS usuario_nombre
           FROM auditoria.audit_evento e
           LEFT JOIN general.gener_usuario u ON u.id_usuario = e.id_usuario
          WHERE e.modulo = :modulo AND e.id_negocio = :id
          ORDER BY e.fecha DESC, e.id_evento DESC
          LIMIT :limite`,
        { replacements: { modulo: MODULO_AUDITORIA, id: idNegocio, limite } },
    );
    return rows;
}

module.exports = {
    cambiarEstado,
    eliminarNegocio,
    previsualizarEliminacion,
    historial,
    usuariosVinculados,
};
