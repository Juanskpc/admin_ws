'use strict';

/**
 * Qué se copia de la matriz a una sede nueva, por aplicativo.
 *
 * ## Copia inicial, no catálogo compartido
 *
 * Al abrir una sede se clona la configuración de la matriz y desde ese momento cada una edita lo
 * suyo: si la matriz sube un precio, la sede no se entera. Es lo contrario a un catálogo
 * compartido, y es deliberado — un catálogo en vivo obligaría a que cada lectura resolviera «mi
 * negocio o mi padre», y eso toca el POS, el inventario, la vitrina y el asistente. Lo que la
 * sede necesita de verdad es no volver a cargar 80 productos a mano.
 *
 * ## Lista de exclusión, no de inclusión
 *
 * Cada paso dice qué **no** se copia, no qué sí. Es a propósito: las columnas de estas tablas no
 * están iguales en todas las bases —`migrate_restaurante_datos_pago.js` añade `datos_pago` a
 * `rest_metodo_pago` y la base de desarrollo no la tiene—, y una lista de inclusión se saltaría
 * esa columna en producción sin decir nada. Con la exclusión, una columna de configuración nueva
 * viaja sola el día que alguien la añada, que es lo que se quiere casi siempre. El precio es
 * acordarse de excluir una columna nueva que lleve ESTADO en vez de configuración.
 *
 * El ejecutor (`clonarConfiguracion.js`) ya excluye siempre la PK, `id_negocio` y las cuatro
 * columnas de fecha (`fecha_creacion`, `fecha_actualizacion`, `creado_en`, `actualizado_en`), que
 * se rellenan con el DEFAULT de la columna.
 *
 * ## Claves del paso
 *
 * - `tabla` · `pk` — qué tabla y cuál es su llave.
 * - `donde` — SQL extra sobre las filas del padre. Casi siempre `estado = 'A'`: una categoría
 *   que la matriz dio de baja no tiene por qué revivir en la sede.
 * - `excluir` — columnas que NO viajan.
 * - `enlaces` — FK a otra tabla ya clonada: se traduce con el mapa de aquel paso. Si el padre
 *   la tiene en NULL, se queda en NULL.
 * - `autoEnlaces` — FK a la MISMA tabla. Se inserta en NULL y se corrige en una segunda pasada,
 *   porque la fila a la que apunta puede no existir todavía.
 * - `fijos` — valores que se imponen en vez de heredarse.
 * - `onConflict` — cláusula `ON CONFLICT` para la tabla que ya puede traer filas (el punto de
 *   caja que `asegurarCajaPrincipal` siembra al crear el negocio).
 * - `puente` — tabla sin `id_negocio`: sus filas se eligen por las que ya se clonaron.
 */

/** El aplicativo RESTAURANTE: carta, recetas, mesas, formas de pago, barrios, horario, cajas. */
const RESTAURANTE = [
    {
        tabla: 'restaurante.carta_categoria',
        pk: 'id_categoria',
        donde: "estado = 'A'",
    },
    {
        tabla: 'restaurante.carta_ingrediente',
        pk: 'id_ingrediente',
        donde: "estado = 'A'",
        // La receta viaja; la bodega no. Una sede que abre no tiene existencias, y heredar el
        // stock de la matriz le daría un inventario que nunca entró por una compra — justo lo
        // que el módulo de Proveedores existe para que cuadre.
        fijos: { stock_actual: 0 },
    },
    {
        tabla: 'restaurante.carta_producto',
        pk: 'id_producto',
        donde: "estado = 'A'",
        enlaces: { id_categoria: 'restaurante.carta_categoria' },
        // El empaque es otro producto de la misma carta, así que puede no estar insertado aún.
        autoEnlaces: { id_producto_empaque: 'restaurante.carta_producto' },
    },
    {
        tabla: 'restaurante.carta_producto_ingred',
        pk: 'id_producto_ingred',
        donde: "estado = 'A'",
        // No lleva id_negocio: es el puente producto↔ingrediente. Sus filas se eligen por los
        // productos que acabamos de clonar.
        puente: { columna: 'id_producto', mapa: 'restaurante.carta_producto' },
        enlaces: {
            id_producto: 'restaurante.carta_producto',
            id_ingrediente: 'restaurante.carta_ingrediente',
        },
    },
    {
        tabla: 'restaurante.rest_mesa_seccion',
        pk: 'id_seccion',
        donde: "estado = 'A'",
    },
    {
        tabla: 'restaurante.rest_mesa',
        pk: 'id_mesa',
        donde: "estado = 'A'",
        enlaces: { id_seccion: 'restaurante.rest_mesa_seccion' },
        // El servicio en curso es de la matriz. La mesa de la sede nace libre.
        fijos: { estado_servicio: 'DISPONIBLE', fecha_inicio_servicio: null },
    },
    {
        tabla: 'restaurante.rest_metodo_pago',
        pk: 'id_metodo_pago',
        donde: "estado = 'A'",
    },
    {
        tabla: 'restaurante.rest_barrio_domicilio',
        pk: 'id_barrio',
        donde: "estado = 'A'",
    },
    {
        // El horario de atención del negocio. `id_usuario` apunta al turno de UNA persona, y el
        // personal de la sede es otro: solo viajan las filas del negocio.
        tabla: 'restaurante.rest_horario',
        pk: 'id_horario',
        donde: 'id_usuario IS NULL',
        excluir: ['id_usuario'],
    },
    {
        // Los rubros de ingreso (ver `rest_punto_caja`). `asegurarCajaPrincipal` ya le dejó a la
        // sede su «Caja principal» al crearla, así que esa choca y se ignora; los rubros extra
        // que la matriz tenga sí entran.
        tabla: 'restaurante.rest_punto_caja',
        pk: 'id_punto_caja',
        donde: "estado = 'A'",
        onConflict: '(id_negocio, nombre) DO NOTHING',
    },
    {
        // El diseño de la carta virtual: plantilla, formato y marca. `publicado_en` e
        // `id_usuario` dicen quién publicó la de la matriz, y eso no se hereda.
        tabla: 'restaurante.carta_diseno',
        pk: 'id_diseno',
        excluir: ['publicado_en', 'id_usuario'],
    },
];

/** El aplicativo RESERVA: reglas de agenda, servicios, recursos, unidades, productos, horario. */
const RESERVA = [
    {
        // Una fila por negocio (la PK es `id_negocio`). Lleva las reglas de la agenda y las
        // funciones del perfil, que es justo lo que no se quiere volver a configurar.
        tabla: 'reserva.reserva_config',
        pk: 'id_negocio',
        onConflict: '(id_negocio) DO NOTHING',
    },
    {
        tabla: 'reserva.reserva_categoria',
        pk: 'id_categoria',
        donde: "estado = 'A'",
    },
    {
        tabla: 'reserva.reserva_tipo_recurso',
        pk: 'id_tipo_recurso',
        donde: "estado = 'A'",
    },
    {
        tabla: 'reserva.reserva_recurso',
        pk: 'id_recurso',
        donde: "estado = 'A'",
        enlaces: { id_tipo_recurso: 'reserva.reserva_tipo_recurso' },
    },
    {
        tabla: 'reserva.reserva_servicio',
        pk: 'id_servicio',
        donde: "estado = 'A'",
        enlaces: {
            id_categoria: 'reserva.reserva_categoria',
            id_tipo_recurso: 'reserva.reserva_tipo_recurso',
        },
    },
    {
        tabla: 'reserva.reserva_servicio_variante',
        pk: 'id_variante',
        donde: "estado = 'A'",
        enlaces: { id_servicio: 'reserva.reserva_servicio' },
    },
    {
        tabla: 'reserva.reserva_unidad_tipo',
        pk: 'id_unidad_tipo',
        donde: "estado = 'A'",
    },
    {
        tabla: 'reserva.reserva_unidad',
        pk: 'id_unidad',
        donde: "estado = 'A'",
        enlaces: { id_unidad_tipo: 'reserva.reserva_unidad_tipo' },
        // `ical_token` es único en toda la tabla y es lo que publica el calendario de ESA unidad.
        // Omitirlo deja que lo genere el DEFAULT (`gen_random_uuid()`): copiarlo sería darle a
        // dos unidades distintas el mismo calendario público.
        excluir: ['ical_token'],
    },
    {
        tabla: 'reserva.reserva_tarifa_temporada',
        pk: 'id_tarifa',
        donde: "estado = 'A'",
        enlaces: { id_unidad_tipo: 'reserva.reserva_unidad_tipo' },
    },
    {
        tabla: 'reserva.reserva_producto_categoria',
        pk: 'id_categoria',
        donde: "estado = 'A'",
    },
    {
        tabla: 'reserva.reserva_producto',
        pk: 'id_producto',
        donde: "estado = 'A'",
        enlaces: { id_categoria: 'reserva.reserva_producto_categoria' },
        // Mismo criterio que los insumos del restaurante: la ficha viaja, las existencias no.
        fijos: { stock_actual: 0 },
    },
    {
        tabla: 'reserva.reserva_metodo_pago',
        pk: 'id_metodo_pago',
        donde: "estado = 'A'",
    },
    {
        // El horario del local. El de cada profesional (`id_profesional`) se queda en la matriz:
        // los profesionales no se clonan, porque son personas y trabajan en una sede concreta.
        tabla: 'reserva.reserva_horario',
        pk: 'id_horario',
        donde: 'id_profesional IS NULL',
        excluir: ['id_profesional'],
    },
];

/**
 * Lo que se clona en TODO negocio, sea cual sea su aplicativo.
 *
 * `gener_nivel_negocio` es el ajuste de permisos POR NEGOCIO sobre el catálogo de roles (los
 * roles en sí son por aplicativo y ya los comparten todas las sedes). Sin esto, una sede nacería
 * con los permisos de fábrica y el dueño tendría que volver a quitar y poner vistas rol por rol.
 */
const COMUNES = [
    {
        tabla: 'general.gener_nivel_negocio',
        pk: 'id_nivel_negocio',
        donde: "estado = 'A'",
        onConflict: '(id_negocio, id_rol, id_nivel) DO NOTHING',
    },
];

/** Por NOMBRE del aplicativo, nunca por id: los de `gener_tipo_negocio` difieren dev/prod. */
const POR_APLICATIVO = {
    RESTAURANTE,
    RESERVA,
};

module.exports = { POR_APLICATIVO, COMUNES };
