/** @type {import('jest').Config} */
const base = require('./jest.config');

module.exports = {
  ...base,
  testMatch: ['**/real.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 120_000,
};
