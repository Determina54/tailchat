import React from 'react';

/**
 * 测试用的 @capital/component 替身
 */
export const GroupPanelContainer: React.FC<
  React.PropsWithChildren<{ groupId: string; panelId: string }>
> = ({ children }) => <div data-testid="panel">{children}</div>;

export const Button: React.FC<React.PropsWithChildren> = ({ children }) => (
  <button type="button">{children}</button>
);

export const Avatar: React.FC = () => null;
