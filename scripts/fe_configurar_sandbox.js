/**
 * Deja un negocio de DESARROLLO listo para facturar contra el sandbox de Factus (tarea R4.5 de
 * `docs/plan-fe-restaurante.md`).
 *
 *   node scripts/fe_configurar_sandbox.js <id_negocio>            # solo muestra lo que haría
 *   node scripts/fe_configurar_sandbox.js <id_negocio> --aplicar
 *
 * Qué hace con `--aplicar`:
 *   1. Rellena la ficha fiscal del negocio con los datos de la empresa del sandbox (y valores de
 *      prueba evidentes en lo demás), y la declara REGISTRADO en modo POS.
 *   2. Guarda las credenciales `FACTUS_*` del `.env`, cifradas, en `fe_configuracion` (PRUEBAS).
 *   3. Copia los rangos de Factus, pone en uso el primero vigente de factura y el primero de nota
 *      crédito, y deja la configuración en EN_PRUEBAS.
 *
 * Se niega a correr si la base no es de desarrollo o si `FACTUS_URL` no es el sandbox. Ojo: a
 * través del túnel la base compartida también es `localhost`; mira `DB_PORT` antes de aplicar.
 *
 * Para que el negocio facture falta además la feature, que en desarrollo se fuerza:
 *   FEATURES_FORZADAS=facturacion_electronica
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');
const datosFiscales = require('../app_core/facturacion/datosFiscales');
const configuracionDao = require('../app_core/facturacion/configuracionDao');
const { getProveedor } = require('../app_core/facturacion/proveedores');

const sequelize = Models.sequelize;
const URL_SANDBOX = 'https://api-sandbox.factus.com.co';
const idNegocio = Number(process.argv[2]);
const aplicar = process.argv.includes('--aplicar');

if (!Number.isInteger(idNegocio) || idNegocio < 1) {
    console.error('Uso: node scripts/fe_configurar_sandbox.js <id_negocio> [--aplicar]');
    process.exit(1);
}

async function main() {
    if (process.env.NODE_ENV === 'production' || !String(process.env.DB_NAME || '').includes('dev')) {
        throw new Error(`La base "${process.env.DB_NAME}" no es de desarrollo. Este script no corre ahí.`);
    }
    const url = (process.env.FACTUS_URL || URL_SANDBOX).replace(/\/+$/, '');
    if (!url.startsWith(URL_SANDBOX)) throw new Error(`FACTUS_URL apunta a ${url}: solo se configura el sandbox.`);

    const credenciales = {
        client_id: process.env.FACTUS_CLIENT_ID,
        client_secret: process.env.FACTUS_CLIENT_SECRET,
        username: process.env.FACTUS_USERNAME,
        password: process.env.FACTUS_PASSWORD,
    };
    const faltan = Object.entries(credenciales).filter(([, v]) => !v).map(([k]) => `FACTUS_${k.toUpperCase()}`);
    if (faltan.length) throw new Error(`Faltan en .env: ${faltan.join(', ')}.`);

    const [negocio] = await sequelize.query(
        `SELECT n.id_negocio, n.nombre, tn.nombre AS tipo
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
          WHERE n.id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT }
    );
    if (!negocio) throw new Error(`No existe el negocio ${idNegocio}.`);

    console.log(`\nBase: ${process.env.DB_NAME} en ${process.env.DB_HOST}:${process.env.DB_PORT}`);
    console.log(`Negocio ${negocio.id_negocio}: "${negocio.nombre}" (${negocio.tipo ?? '?'})`);

    const factus = getProveedor('FACTUS');
    const base = { credenciales, ambiente: 'PRUEBAS' };
    const empresa = await factus.probarConexion(base);
    console.log(`Empresa del sandbox: ${empresa.razon_social} · NIT ${empresa.nit}-${empresa.dv}`);

    const rangos = await factus.listarRangos(base);
    const elegidos = ['FV', 'NC'].map((tipo) => rangos.find((r) => r.tipoDocumento === tipo && !r.vencido));
    for (const r of rangos.filter((x) => x.tipoDocumento)) {
        const marca = elegidos.includes(r) ? '→' : ' ';
        console.log(`  ${marca} ${r.tipoDocumento} id ${r.id} · ${r.prefijo} · siguiente ${r.actual}${r.vencido ? ' · VENCIDO' : ''}`);
    }
    if (!elegidos[0]) throw new Error('El sandbox no tiene ningún rango de factura vigente.');

    if (!aplicar) {
        console.log('\nNo se cambió nada. Para aplicarlo, repite el comando con --aplicar.');
        return;
    }

    await datosFiscales.asegurarFicha(idNegocio);
    // Primero la declaración: sin REGISTRADO la base no deja salir de modo NINGUNO.
    await datosFiscales.declarar(idNegocio, { estado_registro: 'REGISTRADO', obligado_a_facturar: true, modo_facturacion: 'POS' });
    await datosFiscales.actualizar(idNegocio, {
        tipo_persona: '1',
        tipo_documento: '31',
        numero_documento: String(empresa.nit),
        dv: String(empresa.dv),
        razon_social: empresa.razon_social || 'EMPRESA DE PRUEBA',
        responsabilidades_fiscales: ['R-99-PN'],
        tributos: ['ZZ'],
        direccion_fiscal: 'Calle de prueba 1',
        municipio_dane: '05001',
        departamento_dane: '05',
        correo_facturacion: 'pruebas@escalapp.cloud',
    });

    await configuracionDao.guardar(idNegocio, { credenciales, ambiente: 'PRUEBAS' });
    const guardados = await configuracionDao.guardarRangos(idNegocio, rangos);
    for (const r of elegidos.filter(Boolean)) {
        const fila = guardados.find((g) => Number(g.id_rango_proveedor) === r.id);
        await configuracionDao.usarRango(idNegocio, fila.id_resolucion);
    }
    const config = await configuracionDao.cambiarEstado(idNegocio, 'EN_PRUEBAS');

    console.log(`\n✓ Configuración en ${config.estado} (${config.ambiente}), ${guardados.length} rangos copiados.`);
    const decision = await configuracionDao.debeFacturar(idNegocio);
    console.log(
        decision.facturar
            ? '✓ El negocio ya factura en este proceso.'
            : `… Falta un interruptor: ${decision.motivo}.` +
                  (decision.motivo === 'SIN_FEATURE'
                      ? ' Arranca el backend con FEATURES_FORZADAS=facturacion_electronica.'
                      : '')
    );
}

main()
    .catch((err) => {
        console.error(`\n✗ ${err.message}`);
        process.exitCode = 1;
    })
    .finally(() => sequelize.close());
