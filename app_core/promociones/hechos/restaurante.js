/**
 * El hecho que define a un cliente de restaurante: **el pedido**.
 *
 * Devuelve el SQL de una subconsulta agrupada por `id_persona_negocio` con las tres cifras que usa
 * la segmentación. Los nombres de las columnas son el contrato con `segmentos.js` y no se cambian
 * sin cambiarlo allí: `eventos`, `ultimo_evento`, `valor_total`.
 *
 * ## Las dos decisiones que lleva dentro, copiadas de donde ya estaban
 *
 * Son las mismas que usa `cuentaService.listarDirectorio`, y es deliberado: si el directorio de
 * Clientes dice «3 pedidos» y Promociones dijera «4», el dueño dejaría de creerle a los dos.
 *
 *   · **Los cancelados y anulados no cuentan como visita.** Un pedido que se anuló no es un
 *     cliente que vino; contarlo infla la frecuencia de justo la gente que más problemas dio.
 *   · **El dinero solo suma de los CERRADOS.** Un pedido abierto todavía puede cambiar de total,
 *     y el valor del cliente no puede moverse según lo que haya a medias esta noche.
 *
 * `fecha_creacion` es `timestamp without time zone` = hora de pared de Bogotá (`CLAUDE.md`), así
 * que la antigüedad se calcula contra `CURRENT_DATE` y no contra `now()` en UTC.
 */
'use strict';

const SQL = `
    SELECT po.id_persona_negocio,
           COUNT(*)::int                                        AS eventos,
           MAX(po.fecha_creacion)                               AS ultimo_evento,
           COALESCE(SUM(po.total) FILTER (WHERE po.estado = 'CERRADA'), 0)::numeric AS valor_total
      FROM restaurante.pedid_orden po
     WHERE po.id_negocio = :idNegocio
       AND po.id_persona_negocio IS NOT NULL
       AND po.estado NOT IN ('CANCELADA', 'ANULADA')
     GROUP BY po.id_persona_negocio
`;

module.exports = {
    vertical: 'restaurante',
    /** Cómo se llama el hecho cuando hay que escribirlo en pantalla. */
    etiqueta: { uno: 'pedido', varios: 'pedidos' },
    sql: SQL,
};
