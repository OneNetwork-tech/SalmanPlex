'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');

function createSequelize() {
  const { db } = config;
  const common = {
    logging: db.logging ? (msg) => console.log(msg) : false,
    define: { underscored: true },
  };

  if (db.dialect === 'sqlite') {
    return new Sequelize({ ...common, dialect: 'sqlite', storage: db.storage });
  }

  const dialectOptions = db.ssl ? { ssl: { require: true, rejectUnauthorized: true } } : {};
  const pool = { max: 10, min: 0, idle: 10000, acquire: 30000 };

  if (db.url) {
    return new Sequelize(db.url, { ...common, dialect: 'postgres', dialectOptions, pool });
  }

  return new Sequelize(db.database, db.username, db.password, {
    ...common,
    dialect: 'postgres',
    host: db.host,
    port: db.port,
    dialectOptions,
    pool,
  });
}

const sequelize = createSequelize();

module.exports = { sequelize };
