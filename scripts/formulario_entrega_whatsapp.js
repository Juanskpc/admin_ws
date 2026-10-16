/**
 * Enciende (o apaga) el formulario de entrega por WhatsApp para UN negocio.
 *
 *   node scripts/formulario_entrega_whatsapp.js <id_negocio>            → ensayo: dice qué haría
 *   node scripts/formulario_entrega_whatsapp.js <id_negocio> --aplicar  → crea, publica y enciende
 *   node scripts/formulario_entrega_whatsapp.js <id_negocio> --apagar   → vuelve a los botones
 *
 * Encender = crear el Flow en la WABA del número del negocio, subirle el JSON de
 * `intelligence/adapters/restaurante/formularioEntrega.js`, PUBLICARLO y guardar su id en
 * `gener_negocio.formulario_entrega_flow_id`. Un Flow publicado no se edita: cambiar el
 * formulario es volver a correr esto (crea uno nuevo y apunta el negocio a él).
 *
 * Apagar solo pone la columna en NULL; el Flow queda en Meta sin usarse.
 *
 * Requiere `npm run migrate:restaurante-formulario-entrega`. Ver `docs/whatsapp-flows.md`.
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');
const numeros = require('../intelligence/channels/whatsapp/numeros');
const config = require('../intelligence/channels/whatsapp/config');
const formularioEntrega = require('../intelligence/adapters/restaurante/formularioEntrega');

async function graph(metodo, ruta, { token, json, form } = {}) {
    const c = config.leer();
    const opciones = { method: metodo, headers: { Authorization: `Bearer ${token}` } };
    if (json) {
        opciones.headers['Content-Type'] = 'application/json';
        opciones.body = JSON.stringify(json);
    }
    if (form) opciones.body = form;
    const r = await fetch(`${c.baseUrl}/${c.versionApi}/${ruta}`, opciones);
    const cuerpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${metodo} ${ruta} → ${r.status} ${JSON.stringify(cuerpo)}`);
    return cuerpo;
}

/** Número, token y WABA con los que habla este negocio. */
async function cuentaDe(idNegocio) {
    await numeros.asegurarCargado({ forzar: true });
    const phoneNumberId = numeros.numeroDe(idNegocio);
    if (!phoneNumberId) throw new Error(`El negocio ${idNegocio} no tiene número de WhatsApp conectado.`);
    const propio = numeros.tokenDeNegocio(idNegocio);
    const token = propio ?? config.leer().token;
    // Con Embedded Signup la WABA está en `numero_canal`; con el alta manual (el número de
    // EscalApp) no se guardó ahí y es la del `.env`.
    const wabaId = numeros.wabaDeNegocio(idNegocio) || (!propio ? process.env.WHATSAPP_WABA_ID : null);
    if (!token || !wabaId) throw new Error(`No se pudo saber la cuenta (WABA) del negocio ${idNegocio}.`);
    return { phoneNumberId, token, wabaId };
}

async function main() {
    const [idTexto, ...banderas] = process.argv.slice(2);
    const idNegocio = Number(idTexto);
    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        console.log('Uso: node scripts/formulario_entrega_whatsapp.js <id_negocio> [--aplicar | --apagar]');
        process.exitCode = 1;
        return;
    }
    const [negocio] = await Models.sequelize.query(
        `SELECT nombre, formulario_entrega_flow_id AS flow_id FROM general.gener_negocio WHERE id_negocio = :id`,
        { replacements: { id: idNegocio }, type: Models.sequelize.QueryTypes.SELECT }
    );
    if (!negocio) throw new Error(`No existe el negocio ${idNegocio}.`);
    console.log(`Negocio ${idNegocio} (${negocio.nombre}) · formulario actual: ${negocio.flow_id || 'apagado'}`);

    if (banderas.includes('--apagar')) {
        await Models.sequelize.query(
            `UPDATE general.gener_negocio SET formulario_entrega_flow_id = NULL WHERE id_negocio = :id`,
            { replacements: { id: idNegocio } }
        );
        console.log('✓ Apagado: el asistente vuelve a preguntar con los botones.');
        return;
    }

    const { phoneNumberId, token, wabaId } = await cuentaDe(idNegocio);
    console.log(`Número ${phoneNumberId} · WABA ${wabaId}`);
    if (!banderas.includes('--aplicar')) {
        console.log('Ensayo: no se creó nada. Repite con --aplicar para crear, publicar y encender.');
        return;
    }

    const fecha = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const creado = await graph('POST', `${wabaId}/flows`, {
        token,
        json: { name: `entrega_negocio_${idNegocio}_${fecha}`, categories: ['OTHER'] },
    });
    console.log(`Flow creado: ${creado.id}`);

    const form = new FormData();
    form.append(
        'file',
        new Blob([JSON.stringify(formularioEntrega.FLOW_JSON)], { type: 'application/json' }),
        'flow.json'
    );
    form.append('name', 'flow.json');
    form.append('asset_type', 'FLOW_JSON');
    const subido = await graph('POST', `${creado.id}/assets`, { token, form });
    if ((subido.validation_errors || []).length > 0) {
        console.error('Meta rechazó el JSON; el negocio NO se tocó:', JSON.stringify(subido.validation_errors, null, 2));
        await graph('DELETE', creado.id, { token }).catch(() => {});
        process.exitCode = 1;
        return;
    }

    await graph('POST', `${creado.id}/publish`, { token });
    console.log('Flow publicado.');

    await Models.sequelize.query(
        `UPDATE general.gener_negocio SET formulario_entrega_flow_id = :flow WHERE id_negocio = :id`,
        { replacements: { flow: String(creado.id), id: idNegocio } }
    );
    console.log(`✓ Encendido: el negocio ${idNegocio} usa el formulario ${creado.id}.`);
}

main()
    .catch((e) => {
        console.error('ERROR:', e.message);
        process.exitCode = 1;
    })
    .finally(() => setTimeout(() => process.exit(), 200));
