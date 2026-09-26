/**
 * Los oficios que ofrecemos, agrupados por el módulo que los atiende. **No es una migración**:
 * es el dato que consume `migrate_rubros_negocio.js`, y vive aparte para poder leerlo sin
 * ejecutar nada (lo usan también las pruebas del registro de perfiles).
 *
 * - `icono` es un nombre de icono de lucide y lo consumen tanto la consola como la landing; si se
 *   añade uno nuevo hay que importarlo también en `landing.component.ts`, que registra los iconos
 *   de uno en uno y no falla al compilar, solo deja el hueco vacío.
 * - `perfil` es el perfil de reserva que adapta la app al oficio (`app_reserva_api/perfiles`).
 *   `null` = perfil BASE, que es la barbería tal como funcionaba antes de los perfiles.
 *   Solo tiene sentido en los rubros del módulo RESERVA.
 *
 * Se resuelve **por nombre, nunca por id**: los ids de tipo no coinciden entre desarrollo y
 * producción.
 */
const RUBROS = [
    // ── Los atiende el módulo de RESTAURANTE ──
    { modulo: 'RESTAURANTE', nombre: 'RESTAURANTE',            etiqueta: 'Restaurante',            icono: 'utensils-crossed', orden: 10,  perfil: null },
    { modulo: 'RESTAURANTE', nombre: 'CAFETERIA',              etiqueta: 'Cafetería',              icono: 'coffee',           orden: 20,  perfil: null },
    { modulo: 'RESTAURANTE', nombre: 'PANADERIA Y REPOSTERIA', etiqueta: 'Panadería / Repostería', icono: 'croissant',        orden: 30,  perfil: null },
    { modulo: 'RESTAURANTE', nombre: 'HELADERIA',              etiqueta: 'Heladería',              icono: 'ice-cream-cone',   orden: 40,  perfil: null },
    { modulo: 'RESTAURANTE', nombre: 'BAR',                    etiqueta: 'Bar',                    icono: 'beer',             orden: 50,  perfil: null },
    { modulo: 'RESTAURANTE', nombre: 'COMIDAS RAPIDAS',        etiqueta: 'Comidas rápidas',        icono: 'sandwich',         orden: 60,  perfil: null },
    { modulo: 'RESTAURANTE', nombre: 'PIZZERIA',               etiqueta: 'Pizzería',               icono: 'pizza',            orden: 70,  perfil: null },

    // ── Los atiende el módulo de RESERVA: citas ──
    { modulo: 'RESERVA',     nombre: 'BARBERIA',               etiqueta: 'Barbería',               icono: 'scissors',         orden: 110, perfil: null },
    { modulo: 'RESERVA',     nombre: 'SALON DE BELLEZA',       etiqueta: 'Salón de belleza',       icono: 'sparkles',         orden: 120, perfil: 'SALON' },
    // La clave conserva el nombre con el que se sembró («SPA Y ESTETICA») porque ya hay negocios
    // apuntándolo; lo que cambia es la etiqueta. La estética tiene ahora su propio rubro.
    { modulo: 'RESERVA',     nombre: 'SPA Y ESTETICA',         etiqueta: 'Spa',                    icono: 'flower-2',         orden: 130, perfil: 'SPA' },
    { modulo: 'RESERVA',     nombre: 'CENTRO DE ESTETICA',     etiqueta: 'Centro de estética',     icono: 'syringe',          orden: 140, perfil: 'ESTETICA' },
    { modulo: 'RESERVA',     nombre: 'TATUAJES Y PERFORACIONES', etiqueta: 'Tatuajes y perforaciones', icono: 'pen-tool',     orden: 150, perfil: 'TATUAJE' },
    // Misma historia que el spa: la clave sigue siendo «PELUQUERIA CANINA» por los negocios que
    // ya la apuntan, pero el oficio que se ofrece es el cuidado de mascotas entero.
    { modulo: 'RESERVA',     nombre: 'PELUQUERIA CANINA',      etiqueta: 'Cuidado de mascotas',    icono: 'paw-print',        orden: 160, perfil: 'MASCOTAS' },
    { modulo: 'RESERVA',     nombre: 'CONSULTORIO',            etiqueta: 'Consultorio',            icono: 'stethoscope',      orden: 170, perfil: null },

    // ── Los atiende el módulo de RESERVA: estancias por noches ──
    // Un solo oficio para hotel, hostal, cabañas y apartamentos: para la app son lo mismo
    // (unidades que se venden por noches) y cuatro chips casi iguales no ayudaban a elegir.
    { modulo: 'RESERVA',     nombre: 'HOTEL',                  etiqueta: 'Hospedaje',              icono: 'hotel',            orden: 180, perfil: 'ALOJAMIENTO' },
];

/**
 * Oficios que se dejaron de ofrecer (2026-09-20), con el que ocupa su lugar.
 *
 * La migración los deja **inactivos y sin módulo**, y mueve al sucesor los negocios que los
 * apuntaban: un negocio nunca se queda señalando un rubro retirado, que es lo que dejaría su
 * perfil —y con él su menú— colgando de una fila que ya no se muestra en ninguna parte.
 *
 * Retirar es quitar de `RUBROS` y apuntarlo aquí. Nunca borrar la fila: `id_rubro` la referencia.
 */
const RETIRADOS = [
    { nombre: 'PELUQUERIA',              sucesor: 'SALON DE BELLEZA' },
    { nombre: 'MANICURE Y PEDICURE',     sucesor: 'SALON DE BELLEZA' },
    { nombre: 'MASAJES',                 sucesor: 'SPA Y ESTETICA' },
    { nombre: 'GUARDERIA DE MASCOTAS',   sucesor: 'PELUQUERIA CANINA' },
    { nombre: 'HOSTAL',                  sucesor: 'HOTEL' },
    { nombre: 'CABANAS Y GLAMPING',      sucesor: 'HOTEL' },
    { nombre: 'APARTAMENTOS TURISTICOS', sucesor: 'HOTEL' },
];

/** Los módulos que existen de verdad. El resto de tipos se queda sin `id_tipo_modulo`. */
const MODULOS = ['RESTAURANTE', 'RESERVA'];

module.exports = { RUBROS, RETIRADOS, MODULOS };
