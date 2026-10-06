/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: [
    '<rootDir>/test/setup.ts'
  ],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/plugins/.*/web/'],
  // axios 1.x 的 main 指向 ESM，jest 27 不识别 package.json exports，映射到 CJS 构建
  moduleNameMapper: {
    '^axios$':
      '<rootDir>/packages/sdk/node_modules/axios/dist/node/axios.cjs',
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
};
