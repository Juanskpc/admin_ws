/**
 * El hecho que define a un cliente de reserva: **la cita**.
 *
 * Mismo contrato de columnas que el de restaurante (`eventos`, `ultimo_evento`, `valor_total`), que
 * es lo que permite que la segmentación, el simulador y los informes no sepan en qué vertical
 * están.
 *
 * ## Qué cuenta como visita, y por qué no es lo mismo que en restaurante
 *
 * Una cita tiene dos formas de no ocurrir y las dos importan de distinta manera:
 *
 *   · **`cancelada`**: no vino, y avisó. No cuenta como visita.
 *   · **`no_show`**: no vino y no avisó. **Tampoco** cuenta — pero conviene saber que esta gente
 *     queda con su última visita más antigua de lo que el negocio recuerda, así que caerá en
 *     «en riesgo» o «dormido». Es correcto: a quien dejó plantado al profesional hay más razón
 *     para intentar recuperarlo con una promoción, no menos.
 *   · `pendiente` y `confirmada` sí cuentan: son citas vivas, aunque todavía no haya pasado.
 *
 * El dinero sale de las **completadas**, que es el mismo criterio que ya usa
 * `app_reserva_api/services/clienteService.js` para el total gastado de su cartera. Dos cifras
 * distintas del mismo cliente en dos pantallas es lo que hace que nadie se crea ninguna.
 *
 * `fecha_hora_inicio` y no `fecha_creacion`: la última visita es cuando **vino**, no cuando pidió
 * la cita. Para una barbería que agenda con dos semanas de antelación, la diferencia decide el
 * segmento.
 */
'use strict';

const SQL = `
    SELECT c.id_persona_negocio,
           COUNT(*)::int                                            AS eventos,
           MAX(c.fecha_hora_inicio)                                 AS ultimo_evento,
           COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado = 'completada'), 0)::numeric AS valor_total
      FROM reserva.reserva_cita c
     WHERE c.id_negocio = :idNegocio
       AND c.id_persona_negocio IS NOT NULL
       AND c.estado NOT IN ('cancelada', 'no_show')
     GROUP BY c.id_persona_negocio
`;

module.exports = {
    vertical: 'reserva',
    etiqueta: { uno: 'cita', varios: 'citas' },
    sql: SQL,
};
