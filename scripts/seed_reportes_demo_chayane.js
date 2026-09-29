/**
 * Datos de ejemplo para las gráficas de Reportes de restaurante — SOLO desarrollo.
 *
 *   node scripts/seed_reportes_demo_chayane.js            # crea (o rehace) los ejemplos
 *   node scripts/seed_reportes_demo_chayane.js --borrar   # los quita
 *
 * Negocio destino: 17 (RESTAURANTE CHAYANE, base compartida `escalapp_dev`).
 * Idempotente: los pedidos llevan numero_orden `DEMO-#####`, así que cada corrida borra los
 * anteriores y los vuelve a generar igual (PRNG con semilla). Los usuarios de ejemplo se
 * identifican por documento 2000000001..2000000005 y se reutilizan si ya existen.
 *
 * Solo escribe en pedid_orden / pedid_detalle (lo que leen los reportes). NO toca cajas ni
 * movimientos de caja, para no alterar ningún arqueo.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const Models = require('../app_core/models/conection');

const ID_NEGOCIO = 17;
const DIAS = 60;
const PREFIJO = 'DEMO-';

const USUARIOS = [
    { doc: '2000000001', nombre: 'LAURA', apellido: 'GOMEZ', rol: 'CAJERO', peso: 5 },
    { doc: '2000000002', nombre: 'ANA', apellido: 'TORRES', rol: 'CAJERO', peso: 3 },
    { doc: '2000000003', nombre: 'CARLOS', apellido: 'RUIZ', rol: 'MESERO', peso: 4 },
    { doc: '2000000004', nombre: 'MIGUEL', apellido: 'PEREZ', rol: 'MESERO', peso: 2 },
    { doc: '2000000005', nombre: 'DIANA', apellido: 'ROJAS', rol: 'CAJERO', peso: 1 },
];

// Popularidad relativa por nombre de producto (los que no aparezcan pesan 1).
const PESO_PRODUCTO = {
    'Chayane Clásica': 10, 'Salchipapa clásica': 8, 'Limonada de coco': 8, 'Gaseosa 400 ml': 7,
    'Patacón con hogao': 6, 'Perro Chayane': 6, 'Doble Tocineta': 5, 'Pollo Crispy': 5,
    'Bandeja paisa': 4, 'Salchipapa especial': 4, 'Cerveza nacional': 4, 'Empanadas de carne (x3)': 4,
    'Jugo natural en agua': 3, 'Churrasco 300 g': 2, 'Torta de chocolate': 2, 'Chicharrón carnudo': 2,
    'Mojarra frita': 1, 'Flan de caramelo': 1,
};

function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function elegirPonderado(rand, items, peso) {
    const total = items.reduce((a, it) => a + peso(it), 0);
    let r = rand() * total;
    for (const it of items) {
        r -= peso(it);
        if (r <= 0) return it;
    }
    return items[items.length - 1];
}

const pad = (n) => String(n).padStart(2, '0');
const ts = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

async function borrarEjemplos(c) {
    await c.query(
        `DELETE FROM restaurante.pedid_detalle WHERE id_orden IN
           (SELECT id_orden FROM restaurante.pedid_orden WHERE id_negocio = $1 AND numero_orden LIKE $2)`,
        [ID_NEGOCIO, `${PREFIJO}%`],
    );
    const r = await c.query(
        'DELETE FROM restaurante.pedid_orden WHERE id_negocio = $1 AND numero_orden LIKE $2',
        [ID_NEGOCIO, `${PREFIJO}%`],
    );
    return r.rowCount;
}

async function asegurarUsuarios(c) {
    const { rows: [{ password }] } = await c.query(
        "SELECT password FROM general.gener_usuario WHERE num_identificacion = '1000000002'",
    );
    const { rows: roles } = await c.query(
        `SELECT r.id_rol, r.descripcion FROM general.gener_rol r
          WHERE r.id_tipo_negocio = (SELECT id_tipo_negocio FROM general.gener_negocio WHERE id_negocio = $1)`,
        [ID_NEGOCIO],
    );
    const idRol = Object.fromEntries(roles.map((r) => [r.descripcion, r.id_rol]));

    const out = [];
    for (const u of USUARIOS) {
        let { rows: [fila] } = await c.query(
            'SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = $1', [u.doc],
        );
        if (!fila) {
            ({ rows: [fila] } = await c.query(
                `INSERT INTO general.gener_usuario
                   (primer_nombre, primer_apellido, num_identificacion, email, password)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id_usuario`,
                [u.nombre, u.apellido, u.doc, `${u.nombre.toLowerCase()}.demo@chayane.test`, password],
            ));
        }
        const id = fila.id_usuario;
        await c.query(
            `INSERT INTO general.gener_negocio_usuario (id_usuario, id_negocio)
             SELECT $1, $2 WHERE NOT EXISTS
               (SELECT 1 FROM general.gener_negocio_usuario WHERE id_usuario = $1 AND id_negocio = $2)`,
            [id, ID_NEGOCIO],
        );
        await c.query(
            `INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio)
             SELECT $1, $2, $3 WHERE NOT EXISTS
               (SELECT 1 FROM general.gener_usuario_rol WHERE id_usuario = $1 AND id_rol = $2 AND id_negocio = $3)`,
            [id, idRol[u.rol], ID_NEGOCIO],
        );
        out.push({ ...u, id });
    }
    return { usuarios: out, idRol };
}

async function main() {
    const { DB_NAME, DB_PORT, DB_HOST } = process.env;
    console.log(`Base: ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    if (DB_NAME !== 'escalapp_dev') {
        throw new Error('Se niega a correr: la base no es escalapp_dev.');
    }

    const c = await Models.pool.connect();
    try {
        await c.query('BEGIN');
        const { rows: [neg] } = await c.query(
            'SELECT nombre FROM general.gener_negocio WHERE id_negocio = $1', [ID_NEGOCIO],
        );
        if (!neg || !/chayane/i.test(neg.nombre)) {
            throw new Error(`El negocio ${ID_NEGOCIO} no es Chayane (${neg?.nombre}).`);
        }

        const borrados = await borrarEjemplos(c);
        console.log(`Pedidos de ejemplo previos borrados: ${borrados}`);
        if (process.argv.includes('--borrar')) {
            await c.query('COMMIT');
            return;
        }

        const { usuarios } = await asegurarUsuarios(c);
        const cajeros = usuarios.filter((u) => u.rol === 'CAJERO');
        const meseros = usuarios.filter((u) => u.rol === 'MESERO');
        const domiciliarios = [23, 92];

        const { rows: productos } = await c.query(
            "SELECT id_producto, nombre, precio::numeric AS precio FROM restaurante.carta_producto WHERE id_negocio = $1 AND estado = 'A'",
            [ID_NEGOCIO],
        );
        const { rows: mesas } = await c.query(
            'SELECT id_mesa, nombre, numero FROM restaurante.rest_mesa WHERE id_negocio = $1', [ID_NEGOCIO],
        );
        const { rows: metodos } = await c.query(
            "SELECT id_metodo_pago, nombre FROM restaurante.rest_metodo_pago WHERE id_negocio = $1 AND estado = 'A' AND es_cuenta = false AND nombre IN ('Efectivo','Transferencia')",
            [ID_NEGOCIO],
        );
        const { rows: [punto] } = await c.query(
            "SELECT id_punto_caja FROM restaurante.rest_punto_caja WHERE id_negocio = $1 AND estado = 'A' ORDER BY orden LIMIT 1",
            [ID_NEGOCIO],
        );
        const { rows: [caja] } = await c.query(
            'SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = $1 ORDER BY id_caja DESC LIMIT 1', [ID_NEGOCIO],
        );
        const mEfectivo = metodos.find((m) => m.nombre === 'Efectivo');
        const mTransf = metodos.find((m) => m.nombre === 'Transferencia');

        const rand = prng(17_2026);
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        const barrios = ['Centro', 'La Floresta', 'El Prado', 'San Fernando', 'Los Alcázares'];

        let consecutivo = 0;
        let totalOrdenes = 0;
        for (let d = DIAS - 1; d >= 0; d--) {
            const dia = new Date(hoy);
            dia.setDate(dia.getDate() - d);
            const dow = dia.getDay(); // 0 dom … 6 sáb
            const fin = dow === 5 || dow === 6 ? 1.7 : dow === 0 ? 1.4 : 1;
            const tendencia = 0.75 + ((DIAS - d) / DIAS) * 0.5; // crece ~un 65 % a lo largo del rango
            const cuantos = Math.max(2, Math.round((5 + rand() * 4) * fin * tendencia));

            for (let k = 0; k < cuantos; k++) {
                const r = rand();
                const tipo = r < 0.5 ? 'MESA' : r < 0.78 ? 'LLEVAR' : 'DOMICILIO';
                const hora = 11 + Math.floor(rand() * 10); // 11:00 – 20:59
                const min = Math.floor(rand() * 60);
                const creado = new Date(dia);
                creado.setHours(hora, min);
                const cerrado = new Date(creado.getTime() + (15 + Math.floor(rand() * 45)) * 60_000);

                const nItems = 1 + Math.floor(rand() * (tipo === 'MESA' ? 4 : 3)) + (rand() < 0.2 ? 1 : 0);
                const lineas = [];
                for (let i = 0; i < nItems; i++) {
                    const p = elegirPonderado(rand, productos, (x) => PESO_PRODUCTO[x.nombre] ?? 1);
                    const cant = 1 + (rand() < 0.3 ? 1 : 0) + (rand() < 0.08 ? 1 : 0);
                    const previa = lineas.find((l) => l.p.id_producto === p.id_producto);
                    if (previa) previa.cant += cant;
                    else lineas.push({ p, cant });
                }
                const subtotal = lineas.reduce((a, l) => a + Number(l.p.precio) * l.cant, 0);
                const valorDomicilio = tipo === 'DOMICILIO' ? [3000, 4000, 5000, 6000][Math.floor(rand() * 4)] : 0;
                const total = subtotal + valorDomicilio;

                const cajero = elegirPonderado(rand, cajeros, (u) => u.peso);
                const mesero = elegirPonderado(rand, meseros, (u) => u.peso);
                const responsable = tipo === 'MESA' && rand() < 0.65 ? mesero : cajero;
                const mesa = tipo === 'MESA' ? mesas[Math.floor(rand() * mesas.length)] : null;
                const metodo = rand() < 0.62 ? mEfectivo : mTransf;
                consecutivo += 1;

                const { rows: [orden] } = await c.query(
                    `INSERT INTO restaurante.pedid_orden
                       (id_negocio, id_usuario, numero_orden, mesa, subtotal, impuesto, total, estado,
                        fecha_creacion, fecha_cierre, id_mesa, id_caja, id_metodo_pago, tipo_pedido,
                        contacto_nombre, contacto_telefono, direccion_domicilio, id_domiciliario,
                        estado_pago, valor_domicilio, descuento, id_punto_caja)
                     VALUES ($1,$2,$3,$4,$5,0,$6,'CERRADA',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pagado',$17,0,$18)
                     RETURNING id_orden`,
                    [
                        ID_NEGOCIO, responsable.id, `${PREFIJO}${String(consecutivo).padStart(5, '0')}`,
                        mesa ? mesa.nombre : null, subtotal, total, ts(creado), ts(cerrado),
                        mesa ? mesa.id_mesa : null, caja.id_caja, metodo.id_metodo_pago, tipo,
                        tipo === 'MESA' ? null : `Cliente ${consecutivo}`,
                        tipo === 'MESA' ? null : `31${String(10000000 + Math.floor(rand() * 89999999))}`,
                        tipo === 'DOMICILIO' ? `Cra ${1 + Math.floor(rand() * 60)} #${1 + Math.floor(rand() * 90)}-${1 + Math.floor(rand() * 90)}, ${barrios[Math.floor(rand() * barrios.length)]}` : null,
                        tipo === 'DOMICILIO' ? domiciliarios[Math.floor(rand() * 2)] : null,
                        valorDomicilio, punto.id_punto_caja,
                    ],
                );

                for (const l of lineas) {
                    await c.query(
                        `INSERT INTO restaurante.pedid_detalle
                           (id_orden, id_producto, cantidad, precio_unitario, subtotal, estado, fecha_creacion)
                         VALUES ($1,$2,$3,$4,$5,'ENTREGADO',$6)`,
                        [orden.id_orden, l.p.id_producto, l.cant, l.p.precio, Number(l.p.precio) * l.cant, ts(creado)],
                    );
                }
                totalOrdenes += 1;
            }
        }

        await c.query('COMMIT');
        console.log(`Usuarios de ejemplo: ${usuarios.map((u) => `${u.nombre} ${u.apellido} (${u.rol}, id ${u.id})`).join('; ')}`);
        console.log(`Pedidos CERRADOS creados: ${totalOrdenes} en ${DIAS} días`);
    } catch (err) {
        await c.query('ROLLBACK');
        throw err;
    } finally {
        c.release();
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
