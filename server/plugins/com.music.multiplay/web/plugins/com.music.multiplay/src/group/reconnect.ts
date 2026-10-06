/**
 * Socket 重连订阅
 *
 * AppSocket.onReconnect() 没有提供取消订阅的接口，面板反复开合会累积监听器。
 * 这里用模块级单例把底层监听器只注册一次，面板按需订阅/退订。
 */

type ReconnectListener = () => void;

let installed = false;
const listeners = new Set<ReconnectListener>();

export function subscribeReconnect(
  socket: unknown,
  listener: ReconnectListener
): () => void {
  const candidate = socket as
    | { onReconnect?: (cb: ReconnectListener) => void }
    | undefined;

  if (!installed && typeof candidate?.onReconnect === 'function') {
    installed = true;
    candidate.onReconnect(() => {
      listeners.forEach((fn) => {
        try {
          fn();
        } catch {
          // ignore
        }
      });
    });
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * 仅用于测试重置
 */
export function resetReconnectSubscription(): void {
  installed = false;
  listeners.clear();
}
