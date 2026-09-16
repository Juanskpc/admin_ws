/**
 * Factura de prueba contra el SANDBOX de Factus (antes de FE-2)
 *
 * ## Por qué existe
 *
 * Antes de diseñar `fe_configuracion` y `fe_documento` hay que ver con los propios ojos cómo
 * contesta Factus. La última vez que se dedujo en vez de probar (§8.2-ter de
 * `docs/facturacion-electronica.md`) se construyó media sección sobre una conclusión falsa.
 * Este script emite UNA factura real en el ambiente de pruebas y deja en disco la respuesta
 * completa, el PDF y el XML, para diseñar sobre datos y no sobre la documentación.
 *
 * Qué comprueba, en el orden en que puede fallar:
 *   1. Que las credenciales sirven (OAuth2, grant `password`).
 *   2. Qué empresa y qué rango de numeración trae el sandbox.
 *   3. Una factura de RESTAURANTE a consumidor final, con la propina como RECARGO (código 03),
 *      que no es base gravable. El impuesto es un ESCENARIO, no una regla:
 *        · por defecto, SIN impuesto — como facturan hoy los clientes de EscalApp (el POS manda
 *          `porcentaje_impuesto` 0). Si un negocio cobra o no el impoconsumo lo decide su régimen
 *          y lo dice su contador, nunca el código (`responsable_inc` en `gener_negocio_fiscal`).
 *        · `--impuesto inc`, el caso del restaurante responsable del impuesto al consumo
 *          (INC, código 04, 8%), para ver cómo lo trata Factus el día que llegue uno.
 *   4. Qué distingue una notificación de la DIAN de un rechazo.
 *   5. Que el PDF y el XML se pueden descargar, porque tenemos que guardar copia propia
 *      (los T&C de Factus §f.7 no conservan nada si la cuenta se elimina).
 *
 * ## Uso
 *
 *   node scripts/factus_factura_prueba.js --ver           # solo arma y muestra la factura; no llama a Factus
 *   node scripts/factus_factura_prueba.js                 # emite la factura en el sandbox, sin impuesto
 *   node scripts/factus_factura_prueba.js --impuesto inc  # igual, con impuesto al consumo del 8%
 *   node scripts/factus_factura_prueba.js --impuesto inc --redondeo   # con precios de carta QUE YA INCLUYEN el INC
 *   node scripts/factus_factura_prueba.js --eliminar <reference_code>   # borra una factura NO validada
 *
 * Variables en `.env` (las credenciales del sandbox que mandó Factus):
 *   FACTUS_CLIENT_ID, FACTUS_CLIENT_SECRET, FACTUS_USERNAME, FACTUS_PASSWORD
 *   FACTUS_URL (opcional; por defecto el sandbox)
 *
 * La salida queda en `tmp/factus/`, que está en `.gitignore`.
 *
 * ## Solo sandbox, a propósito
 *
 * Una factura enviada a producción quema un consecutivo que no se recupera y es un documento
 * fiscal ante la DIAN. Este script se niega a correr si `FACTUS_URL` no es el sandbox.
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const URL_SANDBOX = 'https://api-sandbox.factus.com.co';
const BASE = (process.env.FACTUS_URL || URL_SANDBOX).replace(/\/+$/, '');
const SALIDA = path.join(__dirname, '..', 'tmp', 'factus');

const args = process.argv.slice(2);
const soloVer = args.includes('--ver');
const conRedondeo = args.includes('--redondeo');
const idxImpuesto = args.indexOf('--impuesto');
const impuestoPedido = idxImpuesto === -1 ? 'ninguno' : args[idxImpuesto + 1];
const cobraInc = impuestoPedido === 'inc';
const idxEliminar = args.indexOf('--eliminar');

// ─── La factura ────────────────────────────────────────────────────────────────────────────

const INC = { code: '04', rate: '8.00' }; // Impuesto Nacional al Consumo, restaurantes
// Factus v2 no documenta cómo marcar la línea de un vendedor NO responsable; su único ejemplo sin
// impuesto es `is_excluded`. «Excluido» es otra figura legal, así que esto también se está probando.
const SIN_IMPUESTO = { is_excluded: true };
const PROPINA = 0.1; // voluntaria, sobre la base sin impuestos

/**
 * En la v2 de Factus `price` es NETO, sin impuestos. En la carta de un restaurante el precio
 * que ve el cliente ya lleva el INC dentro, así que hay que sacarlo. `--redondeo` prueba justo
 * eso con precios que no dan exacto, para ver si nuestro total y el de Factus coinciden.
 */
function lineas() {
    if (!conRedondeo) {
        return [
            { code_reference: 'PRUEBA-HAMB', name: 'Hamburguesa sencilla', quantity: 2, neto: 20000 },
            { code_reference: 'PRUEBA-LIMO', name: 'Limonada natural', quantity: 1, neto: 6000 },
        ];
    }
    const conInc = [
        { code_reference: 'PRUEBA-HAMB', name: 'Hamburguesa sencilla', quantity: 2, carta: 22000 },
        { code_reference: 'PRUEBA-LIMO', name: 'Limonada natural', quantity: 1, carta: 6500 },
    ];
    return conInc.map((l) => ({ ...l, neto: dos(l.carta / (1 + Number(INC.rate) / 100)) }));
}

const dos = (n) => Math.round(n * 100) / 100;
const txt = (n) => dos(n).toFixed(2);

function armarFactura() {
    const items = lineas();
    const base = dos(items.reduce((s, l) => s + l.quantity * l.neto, 0));
    const impuesto = cobraInc
        ? dos(items.reduce((s, l) => s + dos((l.quantity * l.neto * Number(INC.rate)) / 100), 0))
        : 0;
    const propina = dos(base * PROPINA);
    const total = dos(base + impuesto + propina);

    const factura = {
        reference_code: `ESCALAPP-PRUEBA-${Date.now()}`,
        document: '01', // factura electrónica de venta
        operation_type: '10', // estándar
        send_email: false, // consumidor final: no hay a quién
        observation: 'Factura de prueba EscalApp (sandbox)',
        payment_details: [
            // La suma de los pagos debe ser el total de la factura, propina incluida.
            { payment_form: '1', payment_method_code: '10', amount: txt(total) },
        ],
        customer: {
            identification_document_code: '13', // cédula
            identification: '222222222222', // consumidor final
            names: 'Consumidor Final',
            legal_organization_code: '2', // persona natural
        },
        items: items.map((l) => ({
            code_reference: l.code_reference,
            name: l.name,
            quantity: txt(l.quantity),
            discount_rate: '0.00',
            price: txt(l.neto),
            unit_measure_code: '94', // unidad
            standard_code: '999', // código propio del contribuyente
            taxes: [cobraInc ? INC : SIN_IMPUESTO],
        })),
        allowance_charges: [
            {
                concept_type: '03', // recargo condicionado — así documenta Factus la propina
                is_surcharge: true,
                reason: 'Propina voluntaria',
                base_amount: txt(base),
                amount: txt(propina),
            },
        ],
    };
    return { factura, cuentas: { base, impuesto, propina, total } };
}

// ─── Llamadas a Factus ─────────────────────────────────────────────────────────────────────

async function pedirToken() {
    const faltan = ['FACTUS_CLIENT_ID', 'FACTUS_CLIENT_SECRET', 'FACTUS_USERNAME', 'FACTUS_PASSWORD']
        .filter((k) => !process.env[k]);
    if (faltan.length) {
        throw new Error(`Faltan en .env: ${faltan.join(', ')}. Son las credenciales del sandbox que mandó Factus.`);
    }
    const r = await fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password',
            client_id: process.env.FACTUS_CLIENT_ID,
            client_secret: process.env.FACTUS_CLIENT_SECRET,
            username: process.env.FACTUS_USERNAME,
            password: process.env.FACTUS_PASSWORD,
        }),
    });
    const cuerpo = await leer(r);
    if (!r.ok || !cuerpo.access_token) {
        // El cuerpo de un error de OAuth no trae secretos, pero no lo imprimimos entero por si acaso.
        throw new Error(`Factus rechazó las credenciales (HTTP ${r.status}): ${cuerpo.message || cuerpo.error || 'sin detalle'}`);
    }
    console.log(`✓ Token obtenido (caduca en ${cuerpo.expires_in} s)`);
    return cuerpo.access_token;
}

async function api(token, metodo, ruta, json) {
    const r = await fetch(`${BASE}${ruta}`, {
        method: metodo,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: json ? JSON.stringify(json) : undefined,
    });
    const restantes = r.headers.get('x-ratelimit-remaining');
    return { status: r.status, cuerpo: await leer(r), restantes };
}

async function leer(r) {
    const t = await r.text();
    try {
        return JSON.parse(t);
    } catch {
        return { crudo: t.slice(0, 500) };
    }
}

/** Factus mezcla avisos y rechazos en `errors`; solo es rechazo si el texto dice «Rechazo». */
function clasificarErrores(errors) {
    const entradas = Object.entries(errors || {});
    const rechazos = entradas.filter(([, v]) => /rechazo/i.test(String(v)));
    const avisos = entradas.filter(([, v]) => !/rechazo/i.test(String(v)));
    return { rechazos, avisos };
}

function guardar(nombre, contenido) {
    fs.mkdirSync(SALIDA, { recursive: true });
    const destino = path.join(SALIDA, nombre);
    fs.writeFileSync(destino, contenido);
    return path.relative(process.cwd(), destino);
}

// ─── Flujo ─────────────────────────────────────────────────────────────────────────────────

async function main() {
    if (!BASE.startsWith(URL_SANDBOX)) {
        throw new Error(`FACTUS_URL apunta a ${BASE}. Este script solo corre contra el sandbox (${URL_SANDBOX}).`);
    }

    if (!['ninguno', 'inc'].includes(impuestoPedido)) {
        throw new Error('Uso: --impuesto ninguno | inc');
    }
    if (conRedondeo && !cobraInc) {
        throw new Error('--redondeo prueba quitarle el INC al precio de carta: úsalo con --impuesto inc.');
    }

    const { factura, cuentas } = armarFactura();

    if (soloVer) {
        console.log('Factura que se enviaría (no se llama a Factus):\n');
        console.log(JSON.stringify(factura, null, 2));
        console.log('\nNuestras cuentas:', cuentas);
        return;
    }

    const token = await pedirToken();

    if (idxEliminar !== -1) {
        const ref = args[idxEliminar + 1];
        if (!ref) throw new Error('Uso: --eliminar <reference_code>');
        const r = await api(token, 'DELETE', `/v2/bills/destroy/reference/${encodeURIComponent(ref)}`);
        console.log(`HTTP ${r.status}`, r.cuerpo.message || r.cuerpo);
        return;
    }

    const empresa = await api(token, 'GET', '/v2/companies');
    const e = empresa.cuerpo.data || {};
    console.log(`✓ Empresa del usuario: ${e.company || e.names || e.trade_name || '?'} · NIT ${e.nit || '?'}-${e.dv ?? '?'}`);
    guardar('empresa.json', JSON.stringify(empresa.cuerpo, null, 2));

    const rangos = await api(token, 'GET', '/v2/numbering-ranges?filter[document]=21&filter[is_active]=1');
    const lista = Array.isArray(rangos.cuerpo.data) ? rangos.cuerpo.data : rangos.cuerpo.data?.data || [];
    guardar('rangos.json', JSON.stringify(rangos.cuerpo, null, 2));
    const vigentes = lista.filter((x) => !Number(x.is_expired));
    console.log(`✓ Rangos de factura activos: ${lista.length} (vigentes: ${vigentes.length})`);
    for (const x of lista) {
        console.log(`    id ${x.id} · ${x.prefix} ${x.from}–${x.to} · siguiente ${x.current} · vence ${x.end_date}${Number(x.is_expired) ? ' · VENCIDO' : ''}`);
    }
    if (vigentes.length > 1) factura.numbering_range_id = vigentes[0].id;

    console.log(`\nEmitiendo ${factura.reference_code} — base ${cuentas.base} + impuesto ${cuentas.impuesto} + propina ${cuentas.propina} = ${cuentas.total}`);
    const emision = await api(token, 'POST', '/v2/bills/validate', factura);
    guardar(`${factura.reference_code}.json`, JSON.stringify({ enviado: factura, respuesta: emision.cuerpo }, null, 2));

    const d = emision.cuerpo.data || {};
    const bill = d; // la v2 devuelve la factura directamente en `data` (verificado el 2026-09-14)
    console.log(`HTTP ${emision.status} · ${emision.cuerpo.message || ''}`);
    if (emision.restantes) console.log(`  Peticiones restantes este minuto: ${emision.restantes}`);

    if (emision.status >= 400) {
        console.log('\n✗ Factus no aceptó la factura. Detalle:');
        console.log(JSON.stringify(emision.cuerpo.data?.errors || emision.cuerpo.errors || emision.cuerpo, null, 2));
        if (emision.status === 409) {
            console.log(`\nHay una factura pendiente. Si no está validada, bórrala con:\n  node scripts/factus_factura_prueba.js --eliminar <reference_code>`);
        }
        return;
    }

    const { rechazos, avisos } = clasificarErrores(bill.errors);
    console.log(`  Número:      ${bill.number}`);
    console.log(`  CUFE:        ${bill.cufe}`);
    console.log(`  Validada:    ${bill.is_validated} ${bill.validated_at ? `(${bill.validated_at})` : ''}`);
    const totalFactus = bill.totals?.total;
    const cuadra = totalFactus === txt(cuentas.total);
    console.log(`  Total Factus: ${totalFactus}  ·  nuestro: ${txt(cuentas.total)}  ${cuadra ? '✓ cuadra' : '✗ NO CUADRA'}`);
    if (bill.links?.public_url) console.log(`  Ver en línea: ${bill.links.public_url}`);
    for (const [k, v] of avisos) console.log(`  aviso  ${k}: ${v}`);
    for (const [k, v] of rechazos) console.log(`  RECHAZO ${k}: ${v}`);

    if (rechazos.length) {
        console.log(`\n✗ Rechazada. Bloquea las siguientes hasta borrarla:\n  node scripts/factus_factura_prueba.js --eliminar ${factura.reference_code}`);
        return;
    }
    if (!bill.is_validated) {
        console.log('\n… Sin validar y sin rechazo: la DIAN va lenta. Se reintenta con los MISMOS datos, no se borra.');
        return;
    }

    for (const [tipo, ruta, campo, ext] of [
        ['PDF', `/v2/bills/${bill.number}/download-pdf`, 'pdf_base_64_encoded', 'pdf'],
        ['XML', `/v2/bills/${bill.number}/download-xml`, 'xml_base_64_encoded', 'xml'],
    ]) {
        const r = await api(token, 'GET', ruta);
        const b64 = r.cuerpo.data?.[campo];
        if (!b64) {
            console.log(`  ✗ ${tipo}: HTTP ${r.status}, sin ${campo}`);
            continue;
        }
        console.log(`  ✓ ${tipo} guardado en ${guardar(`${bill.number}.${ext}`, Buffer.from(b64, 'base64'))}`);
    }
    console.log(`\nRespuesta completa en ${path.relative(process.cwd(), SALIDA)}/`);
}

main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
});
