/**
 * Configuración de Jest.
 *
 * ## Por qué existe este archivo: `maxWorkers: 1`
 *
 * Hasta el 2026-08-18 no había configuración y Jest corría con sus valores por defecto, que
 * **paralelizan por número de núcleos**. Aquí eso no vale: las 17 suites comparten **una sola
 * base de datos**, y varias afirman sobre estado global de esa base —el `ratio_determinista`
 * de la Consola cuenta *todos* los turnos, el hold protege *un* hueco, la prueba de ráfaga
 * cuenta *las* citas creadas—. Con workers en paralelo, un suite ve las filas que otro acaba
 * de escribir y falla por algo que no tiene nada que ver con lo que prueba.
 *
 * El síntoma es traicionero porque **no es determinista**: la misma corrida daba 7 fallos, luego
 * 5, y ninguno se reproducía aislado. Se pierde una tarde persiguiendo un bug que no existe. En
 * serie, las mismas 332 pruebas pasan enteras y en 24 s — la paralelización no estaba ni
 * comprando velocidad, porque el cuello de botella es la base, no la CPU.
 *
 * Va aquí y no en un script de `package.json` a propósito: en un script solo protege a quien
 * escriba `npm test`, y la costumbre de este repo —y de `CLAUDE.md`— es invocar `npx jest`
 * directamente. Puesto en la configuración, no hay forma de saltárselo por accidente.
 *
 * ⚠️ Si algún día las suites se aíslan de verdad (una base por worker, o esquemas separados),
 * esto se puede quitar. Mientras compartan base, quitarlo devuelve los fallos fantasma.
 */
'use strict';

module.exports = {
    testEnvironment: 'node',
    maxWorkers: 1,

    /**
     * ## Por qué 30 s y no los 5 s de serie
     *
     * El valor por defecto de Jest está pensado para pruebas unitarias en memoria. Aquí la
     * mayoría de las suites abren transacciones contra una base **real**, y en desarrollo esa
     * base suele estar al otro lado de un túnel SSH (ver `docs/vps-desarrollo.md`): una suite
     * que inserta un negocio, su plan, su equipo y luego lo limpia hace decenas de idas y
     * vueltas, y pasa de 5 s sin que nada esté mal.
     *
     * El 2026-10-04 eso dejaba **12 pruebas en rojo** de `cobranza`, `negocios` y `platform`,
     * todas con el mismo mensaje —«Exceeded timeout of 5000 ms»— y ninguna por un fallo de
     * código. El coste de eso no es la espera: es que una suite que siempre tiene rojos deja de
     * leerse, y entonces un rojo de verdad no lo ve nadie.
     *
     * 30 s es holgado para la latencia del túnel y sigue siendo un límite: una prueba que se
     * queda colgada de verdad falla, no bloquea la corrida.
     *
     * ⚠️ Esto trata el síntoma. El arreglo de fondo es correr las pruebas contra un PostgreSQL
     * **local** —ya hay un 17 instalado en el equipo— en vez de contra el de desarrollo por
     * túnel. Mientras la base esté remota, bajar esto devuelve los rojos de mentira.
     */
    testTimeout: 30000,
    // `_apoyo/` guarda utilidades compartidas por las suites (modelos falsos, fixtures): no
    // son pruebas, y sin esto Jest las correría como suites vacías y fallaría.
    testPathIgnorePatterns: ['/node_modules/', '/__tests__/_apoyo/'],
};
