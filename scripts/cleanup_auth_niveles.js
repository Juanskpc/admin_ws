require('dotenv').config();
const { Sequelize } = require('sequelize');
const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  dialect: 'postgres', logging: false,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } }
});

async function main() {
  const authIds = [];
  for (let base = 100; base <= 700; base += 100) {
    authIds.push(base, base+1, base+2, base+3);
  }
  const idList = authIds.join(',');

  const t = await s.transaction();
  try {
    // 1. Delete nivel_usuario references
    const [, nuMeta] = await s.query(
      `DELETE FROM general.gener_nivel_usuario WHERE id_nivel IN (${idList})`,
      { transaction: t }
    );
    console.log(`✓ Deleted ${nuMeta.rowCount} rows from gener_nivel_usuario`);

    // 2. Delete rol_nivel references (safety)
    const [, rnMeta] = await s.query(
      `DELETE FROM general.gener_rol_nivel WHERE id_nivel IN (${idList})`,
      { transaction: t }
    );
    console.log(`✓ Deleted ${rnMeta.rowCount} rows from gener_rol_nivel`);

    // 3. Delete the auth niveles themselves
    const [, nMeta] = await s.query(
      `DELETE FROM general.gener_nivel WHERE id_nivel IN (${idList})`,
      { transaction: t }
    );
    console.log(`✓ Deleted ${nMeta.rowCount} rows from gener_nivel`);

    await t.commit();
    console.log('\n✅ Transaction committed successfully!');

    // Verify
    const [remaining] = await s.query(`
      SELECT id_tipo_negocio, COUNT(*) as cnt
      FROM general.gener_nivel
      GROUP BY id_tipo_negocio
      ORDER BY id_tipo_negocio
    `);
    console.log('\n═══ REMAINING NIVELES PER TIPO_NEGOCIO ═══');
    remaining.forEach(r => console.log(`  tipo_negocio=${r.id_tipo_negocio}: ${r.cnt} niveles`));

    const [authCheck] = await s.query(`
      SELECT id_nivel, descripcion, id_tipo_negocio
      FROM general.gener_nivel
      WHERE UPPER(descripcion) LIKE '%AUTENTICACION%' OR UPPER(descripcion) LIKE '%LOGIN%'
    `);
    console.log(`\nAuth-related niveles remaining: ${authCheck.length}`);
    authCheck.forEach(a => console.log(`  ${a.id_nivel} | tipo=${a.id_tipo_negocio} | ${a.descripcion}`));

  } catch (err) {
    await t.rollback();
    console.error('❌ Transaction rolled back:', err.message);
  }
}

main().catch(console.error).finally(() => s.close());
