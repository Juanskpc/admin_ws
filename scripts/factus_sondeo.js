/**
 * Sondeo del SANDBOX de Factus (tarea R0.1 de `docs/plan-fe-restaurante.md`).
 *
 * `factus_factura_prueba.js` ya probó lo básico (token, empresa, rangos, factura a consumidor
 * final, PDF y XML). Este responde lo que faltaba saber antes de escribir el adaptador, una
 * pregunta por subcomando, y deja cada respuesta completa en `tmp/factus/sondeo/`:
 *
 *   node scripts/factus_sondeo.js token                    # P7: cuánto dura el token
 *   node scripts/factus_sondeo.js referencia-repetida      # P1: mismo reference_code dos veces
 *   node scripts/factus_sondeo.js buscar-referencia <ref>  # P2: consultar por referencia
 *   node scripts/factus_sondeo.js medios-pago              # P3: ZZZ, 47, 48, 49
 *   node scripts/factus_sondeo.js comprador-cedula         # P4
 *   node scripts/factus_sondeo.js comprador-nit            # P4
 *   node scripts/factus_sondeo.js descuento-linea          # P5: discount_rate
 *   node scripts/factus_sondeo.js nota-credito <numero>    # P6: anulación total
 *
 * No toca la base de datos y, como el otro, se niega a correr si `FACTUS_URL` no es el sandbox.
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { calcularDv } = require('../app_core/helpers/nit');

const URL_SANDBOX = 'https://api-sandbox.factus.com.co';
const BASE = (process.env.FACTUS_URL || URL_SANDBOX).replace(/\/+$/, '');
const SALIDA = path.join(__dirname, '..', 'tmp', 'factus', 'sondeo');
const CORREO = process.env.FACTUS_SONDEO_CORREO || 'pruebas@escalapp.cloud';

const dos = (n) => Math.round(n * 100) / 100;
const txt = (n) => dos(n).toFixed(2);

// ─── Llamadas a Factus (copiadas de factus_factura_prueba.js) ──────────────────────────────

async function leer(r) {
    const t = await r.text();
    try {
        return JSON.parse(t);
    } catch {
        return { crudo: t.slice(0, 500) };
    }
}

async function pedirToken() {
    const faltan = ['FACTUS_CLIENT_ID', 'FACTUS_CLIENT_SECRET', 'FACTUS_USERNAME', 'FACTUS_PASSWORD']
        .filter((k) => !process.env[k]);
    if (faltan.length) throw new Error(`Faltan en .env: ${faltan.join(', ')}.`);
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
        throw new Error(`Factus rechazó las credenciales (HTTP ${r.status}): ${cuerpo.message || cuerpo.error || 'sin detalle'}`);
    }
    return cuerpo;
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
    return { status: r.status, cuerpo: await leer(r) };
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
    fs.writeFileSync(destino, typeof contenido === 'string' ? contenido : JSON.stringify(contenido, null, 2));
    return path.relative(process.cwd(), destino);
}

// ─── Piezas comunes ────────────────────────────────────────────────────────────────────────

const CONSUMIDOR_FINAL = {
    identification_document_code: '13',
    identification: '222222222222',
    names: 'Consumidor Final',
    legal_organization_code: '2',
};

function item(nombre, cantidad, neto, extra = {}) {
    return {
        code_reference: `SONDEO-${nombre.slice(0, 4).toUpperCase()}`,
        name: nombre,
        quantity: txt(cantidad),
        discount_rate: '0.00',
        price: txt(neto),
        unit_measure_code: '94',
        standard_code: '999',
        taxes: [{ is_excluded: true }],
        ...extra,
    };
}

function facturaMinima({ ref, customer = CONSUMIDOR_FINAL, medio = '10', items, total, rango }) {
    const lineas = items || [item('Limonada natural', 1, 6000)];
    return {
        reference_code: ref || `ESCALAPP-SONDEO-${Date.now()}`,
        document: '01',
        operation_type: '10',
        numbering_range_id: rango,
        send_email: false,
        observation: 'Sondeo EscalApp (sandbox)',
        payment_details: [{ payment_form: '1', payment_method_code: medio, amount: txt(total ?? 6000) }],
        customer,
        items: lineas,
    };
}

async function rangos(token) {
    const todos = [];
    for (let pagina = 1, ultima = 1; pagina <= ultima; pagina++) {
        const r = await api(token, 'GET', `/v2/numbering-ranges?page=${pagina}`);
        const d = r.cuerpo.data;
        todos.push(...(Array.isArray(d) ? d : d?.data || []));
        ultima = d?.pagination?.last_page ?? 1;
    }
    return todos;
}

async function rangoDe(token, documento) {
    const lista = await rangos(token);
    const vivos = lista.filter(
        (x) => String(x.document || '').trim().toLowerCase() === documento && x.is_active && !Number(x.is_expired)
    );
    return vivos[0]?.id;
}

/** Emite, resume en una línea y deja el JSON en disco. Borra la factura si quedó sin validar. */
async function emitir(token, factura, etiqueta) {
    const r = await api(token, 'POST', '/v2/bills/validate', factura);
    const bill = r.cuerpo.data || {};
    const { rechazos, avisos } = clasificarErrores(bill.errors);
    guardar(`${etiqueta}.json`, { enviado: factura, http: r.status, respuesta: r.cuerpo });
    console.log(
        `  [${etiqueta}] HTTP ${r.status} · ${r.cuerpo.message || ''} · número ${bill.number || '—'} · ` +
            `validada ${bill.is_validated ?? '—'} · total ${bill.totals?.total ?? '—'}`
    );
    if (r.status >= 400) console.log('    errores:', JSON.stringify(r.cuerpo.data?.errors || r.cuerpo.errors || r.cuerpo));
    for (const [k, v] of avisos) console.log(`    aviso ${k}: ${v}`);
    for (const [k, v] of rechazos) console.log(`    RECHAZO ${k}: ${v}`);
    if (r.status < 400 && (rechazos.length || !bill.is_validated)) await borrar(token, factura.reference_code);
    return { r, bill, rechazos };
}

async function borrar(token, ref) {
    const r = await api(token, 'DELETE', `/v2/bills/destroy/reference/${encodeURIComponent(ref)}`);
    console.log(`    (borrada ${ref}: HTTP ${r.status} ${r.cuerpo.message || ''})`);
}

// ─── Subcomandos ───────────────────────────────────────────────────────────────────────────

const subcomandos = {
    async token() {
        const t = await pedirToken();
        console.log(`expires_in: ${t.expires_in} s · token_type: ${t.token_type} · refresh_token: ${t.refresh_token ? 'sí' : 'no'}`);
    },

    async 'referencia-repetida'(token) {
        const rango = await rangoDe(token, 'factura de venta');
        const factura = facturaMinima({ rango });
        console.log(`Referencia ${factura.reference_code}, enviada dos veces idéntica:`);
        await emitir(token, factura, 'referencia-1');
        await emitir(token, factura, 'referencia-2');
        console.log(`\nPara P2:  node scripts/factus_sondeo.js buscar-referencia ${factura.reference_code}`);
    },

    async 'buscar-referencia'(token, ref) {
        if (!ref) throw new Error('Uso: buscar-referencia <reference_code>');
        for (const ruta of [
            `/v2/bills?filter[reference_code]=${encodeURIComponent(ref)}`,
            `/v1/bills?filter[reference_code]=${encodeURIComponent(ref)}`,
        ]) {
            const r = await api(token, 'GET', ruta);
            const d = r.cuerpo.data;
            const lista = Array.isArray(d) ? d : d?.data || [];
            guardar(`buscar-${ruta.slice(1, 3)}.json`, r.cuerpo);
            console.log(`GET ${ruta}\n  HTTP ${r.status} · ${lista.length} resultado(s)`);
            for (const b of lista.slice(0, 3)) {
                console.log(`    ${b.number} · ref ${b.reference_code} · status ${b.status} · total ${b.total}`);
            }
            if (lista[0]) console.log('    campos:', Object.keys(lista[0]).join(', '));
        }
    },

    async 'medios-pago'(token) {
        const rango = await rangoDe(token, 'factura de venta');
        for (const medio of ['ZZZ', '47', '48', '49']) {
            await emitir(token, facturaMinima({ rango, medio, ref: `ESCALAPP-SONDEO-${medio}-${Date.now()}` }), `medio-${medio}`);
        }
    },

    async 'comprador-cedula'(token) {
        const rango = await rangoDe(token, 'factura de venta');
        const minimo = {
            identification_document_code: '13',
            identification: '1000000009',
            names: 'Cliente Prueba',
            email: CORREO,
            legal_organization_code: '2',
        };
        console.log('Solo con los campos mínimos:');
        const a = await emitir(token, facturaMinima({ rango, customer: minimo }), 'cedula-minimo');
        if (a.r.status >= 400) {
            console.log('Con tributo, dirección y municipio:');
            const completo = { ...minimo, tribute_code: 'ZZ', address: 'Calle 1 # 2-3', municipality_code: '05001' };
            await emitir(token, facturaMinima({ rango, customer: completo }), 'cedula-completo');
        }
    },

    async 'comprador-nit'(token) {
        const rango = await rangoDe(token, 'factura de venta');
        const nit = '900123456';
        const minimo = {
            identification_document_code: '31',
            identification: nit,
            dv: String(calcularDv(nit)),
            company: 'Empresa Prueba SAS',
            email: CORREO,
            legal_organization_code: '1',
        };
        console.log(`NIT ${nit}-${minimo.dv}, solo con los campos mínimos:`);
        const a = await emitir(token, facturaMinima({ rango, customer: minimo }), 'nit-minimo');
        if (a.r.status >= 400) {
            console.log('Con tributo, dirección y municipio:');
            const completo = {
                ...minimo,
                trade_name: 'Empresa Prueba SAS',
                tribute_code: 'ZZ',
                address: 'Calle 1 # 2-3',
                municipality_code: '05001',
            };
            await emitir(token, facturaMinima({ rango, customer: completo }), 'nit-completo');
        }
    },

    async 'descuento-linea'(token) {
        const rango = await rangoDe(token, 'factura de venta');
        const inc = { taxes: [{ code: '04', rate: '8.00' }], discount_rate: '10.00' };
        const carta = [
            ['Hamburguesa sencilla', 2, 22000],
            ['Limonada natural', 1, 6500],
        ];
        const items = carta.map(([n, c, p]) => item(n, c, dos(p / 1.08), inc));
        // Nuestro total: el precio de carta con el 10 % menos, que es lo que pagaría el cliente.
        const total = dos(carta.reduce((s, [, c, p]) => s + c * p * 0.9, 0));
        const { bill } = await emitir(token, facturaMinima({ rango, items, total }), 'descuento-linea');
        console.log(`  Nuestro total ${txt(total)} · Factus ${bill.totals?.total ?? '—'}`);
        if (bill.totals) console.log('  totales de Factus:', JSON.stringify(bill.totals));
    },

    async 'nota-credito'(token, numero) {
        if (!numero) throw new Error('Uso: nota-credito <numero_factura>  (una factura VALIDADA del sandbox)');
        const f = await api(token, 'GET', `/v2/bills/${encodeURIComponent(numero)}`);
        guardar('nc-factura-origen.json', f.cuerpo);
        const d = f.cuerpo.data || {};
        const bill = d.bill || d;
        console.log(`GET /v2/bills/${numero} → HTTP ${f.status} · claves de data: ${Object.keys(d).join(', ')}`);
        if (f.status >= 400) return;

        const rango = await rangoDe(token, 'nota crédito');
        console.log(`  rango de nota crédito: ${rango ?? 'ninguno activo'}`);
        const items = (d.items || bill.items || []).map((it) => ({
            code_reference: it.code_reference,
            name: it.name,
            quantity: txt(Number(it.quantity)),
            discount_rate: txt(Number(it.discount_rate || 0)),
            price: txt(Number(it.price)),
            unit_measure_code: String(it.unit_measure?.code ?? it.unit_measure_code ?? '94'),
            standard_code: String(it.standard_code?.code ?? it.standard_code ?? '999'),
            taxes: [{ is_excluded: true }],
        }));
        const nota = {
            reference_code: `ESCALAPP-SONDEO-NC-${Date.now()}`,
            correction_concept_code: '2', // anulación de la factura electrónica
            customization_id: '20', // nota que referencia una factura
            bill_number: numero,
            numbering_range_id: rango,
            observation: 'Sondeo EscalApp: anulación total',
            send_email: false,
            payment_details: [{ payment_form: '1', payment_method_code: '10', amount: String(bill.total ?? d.totals?.total) }],
            customer: CONSUMIDOR_FINAL,
            items,
        };
        const r = await api(token, 'POST', '/v2/credit-notes/validate', nota);
        guardar('nota-credito.json', { enviado: nota, http: r.status, respuesta: r.cuerpo });
        const nc = r.cuerpo.data?.credit_note || r.cuerpo.data || {};
        console.log(`POST /v2/credit-notes/validate → HTTP ${r.status} · ${r.cuerpo.message || ''}`);
        console.log(`  número ${nc.number || '—'} · validada ${nc.is_validated ?? '—'} · CUDE ${nc.cude || nc.cufe || '—'}`);
        if (r.status >= 400) console.log('  errores:', JSON.stringify(r.cuerpo.data?.errors || r.cuerpo.errors || r.cuerpo));
        for (const [k, v] of Object.entries(nc.errors || {})) console.log(`  ${k}: ${v}`);
    },
};

async function main() {
    if (!BASE.startsWith(URL_SANDBOX)) {
        throw new Error(`FACTUS_URL apunta a ${BASE}. Este script solo corre contra el sandbox (${URL_SANDBOX}).`);
    }
    const [nombre, ...resto] = process.argv.slice(2);
    const sub = subcomandos[nombre];
    if (!sub) throw new Error(`Uso: node scripts/factus_sondeo.js <${Object.keys(subcomandos).join(' | ')}>`);
    if (nombre === 'token') return sub();
    const { access_token: token } = await pedirToken();
    await sub(token, ...resto);
    console.log(`\nRespuestas completas en ${path.relative(process.cwd(), SALIDA)}/`);
}

main().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
});
