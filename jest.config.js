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
};
