import { Suspense, lazy, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { ToastHost } from './components/ui/toast';
import { subscribeSseReconnect, useServerEvents } from './api/sse';
import { useAppStore } from './store/app';
import { NotFoundPage } from './pages/NotFoundPage';

// 页面按路由分包：首屏只下载首页那一片，其余页面/重图表（recharts）用到才拉。
// 页面全是命名导出，需要包一层映射成 default 供 lazy 使用。
const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const OrderPage = lazy(() => import('./pages/OrderPage').then((m) => ({ default: m.OrderPage })));
const CartPage = lazy(() => import('./pages/CartPage').then((m) => ({ default: m.CartPage })));
const ChefPage = lazy(() => import('./pages/ChefPage').then((m) => ({ default: m.ChefPage })));
const PurchasePage = lazy(() => import('./pages/PurchasePage').then((m) => ({ default: m.PurchasePage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

function RouteFallback() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-cream-400 border-t-brand-500" />
    </div>
  );
}

export default function App() {
  const load = useAppStore((state) => state.load);
  const appError = useAppStore((state) => state.error);
  const location = useLocation();

  useEffect(() => {
    void load();
  }, [load]);

  // SSE 重连后补拉一次全局数据，断线期间新增的成员 / 改过的设置不会一直缺席
  useEffect(() => subscribeSseReconnect(() => void load()), [load]);

  // 成员或设置变动时刷新全局数据，保证各端看到同一份事实
  useServerEvents({
    'member:updated': () => void load(),
    'settings:updated': () => void load(),
  });

  const hideNav = location.pathname === '/cart';

  return (
    // 竖屏：外壳是单列，导航 fixed 贴在底部（脱离文档流，放在前面不影响布局）
    // 横屏：外壳变左右分栏，导航成为左侧竖栏，底部这 62px 就还给内容了
    <div className="app-shell lg:flex-row">
      {hideNav ? null : <BottomNav />}
      <main className={hideNav ? 'min-w-0 flex-1' : 'min-w-0 flex-1 pb-[64px] lg:pb-0'}>
        {appError ? (
          <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl2 bg-alert/10 px-3 py-2 text-[12px] text-alert">
            <span className="min-w-0 truncate">连不上服务器，成员与设置可能不是最新的</span>
            <button type="button" onClick={() => void load()} className="press shrink-0 font-semibold underline">
              重试
            </button>
          </div>
        ) : null}
        <ErrorBoundary key={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/order" element={<OrderPage />} />
              <Route path="/cart" element={<CartPage />} />
              <Route path="/chef" element={<ChefPage />} />
              <Route path="/purchase" element={<PurchasePage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <ToastHost />
    </div>
  );
}
