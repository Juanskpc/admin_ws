/**
 * Las sedes: que los pasos de clonado estén en un orden que pueda funcionar.
 *
 * Al abrir una sede se copia la configuración de la matriz tabla por tabla, y cada fila nueva
 * tiene que apuntar a las filas nuevas, no a las de la matriz: el producto clonado va a la
 * categoría clonada. Eso lo hace `clonarConfiguracion` traduciendo cada FK con el mapa
 * viejo→nuevo del paso que la creó, lo que impone una condición simple y fácil de romper: **el
 * paso que crea una tabla tiene que ir ANTES del paso que la referencia**.
 *
 * Romperlo no da un error sutil: el clonado se detiene con `SEDE_CLON_ORDEN_PASOS` y la sede no
 * se crea. Pero se rompe editando una lista, sin tocar una línea de lógica, así que la condición
 * se comprueba aquí en vez de esperar a que alguien intente abrir una sede.
 *
 * **No toca la base de datos.** `pasosDeClonado.js` es una declaración, y lo que se afirma son
 * propiedades de esa declaración. La base de desarrollo es compartida y las suites que escriben
 * filas están prohibidas (ver `docs/desarrollo-local.md`); el alta de verdad se prueba a mano.
 *
 *   npx jest __tests__/negocios/sede_pasos_clonado.test.js
 */
'use strict';

const { POR_APLICATIVO, COMUNES } = require('../../app_core/sede/pasosDeClonado');
const { aplicativoSoportado } = require('../../app_core/sede/clonarConfiguracion');

/** Los aplicativos que tienen pasos escritos, tal como los resuelve el clonador. */
const APLICATIVOS = Object.keys(POR_APLICATIVO);

describe('sedes · pasos de clonado', () => {
    it('hay pasos para los dos aplicativos que existen de verdad', () => {
        // RESTAURANTE y RESERVA son los únicos verticales desplegados (ver
        // `tipoNegocioOperativo`). Si aparece un tercero, esta prueba es el recordatorio de que
        // sus pasos hay que escribirlos.
        expect(APLICATIVOS).toEqual(expect.arrayContaining(['RESTAURANTE', 'RESERVA']));
    });

    it('reconoce el aplicativo sin importar cómo venga escrito', () => {
        // El nombre llega de `gener_tipo_negocio.nombre`, y se resuelve por NOMBRE porque los
        // ids no coinciden entre desarrollo y producción.
        expect(aplicativoSoportado('RESTAURANTE')).toBe(true);
        expect(aplicativoSoportado('  restaurante ')).toBe(true);
        expect(aplicativoSoportado('Reserva')).toBe(true);
        // Un tipo del catálogo sin vertical construido: la sede se puede abrir, pero nacería
        // vacía, y la consola avisa antes.
        expect(aplicativoSoportado('PARQUEADERO')).toBe(false);
        expect(aplicativoSoportado(null)).toBe(false);
        expect(aplicativoSoportado('')).toBe(false);
    });

    describe.each(APLICATIVOS)('%s', (aplicativo) => {
        // Los comunes corren primero para todos: así los ve el clonador.
        const pasos = [...COMUNES, ...POR_APLICATIVO[aplicativo]];

        it('cada paso declara tabla y llave primaria', () => {
            for (const paso of pasos) {
                expect(typeof paso.tabla).toBe('string');
                expect(paso.tabla).toMatch(/^[a-z_]+\.[a-z_]+$/);
                expect(typeof paso.pk).toBe('string');
                expect(paso.pk.length).toBeGreaterThan(0);
            }
        });

        it('ninguna tabla se clona dos veces', () => {
            // Dos pasos sobre la misma tabla se pisarían el mapa viejo→nuevo, y el segundo
            // dejaría sin traducir las FK del primero.
            const tablas = pasos.map((p) => p.tabla);
            expect(new Set(tablas).size).toBe(tablas.length);
        });

        it('cada `enlaces` apunta a una tabla clonada ANTES', () => {
            const yaClonadas = new Set();
            for (const paso of pasos) {
                for (const [columna, destino] of Object.entries(paso.enlaces ?? {})) {
                    expect(yaClonadas.has(destino)).toBe(true);
                    // El mensaje importa tanto como la afirmación: quien rompa el orden tiene
                    // que leer qué columna y de qué paso.
                    if (!yaClonadas.has(destino)) {
                        throw new Error(
                            `${paso.tabla}.${columna} apunta a ${destino}, que se clona después`,
                        );
                    }
                }
                yaClonadas.add(paso.tabla);
            }
        });

        it('cada `autoEnlaces` apunta a su propia tabla', () => {
            // Un `autoEnlaces` se inserta en NULL y se corrige en una segunda pasada DENTRO del
            // mismo paso. Apuntar a otra tabla desde ahí no haría nada: iría en `enlaces`.
            for (const paso of pasos) {
                for (const [columna, destino] of Object.entries(paso.autoEnlaces ?? {})) {
                    expect(destino).toBe(paso.tabla);
                    if (destino !== paso.tabla) {
                        throw new Error(
                            `${paso.tabla}.${columna} está en autoEnlaces pero apunta a ${destino}`,
                        );
                    }
                }
            }
        });

        it('un paso `puente` se apoya en una tabla clonada antes', () => {
            // Una tabla sin `id_negocio` (el puente producto↔ingrediente) no se puede filtrar por
            // negocio: sus filas se eligen por las que ya se clonaron.
            const yaClonadas = new Set();
            for (const paso of pasos) {
                if (paso.puente) {
                    expect(typeof paso.puente.columna).toBe('string');
                    expect(yaClonadas.has(paso.puente.mapa)).toBe(true);
                }
                yaClonadas.add(paso.tabla);
            }
        });

        it('ninguna columna está en dos sitios a la vez', () => {
            // `excluir`, `enlaces`, `autoEnlaces` y `fijos` hablan de la misma columna de formas
            // incompatibles. El ejecutor resolvería el conflicto en silencio según el orden en
            // que mira los conjuntos, y eso es justo lo que no se quiere depurar.
            for (const paso of pasos) {
                const grupos = {
                    excluir: paso.excluir ?? [],
                    enlaces: Object.keys(paso.enlaces ?? {}),
                    autoEnlaces: Object.keys(paso.autoEnlaces ?? {}),
                    fijos: Object.keys(paso.fijos ?? {}),
                };
                const vistas = new Map();
                for (const [grupo, columnas] of Object.entries(grupos)) {
                    for (const columna of columnas) {
                        const antes = vistas.get(columna);
                        if (antes) {
                            throw new Error(
                                `${paso.tabla}.${columna} aparece en \`${antes}\` y en \`${grupo}\``,
                            );
                        }
                        vistas.set(columna, grupo);
                    }
                }
            }
        });

        it('no se clona nada operativo', () => {
            // La sede hereda CONFIGURACIÓN. Los pedidos, los turnos de caja, los movimientos y
            // las citas son historia de la matriz, y copiarlos le daría a la sede ventas que
            // nunca hizo. La lista es de prefijos conocidos de tablas operativas.
            const operativas = /\.(pedid_|rest_caja|rest_movimiento|rest_compra|rest_cuenta|rest_pago|reserva_cita|reserva_estancia|reserva_caja|reserva_movimiento|reserva_pago|reserva_hold|reserva_venta|reserva_ficha|reserva_bloqueo)/;
            for (const paso of pasos) {
                expect(paso.tabla).not.toMatch(operativas);
            }
        });

        it('el stock nace en cero donde se clona un catálogo con existencias', () => {
            // El insumo del restaurante y el producto de reserva llevan `stock_actual`. La ficha
            // viaja; la bodega no: una sede que abre no tiene existencias, y heredarlas le daría
            // inventario que nunca entró por una compra.
            const conStock = pasos.filter((p) => /carta_ingrediente|reserva_producto$/.test(p.tabla));
            for (const paso of conStock) {
                expect(paso.fijos?.stock_actual).toBe(0);
            }
        });
    });

    it('los pasos comunes no dependen de ningún aplicativo', () => {
        // `COMUNES` corre primero, antes que cualquier paso del vertical: no puede referenciar
        // nada de ellos.
        for (const paso of COMUNES) {
            expect(paso.enlaces ?? {}).toEqual({});
            expect(paso.puente).toBeUndefined();
        }
    });

    it('el ajuste de permisos por negocio se clona y tolera lo que ya exista', () => {
        // Sin `gener_nivel_negocio` la sede nacería con los permisos de fábrica y el dueño
        // tendría que volver a quitar y poner vistas rol por rol. Y con `ON CONFLICT` porque la
        // tabla tiene una única por (negocio, rol, nivel).
        const permisos = COMUNES.find((p) => p.tabla === 'general.gener_nivel_negocio');
        expect(permisos).toBeDefined();
        expect(permisos.onConflict).toContain('DO NOTHING');
    });
});
