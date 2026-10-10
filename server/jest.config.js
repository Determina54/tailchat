/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup.ts'],
  // 插件前端 spec 由插件自己的 jest 配置运行（需要 jsdom 与 @capital/* 替身）
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/web/plugins/'],
  moduleNameMapper: {
    // jest 27 不识别 exports 字段, 会解析到 axios 的 esm 入口
    '^axios$': '<rootDir>/packages/sdk/node_modules/axios/dist/node/axios.cjs',
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
};
