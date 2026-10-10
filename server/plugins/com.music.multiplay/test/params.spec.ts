import { ServiceBroker } from 'moleculer';
import {
  NUMBER_PARAM,
  OPTIONAL_NUMBER_PARAM,
} from '../services/multiplay.service';

/**
 * 参数校验回归测试
 *
 * 背景：search / url / pic 走 HTTP GET，query 中的数值都是字符串
 * （例如 `?count=20`），若参数声明缺少 `convert` 会返回 422。
 * 这里用最小 broker 直接验证导出的参数 schema，不需要 Mongo/Redis。
 */
describe('MUSIC 数值参数 schema', () => {
  let broker: ServiceBroker;

  beforeAll(async () => {
    broker = new ServiceBroker({ logger: false });
    broker.createService({
      name: 'paramcheck',
      actions: {
        optional: {
          params: {
            name: 'string',
            count: OPTIONAL_NUMBER_PARAM,
            pages: OPTIONAL_NUMBER_PARAM,
          },
          handler(ctx: any) {
            return ctx.params;
          },
        },
        required: {
          params: {
            id: 'string',
            br: NUMBER_PARAM,
          },
          handler(ctx: any) {
            return ctx.params;
          },
        },
      },
    });

    await broker.start();
  });

  afterAll(async () => {
    await broker.stop();
  });

  test('query 字符串会被转换成数字', async () => {
    await expect(
      broker.call('paramcheck.optional', {
        name: 'hello',
        count: '20',
        pages: '1',
      })
    ).resolves.toEqual({ name: 'hello', count: 20, pages: 1 });
  });

  test('真实数字原样通过', async () => {
    await expect(
      broker.call('paramcheck.optional', { name: 'hello', count: 20 })
    ).resolves.toEqual({ name: 'hello', count: 20 });
  });

  test('缺省的可选参数不会报错', async () => {
    await expect(
      broker.call('paramcheck.optional', { name: 'hello' })
    ).resolves.toEqual({ name: 'hello' });
  });

  test('非数值仍然被校验拒绝（422）', async () => {
    await expect(
      broker.call('paramcheck.optional', { name: 'hello', count: 'abc' })
    ).rejects.toMatchObject({ code: 422 });

    await expect(
      broker.call('paramcheck.required', { id: '1', br: 'x' })
    ).rejects.toMatchObject({ code: 422 });
  });

  test('必填的数值参数缺失时报错', async () => {
    await expect(
      broker.call('paramcheck.required', { id: '1' })
    ).rejects.toMatchObject({ code: 422 });
  });
});
