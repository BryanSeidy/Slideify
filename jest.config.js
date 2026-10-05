/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@slideify/shared$': '<rootDir>/packages/shared/src',
    '^@slideify/config$': '<rootDir>/packages/config/src',
    '^@slideify/llm$': '<rootDir>/packages/llm/src',
    '^@slideify/schema$': '<rootDir>/packages/schema/src',
    '^@slideify/renderer$': '<rootDir>/packages/renderer/src',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          esModuleInterop: true,
          skipLibCheck: true,
          strict: false,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          baseUrl: '.',
          paths: {
            '@slideify/shared': ['./packages/shared/src'],
            '@slideify/config': ['./packages/config/src'],
            '@slideify/llm': ['./packages/llm/src'],
            '@slideify/schema': ['./packages/schema/src'],
            '@slideify/renderer': ['./packages/renderer/src'],
          },
        },
      },
    ],
  },
  testTimeout: 30000,
};
