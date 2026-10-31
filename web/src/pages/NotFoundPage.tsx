import { Link } from 'react-router-dom';

/** 未知路径兜底：旧版只渲染导航和空 main，用户会以为页面坏了。 */
export function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-cream-200 text-3xl">🍽️</div>
      <h1 className="text-[22px] font-semibold text-ink-900">这个页面不存在</h1>
      <p className="mt-2 text-[13px] leading-5 text-ink-400">链接可能写错了，或者页面已经被移动。</p>
      <div className="mt-5 flex gap-2">
        <Link
          to="/"
          className="press inline-flex h-10 items-center justify-center rounded-full border border-cream-400 bg-white px-4 text-[15px] font-medium text-ink-900 transition hover:border-brand-300 hover:text-brand-600"
        >
          回首页
        </Link>
        <Link
          to="/order"
          className="press warm-gradient inline-flex h-10 items-center justify-center rounded-full px-4 text-[15px] font-medium text-white shadow-float transition"
        >
          去点菜
        </Link>
      </div>
    </div>
  );
}
