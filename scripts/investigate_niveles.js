require('dotenv').config();
const { Sequelize } = require('sequelize');
const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  dialect: 'postgres', logging: false,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } }
});

async function main() {
  // 1. Tipos de negocio
  const [tipos] = await s.query(`SELECT * FROM general.gener_tipo_negocio ORDER BY id_tipo_negocio`);
  console.log('═══ TIPO_NEGOCIO ═══');
  tipos.forEach(t => console.log(`  ${t.id_tipo_negocio} | ${t.nombre} | ${t.estado}`));

  // 2. Tipos de nivel
  const [tiposNivel] = await s.query(`SELECT * FROM general.gener_tipo_nivel ORDER BY id_tipo_nivel`);
  console.log('\n═══ TIPO_NIVEL ═══');
  tiposNivel.forEach(t => console.log(`  ${t.id_tipo_nivel} | ${t.descripcion || t.nombre || JSON.stringify(t)}`));

  // 3. Todos los niveles agrupados por id_tipo_negocio
  const [niveles] = await s.query(`
    SELECT n.id_nivel, n.descripcion, n.id_nivel_padre, n.icono, n.estado,
           n.id_tipo_nivel, n.url, n.id_tipo_negocio,
           tn.nombre as tipo_negocio_nombre
    FROM general.gener_nivel n
    LEFT JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
    ORDER BY n.id_tipo_negocio, n.id_nivel
  `);
  console.log('\n═══ GENER_NIVEL (TODOS) ═══');
  let lastTipo = null;
  niveles.forEach(n => {
    if (n.id_tipo_negocio !== lastTipo) {
      lastTipo = n.id_tipo_negocio;
      console.log(`\n  --- Tipo Negocio: ${n.id_tipo_negocio} (${n.tipo_negocio_nombre || 'NULL/GLOBAL'}) ---`);
    }
    console.log(`  ${n.id_nivel}\t${n.id_nivel_padre || '-'}\t${n.id_tipo_nivel}\t${n.estado}\t${n.url}\t${n.descripcion}`);
  });

  // 4. Niveles con tipo AUTH duplicado por negocio
  const [authNiveles] = await s.query(`
    SELECT id_nivel, descripcion, id_nivel_padre, id_tipo_negocio, url
    FROM general.gener_nivel
    WHERE UPPER(descripcion) IN ('AUTENTICACION','LOGIN','RECUPERAR CONTRASEÑA','CAMBIO DE CONTRASEÑA')
    ORDER BY id_tipo_negocio, id_nivel
  `);
  console.log('\n═══ NIVELES AUTH DUPLICADOS ═══');
  authNiveles.forEach(n => console.log(`  ${n.id_nivel}\ttipo_neg=${n.id_tipo_negocio}\t${n.descripcion}\t${n.url}`));

  // 5. gener_nivel_usuario referencing auth levels
  const authIds = authNiveles.map(n => n.id_nivel);
  if (authIds.length > 0) {
    const [refs] = await s.query(`
      SELECT * FROM general.gener_nivel_usuario 
      WHERE id_nivel IN (${authIds.join(',')})
    `);
    console.log(`\n═══ NIVEL_USUARIO refs to auth niveles (${refs.length} rows) ═══`);
    refs.forEach(r => console.log(`  ${JSON.stringify(r)}`));
  }

  // 6. gener_rol_nivel referencing auth levels
  if (authIds.length > 0) {
    const [rolRefs] = await s.query(`
      SELECT * FROM general.gener_rol_nivel 
      WHERE id_nivel IN (${authIds.join(',')})
    `);
    console.log(`\n═══ ROL_NIVEL refs to auth niveles (${rolRefs.length} rows) ═══`);
    rolRefs.forEach(r => console.log(`  ${JSON.stringify(r)}`));
  }

  // 7. Total niveles count by tipo_negocio
  const [counts] = await s.query(`
    SELECT id_tipo_negocio, COUNT(*) as cnt 
    FROM general.gener_nivel 
    GROUP BY id_tipo_negocio ORDER BY id_tipo_negocio
  `);
  console.log('\n═══ CONTEO POR TIPO_NEGOCIO ═══');
  counts.forEach(c => console.log(`  tipo_negocio=${c.id_tipo_negocio}: ${c.cnt} niveles`));

  // 8. Check if auth levels exist for ALL business types
  const [authPerTipo] = await s.query(`
    SELECT id_tipo_negocio, array_agg(id_nivel ORDER BY id_nivel) as ids
    FROM general.gener_nivel
    WHERE UPPER(descripcion) IN ('AUTENTICACION','LOGIN','RECUPERAR CONTRASEÑA','CAMBIO DE CONTRASEÑA')
    GROUP BY id_tipo_negocio
    ORDER BY id_tipo_negocio
  `);
  console.log('\n═══ AUTH NIVELES POR TIPO NEGOCIO ═══');
  authPerTipo.forEach(a => console.log(`  tipo_negocio=${a.id_tipo_negocio}: IDs = ${a.ids}`));
}

main().catch(console.error).finally(() => s.close());
