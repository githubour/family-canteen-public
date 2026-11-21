import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './base';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界：某个页面组件渲染崩溃时兜底，避免整个应用白屏。
 * 在 App 里用 key={pathname} 挂载——切到别的路由即重新挂载、错误自动清掉，
 * 所以一个页面炸了不会连累其它页面。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 页面渲染出错：', error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // 懒加载分块拉取失败（发版后旧 chunk 已被替换、网络抖动等）：
    // 重试只会拿到同一个已失败的 Promise，唯一有效的恢复手段是整页刷新
    const chunkFailure = /dynamically imported module|module script failed|Loading chunk/i.test(error.message);

    return (
      <div className="animate-fade-up flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-alert/10 text-3xl">😵</div>
        <p className="text-[17px] font-semibold">页面出了点问题</p>
        <p className="mt-1 max-w-[280px] text-[13px] leading-5 text-ink-400">
          {chunkFailure ? '可能刚发过新版本，页面资源对不上了，刷新一下就好。' : '这一页渲染失败了，重试或刷新都可以再试试。'}
        </p>
        <div className="mt-4 flex gap-2">
          {chunkFailure ? null : (
            <Button variant="outline" onClick={this.retry}>
              重试
            </Button>
          )}
          <Button onClick={() => window.location.reload()}>刷新页面</Button>
        </div>
      </div>
    );
  }
}
