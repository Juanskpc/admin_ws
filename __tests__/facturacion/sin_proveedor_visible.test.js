/**
 * Nada del proveedor tecnológico se le muestra al comprador ni al negocio (decisión del 2026-10-09).
 *
 * Factus devuelve `url_publica` en su propio dominio. El correo y la pestaña Facturas de Caja la
 * usaban para «Ver la factura en línea», así que el cliente terminaba en una página de Factus.
 * Ahora el enlace es la consulta de la DIAN por CUFE. Esta suite falla si el dominio del proveedor
 * vuelve a salir.
 */
'use strict';

const { urlConsultaDian } = require('../../app_core/facturacion/constantes');
const { correoFactura } = require('../../app_core/facturacion/correoFactura');

const CUFE = '9dfdcd6e3549e591eb8b4749dce4b9a0a19420fcb0fa8753eeefe7ef2c08e845';

function documento(ambiente) {
    return {
        tipo: 'FV',
        ambiente,
        numero: 'SETP990024209',
        cufe: CUFE,
        url_publica: 'https://app-sandbox.factus.com.co/documents/bills/abc',
        total: 37000,
        total_impuestos: 0,
        origen_referencia: 'ORD-0054',
        emisor: { numero_documento: '900123456', dv: '7' },
        adquiriente: { consumidor_final: true },
        pagos: [{ codigo_dian: '10' }],
        validado_en: new Date('2026-10-09T05:24:01Z'),
    };
}

const LINEAS = [{ descripcion: 'Patacón con hogao', cantidad: 1, precio_bruto: 12000, total: 12000 }];

describe('urlConsultaDian', () => {
    it('en producción apunta al catálogo de la DIAN', () => {
        expect(urlConsultaDian(CUFE, 'PRODUCCION')).toBe(
            `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${CUFE}`,
        );
    });

    it('en pruebas apunta al catálogo de habilitación', () => {
        expect(urlConsultaDian(CUFE, 'PRUEBAS')).toContain('catalogo-vpfe-hab.dian.gov.co');
    });

    it('sin CUFE no hay enlace', () => {
        expect(urlConsultaDian(null, 'PRODUCCION')).toBeNull();
    });
});

describe('el correo de la factura', () => {
    it.each(['PRUEBAS', 'PRODUCCION'])('no lleva al dominio del proveedor (%s)', (ambiente) => {
        const { html, texto } = correoFactura({
            documento: documento(ambiente),
            lineas: LINEAS,
            marca: { nombre: 'Restaurante Chayane', primario: '#312E81', logoUrl: null },
        });
        expect(html).not.toMatch(/factus/i);
        expect(texto).not.toMatch(/factus/i);
        expect(html).toContain(urlConsultaDian(CUFE, ambiente));
    });
});
