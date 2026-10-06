/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  rootDir: '.',
  testRegex: '.*\\.(test|spec)\\.tsx?$',
  moduleNameMapper: {
    '\\.(css|less|scss)$': 'identity-obj-proxy',
    '^@capital/common$': '<rootDir>/test/__mocks__/capitalCommon.ts',
    '^@capital/component$': '<rootDir>/test/__mocks__/capitalComponent.tsx',
  },
  transformIgnorePatterns: ['/node_modules/(?!(@capital)/)'],
  globals: {
    'ts-jest': {
      tsconfig: '<rootDir>/tsconfig.test.json',
    },
  },
};
