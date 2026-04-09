require('dotenv').config();
const db = require('../app_core/models/conection');
db.sequelize.query(`
  SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'parqueadero' AND table_name = 'parq_tarifa'
  ORDER BY ordinal_position;
`).then(([rows]) => {
  console.log('=== parq_tarifa columns ===');
  console.log(JSON.stringify(rows, null, 2));
  return db.sequelize.query(`SELECT * FROM parqueadero.parq_tarifa LIMIT 5;`);
}).then(([rows]) => {
  console.log('\n=== sample rows ===');
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
