/**
 * 测试用的 @capital/common 替身
 *
 * 只实现插件源码实际用到的导出，避免拉起真实前端依赖。
 */

export const localTrans = (trans: { 'zh-CN': string; 'en-US': string }) =>
  trans['zh-CN'] || trans['en-US'] || '';

export const Loadable = () => () => null;

export const regGroupPanel = () => undefined;

export const getJWTUserInfo = async () => ({
  _id: 'u1',
  nickname: 'tester',
});

export const showToasts = jest.fn();

export const showErrorToasts = jest.fn();

export const showSuccessToasts = jest.fn();

export const useGlobalSocketEvent = () => undefined;

export const useSocketContext = () => undefined;

export const useWatch = () => undefined;

export const useGroupPanelContext = () => ({
  groupId: 'g1',
  panelId: 'p1',
});

export const createPluginRequest = () => ({
  get: async () => ({ data: undefined }),
  post: async () => ({ data: undefined }),
});
