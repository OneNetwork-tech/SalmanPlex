'use strict';

const path = require('path');
const { Umzug, SequelizeStorage } = require('umzug');
const { Sequelize } = require('sequelize');
const { sequelize } = require('./index');

function createMigrator() {
  return new Umzug({
    migrations: {
      glob: ['migrations/*.js', { cwd: path.join(__dirname) }],
      resolve: ({ name, path: migrationPath, context }) => {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const migration = require(migrationPath);
        return {
          name,
          up: async () => migration.up(context, Sequelize),
          down: async () => migration.down(context, Sequelize),
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName: 'schema_migrations' }),
    logger: undefined,
  });
}

async function migrateUp() {
  const migrator = createMigrator();
  return migrator.up();
}

async function migrateDown() {
  const migrator = createMigrator();
  return migrator.down();
}

module.exports = { migrateUp, migrateDown };

if (require.main === module) {
  const direction = process.argv[2] || 'up';
  const run = direction === 'down' ? migrateDown : migrateUp;
  run()
    .then((applied) => {
      console.log(`Migrations ${direction}: ${applied.map((m) => m.name).join(', ') || 'none'}`);
      return sequelize.close();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
