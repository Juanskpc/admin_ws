'use strict';
/**
 * Catálogos de arranque por perfil: categorías y servicios típicos de cada oficio.
 *
 * **No se crean solos.** Datos que el dueño no pidió son datos que tiene que borrar. El estado
 * vacío de Servicios ofrece «Cargar servicios típicos» y solo entonces se siembran, una vez, y
 * editables como cualquier otro servicio (ver `catalogoService.sembrar`).
 *
 * Los precios son de referencia en pesos colombianos: sirven para ver la app funcionando, no
 * para cobrar. Cada negocio los cambia.
 *
 * Forma: `[{ categoria, servicios: [{ nombre, duracion_min, precio, descripcion?, proceso?,
 * variantes?, a_cotizar?, requiere_consentimiento? }] }]`. `proceso` es `[desde_min, min]`.
 */

const TAMANOS = (base) => [
    { nombre: 'Pequeño', clave: 'PEQUENO', duracion_min: base[0][0], precio: base[0][1] },
    { nombre: 'Mediano', clave: 'MEDIANO', duracion_min: base[1][0], precio: base[1][1] },
    { nombre: 'Grande', clave: 'GRANDE', duracion_min: base[2][0], precio: base[2][1] },
    { nombre: 'Gigante', clave: 'GIGANTE', duracion_min: base[3][0], precio: base[3][1] },
];

const LARGOS = (base) => [
    { nombre: 'Corto', duracion_min: base[0][0], precio: base[0][1] },
    { nombre: 'Medio', duracion_min: base[1][0], precio: base[1][1] },
    { nombre: 'Largo', duracion_min: base[2][0], precio: base[2][1] },
];

const CATALOGOS = {
    BASE: [
        {
            categoria: 'Cortes',
            servicios: [
                { nombre: 'Corte', duracion_min: 30, precio: 28000 },
                { nombre: 'Corte niño', duracion_min: 30, precio: 22000 },
                { nombre: 'Corte + barba', duracion_min: 50, precio: 42000 },
            ],
        },
        {
            categoria: 'Barba y detalles',
            servicios: [
                { nombre: 'Barba', duracion_min: 20, precio: 18000 },
                { nombre: 'Cejas', duracion_min: 10, precio: 8000 },
            ],
        },
    ],

    SALON: [
        {
            categoria: 'Cabello',
            servicios: [
                { nombre: 'Corte dama', duracion_min: 45, precio: 35000, variantes: LARGOS([[45, 35000], [60, 45000], [75, 55000]]) },
                { nombre: 'Corte caballero', duracion_min: 30, precio: 25000 },
                { nombre: 'Cepillado', duracion_min: 45, precio: 30000, variantes: LARGOS([[30, 25000], [45, 30000], [60, 40000]]) },
                { nombre: 'Peinado para evento', duracion_min: 60, precio: 70000 },
            ],
        },
        {
            categoria: 'Color',
            servicios: [
                {
                    nombre: 'Tinte completo', duracion_min: 120, precio: 120000, proceso: [30, 45],
                    descripcion: 'Aplicación, 45 minutos de exposición y lavado.',
                    variantes: LARGOS([[105, 100000], [120, 120000], [150, 150000]]),
                },
                { nombre: 'Retoque de raíz', duracion_min: 90, precio: 80000, proceso: [30, 35] },
                { nombre: 'Mechas / Balayage', duracion_min: 180, precio: 250000, proceso: [60, 45] },
            ],
        },
        {
            categoria: 'Tratamientos',
            servicios: [
                { nombre: 'Keratina', duracion_min: 180, precio: 180000, proceso: [60, 40] },
                { nombre: 'Hidratación profunda', duracion_min: 45, precio: 45000 },
            ],
        },
        {
            categoria: 'Uñas',
            servicios: [
                { nombre: 'Manicure tradicional', duracion_min: 45, precio: 25000 },
                { nombre: 'Pedicure', duracion_min: 60, precio: 30000 },
                { nombre: 'Uñas semipermanentes', duracion_min: 75, precio: 45000 },
            ],
        },
        {
            categoria: 'Cejas y pestañas',
            servicios: [
                { nombre: 'Diseño de cejas', duracion_min: 30, precio: 20000 },
                { nombre: 'Lifting de pestañas', duracion_min: 60, precio: 70000 },
            ],
        },
    ],

    SPA: [
        {
            categoria: 'Masajes',
            servicios: [
                {
                    nombre: 'Masaje relajante', duracion_min: 60, precio: 120000,
                    variantes: [
                        { nombre: '60 minutos', duracion_min: 60, precio: 120000 },
                        { nombre: '90 minutos', duracion_min: 90, precio: 160000 },
                    ],
                },
                { nombre: 'Masaje descontracturante', duracion_min: 60, precio: 140000 },
                { nombre: 'Piedras calientes', duracion_min: 75, precio: 160000 },
            ],
        },
        {
            categoria: 'Faciales',
            servicios: [
                { nombre: 'Limpieza facial profunda', duracion_min: 75, precio: 110000 },
                { nombre: 'Facial hidratante', duracion_min: 60, precio: 95000 },
            ],
        },
        {
            categoria: 'Corporales',
            servicios: [
                { nombre: 'Exfoliación corporal', duracion_min: 45, precio: 90000 },
                { nombre: 'Envoltura corporal', duracion_min: 60, precio: 110000 },
            ],
        },
    ],

    ESTETICA: [
        {
            categoria: 'Valoración',
            servicios: [
                {
                    nombre: 'Valoración inicial', duracion_min: 20, precio: 0,
                    descripcion: 'Revisamos tu caso y te recomendamos el tratamiento.',
                },
            ],
        },
        {
            categoria: 'Faciales',
            servicios: [
                { nombre: 'Limpieza facial', duracion_min: 60, precio: 120000 },
                { nombre: 'Peeling químico', duracion_min: 45, precio: 180000, requiere_consentimiento: true },
                { nombre: 'Microdermoabrasión', duracion_min: 45, precio: 150000, requiere_consentimiento: true },
            ],
        },
        {
            categoria: 'Depilación láser',
            servicios: [
                {
                    nombre: 'Depilación láser', duracion_min: 30, precio: 80000, requiere_consentimiento: true,
                    variantes: [
                        { nombre: 'Axilas', duracion_min: 20, precio: 80000 },
                        { nombre: 'Bozo', duracion_min: 15, precio: 60000 },
                        { nombre: 'Media pierna', duracion_min: 40, precio: 180000 },
                        { nombre: 'Pierna completa', duracion_min: 60, precio: 300000 },
                    ],
                },
            ],
        },
        {
            categoria: 'Corporales',
            servicios: [
                { nombre: 'Radiofrecuencia', duracion_min: 45, precio: 130000, requiere_consentimiento: true },
                { nombre: 'Drenaje linfático', duracion_min: 60, precio: 110000 },
            ],
        },
    ],

    TATUAJE: [
        {
            categoria: 'Valoración',
            servicios: [
                {
                    nombre: 'Valoración y cotización', duracion_min: 30, precio: 0,
                    descripcion: 'Trae tu idea: definimos diseño, tamaño, precio y sesiones.',
                },
            ],
        },
        {
            categoria: 'Tatuajes',
            servicios: [
                { nombre: 'Tatuaje pequeño', duracion_min: 60, precio: 150000, requiere_consentimiento: true },
                {
                    nombre: 'Sesión de tatuaje', duracion_min: 180, precio: 450000, a_cotizar: true,
                    requiere_consentimiento: true,
                    descripcion: 'El precio y la duración se acuerdan en la valoración.',
                },
                { nombre: 'Retoque', duracion_min: 60, precio: 80000 },
            ],
        },
        {
            categoria: 'Perforaciones',
            servicios: [
                { nombre: 'Perforación lóbulo', duracion_min: 20, precio: 40000, requiere_consentimiento: true },
                { nombre: 'Perforación cartílago', duracion_min: 30, precio: 60000, requiere_consentimiento: true },
            ],
        },
    ],

    MASCOTAS: [
        {
            categoria: 'Baño',
            servicios: [
                { nombre: 'Baño', duracion_min: 60, precio: 45000, variantes: TAMANOS([[45, 35000], [60, 45000], [75, 60000], [90, 80000]]) },
                { nombre: 'Baño y corte', duracion_min: 75, precio: 65000, variantes: TAMANOS([[60, 50000], [75, 65000], [90, 80000], [120, 100000]]) },
                { nombre: 'Deslanado', duracion_min: 90, precio: 70000, variantes: TAMANOS([[60, 50000], [90, 70000], [105, 90000], [120, 110000]]) },
            ],
        },
        {
            categoria: 'Cuidados',
            servicios: [
                { nombre: 'Corte de uñas', duracion_min: 15, precio: 15000 },
                { nombre: 'Limpieza de oídos', duracion_min: 15, precio: 15000 },
            ],
        },
    ],
};

/** Unidades de ejemplo para alojamiento: tipos con una unidad cada uno. */
const UNIDADES_ALOJAMIENTO = [
    { nombre: 'Habitación doble', ocupacion_base: 2, capacidad_max: 3, tarifa_base: 180000, tarifa_fin_semana: 220000, tarifa_persona_extra: 40000, unidades: ['Habitación 101', 'Habitación 102'] },
    { nombre: 'Habitación familiar', ocupacion_base: 4, capacidad_max: 5, tarifa_base: 280000, tarifa_fin_semana: 330000, tarifa_persona_extra: 40000, unidades: ['Habitación 201'] },
    { nombre: 'Suite', ocupacion_base: 2, capacidad_max: 2, tarifa_base: 320000, tarifa_fin_semana: 380000, tarifa_persona_extra: 0, unidades: ['Suite 301'] },
];

function catalogoDe(perfil) {
    if (perfil.sin_catalogo) return [];
    return CATALOGOS[perfil.clave] || [];
}

// Solo el hospedaje vende noches: el cuidado de mascotas se agenda por citas y no tiene cupos
// que sembrar. Un hotel canino se da de alta como hospedaje.
function unidadesDe(perfil) {
    return perfil.clave === 'ALOJAMIENTO' ? UNIDADES_ALOJAMIENTO : [];
}

module.exports = { CATALOGOS, catalogoDe, unidadesDe };
