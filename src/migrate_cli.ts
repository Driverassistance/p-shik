import { runMigrateV1, runMigrateV2 } from './migrate.js';

runMigrateV1().then(() => runMigrateV2())
  .then(() => {
    console.log('✅ migrate v1 ok');
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ migrate failed', e);
    process.exit(1);
  });
