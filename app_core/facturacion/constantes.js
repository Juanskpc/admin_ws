'use strict';
/** Valor de la UVT por año (resolución DIAN de cada año). Añadir el año nuevo cada diciembre. */
const UVT_POR_ANIO = { 2026: 52374 };
/** Por encima de 5 UVT hay que identificar al comprador (D10). */
const TOPE_UVT_CONSUMIDOR_FINAL = 5;

function topeConsumidorFinal(fecha = new Date()) {
    const anio = Number(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric' }).format(fecha)
    );
    const uvt = UVT_POR_ANIO[anio];
    if (!uvt) {
        const ultimo = Math.max(...Object.keys(UVT_POR_ANIO).map(Number));
        console.warn(`[facturacion] Falta la UVT de ${anio}; se usa la de ${ultimo}.`);
        return UVT_POR_ANIO[ultimo] * TOPE_UVT_CONSUMIDOR_FINAL;
    }
    return uvt * TOPE_UVT_CONSUMIDOR_FINAL;
}

/**
 * Medios de pago DIAN que ofrecemos en la pantalla de métodos de pago (R7.2).
 * Los cinco validaron en el sandbox de Factus (sondeo del 2026-10-08).
 */
const MEDIOS_PAGO_DIAN = [
    { codigo: '10', nombre: 'Efectivo' },
    { codigo: '47', nombre: 'Transferencia' },
    { codigo: '48', nombre: 'Tarjeta crédito' },
    { codigo: '49', nombre: 'Tarjeta débito' },
    { codigo: 'ZZZ', nombre: 'Otro' },
];
const MEDIO_PAGO_POR_DEFECTO = 'ZZZ';

/** Unidad de medida por defecto de un plato: '94' = unidad (probado en sandbox). */
const UNIDAD_POR_DEFECTO = '94';

const CONSUMIDOR_FINAL = Object.freeze({
    consumidor_final: true,
    tipo_persona: '2',
    tipo_documento: '13',
    numero_documento: '222222222222',
    nombres: 'Consumidor Final',
});

module.exports = {
    UVT_POR_ANIO,
    TOPE_UVT_CONSUMIDOR_FINAL,
    topeConsumidorFinal,
    MEDIOS_PAGO_DIAN,
    MEDIO_PAGO_POR_DEFECTO,
    UNIDAD_POR_DEFECTO,
    CONSUMIDOR_FINAL,
};
