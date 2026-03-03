require('dotenv').config();
const { Sequelize } = require('sequelize');
const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  dialect: 'postgres', logging: false,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } }
});

async function main() {
  // Auth IDs to delete: 100-103, 200-203, 300-303, 400-403, 500-503, 600-603, 700-703
  const authIds = [];
  for (let base = 100; base <= 700; base += 100) {
    authIds.push(base, base+1, base+2, base+3);
  }

  // 1. Children referencing auth IDs as id_nivel_padre
  const [children] = await s.query(`
    SELECT id_nivel, descripcion, id_nivel_padre, id_tipo_negocio
    FROM general.gener_nivel
    WHERE id_nivel_padre IN (${authIds.join(',')})
    AND id_nivel NOT IN (${authIds.join(',')})
  `);
  console.log(`Non-auth children referencing auth parents: ${children.length}`);
  children.forEach(c => console.log(`  ${c.id_nivel} '${c.descripcion}' → padre=${c.id_nivel_padre}`));

  // 2. gener_nivel_usuario total for auth IDs
  const [nuRefs] = await s.query(`
    SELECT nu.id_nivel_usuario, nu.id_usuario, nu.id_nivel
    FROM general.gener_nivel_usuario nu
    WHERE nu.id_nivel IN (${authIds.join(',')})
  `);
  console.log(`\ngener_nivel_usuario refs to delete: ${nuRefs.length}`);
  nuRefs.forEach(r => console.log(`  id=${r.id_nivel_usuario} user=${r.id_usuario} nivel=${r.id_nivel}`));

  // 3. gener_rol_nivel for auth IDs
  const [rnRefs] = await s.query(`
    SELECT * FROM general.gener_rol_nivel WHERE id_nivel IN (${authIds.join(',')})
  `);
  console.log(`\ngener_rol_nivel refs to delete: ${rnRefs.length}`);

  console.log('\n=== READY TO PROCEED ===');
  console.log(`Will delete: ${authIds.length} nivel rows (IDs: ${authIds.join(', ')})`);
  console.log(`Will delete: ${nuRefs.length} nivel_usuario rows`);
  console.log(`Will delete: ${rnRefs.length} rol_nivel rows`);
}

main().catch(console.error).finally(() => s.close());
