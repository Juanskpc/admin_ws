require('dotenv').config();
const { Sequelize } = require('sequelize');
const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  dialect: 'postgres', logging: false,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } }
});
async function main() {
  const [colsNivel] = await s.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='general' AND table_name='gener_nivel' ORDER BY ordinal_position"
  );
  console.log('COLS gener_nivel:', colsNivel.map(c => c.column_name).join(', '));

  const [colsNU] = await s.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='general' AND table_name='gener_nivel_usuario' ORDER BY ordinal_position"
  );
  console.log('COLS gener_nivel_usuario:', colsNU.map(c => c.column_name).join(', '));

  const [niveles] = await s.query(
    "SELECT * FROM general.gener_nivel WHERE id_nivel BETWEEN 200 AND 280 ORDER BY id_nivel"
  );
  console.log('\nGENER_NIVEL:');
  console.log(JSON.stringify(niveles, null, 2));

  const [nivelUsr] = await s.query(
    "SELECT * FROM general.gener_nivel_usuario WHERE id_nivel BETWEEN 200 AND 280 ORDER BY id_usuario, id_nivel LIMIT 30"
  );
  console.log('\nGENER_NIVEL_USUARIO:');
  console.log(JSON.stringify(nivelUsr, null, 2));
}
main().catch(console.error).finally(() => s.close());
