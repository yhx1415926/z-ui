import 'antd/dist/reset.css';
import './styles/global.css';
import './i18n/index.ts';
import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { queryClient } from './api/hooks.ts';
import { FullPageSpin, RequireAuth } from './auth/RequireAuth.tsx';
import { StepUpProvider } from './auth/StepUp.tsx';
import { PanelLayout } from './layouts/PanelLayout.tsx';
import { applyDom, readStoredMode, ThemeProvider } from './theme/ThemeProvider.tsx';

// Each page is its own chunk, loaded on first visit.
const LoginPage = lazy(() => import('./pages/LoginPage.tsx').then((m) => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import('./pages/SetupPage.tsx').then((m) => ({ default: m.SetupPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage.tsx').then((m) => ({ default: m.DashboardPage })));
const AccountsPage = lazy(() => import('./pages/AccountsPage.tsx').then((m) => ({ default: m.AccountsPage })));
const CardsPage = lazy(() => import('./pages/CardsPage.tsx').then((m) => ({ default: m.CardsPage })));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage.tsx').then((m) => ({ default: m.TransactionsPage })));
const BillsPage = lazy(() => import('./pages/BillsPage.tsx').then((m) => ({ default: m.BillsPage })));
const StatementsPage = lazy(() => import('./pages/StatementsPage.tsx').then((m) => ({ default: m.StatementsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage })));
const SecurityPage = lazy(() => import('./pages/SecurityPage.tsx').then((m) => ({ default: m.SecurityPage })));
const StatsPage = lazy(() => import('./pages/StatsPage.tsx').then((m) => ({ default: m.StatsPage })));
const InvestPage = lazy(() => import('./pages/InvestPage.tsx').then((m) => ({ default: m.InvestPage })));
const FxPage = lazy(() => import('./pages/FxPage.tsx').then((m) => ({ default: m.FxPage })));
const NotifyPage = lazy(() => import('./pages/NotifyPage.tsx').then((m) => ({ default: m.NotifyPage })));

const standalone = (node: ReactNode) => <Suspense fallback={<FullPageSpin />}>{node}</Suspense>;

// Apply the theme before the first paint to avoid a flash.
applyDom(readStoredMode());

const router = createBrowserRouter([
  { path: '/login', element: standalone(<LoginPage />) },
  { path: '/setup/:token', element: standalone(<SetupPage />) },
  {
    path: '/',
    element: (
      <RequireAuth>
        <StepUpProvider>
          <PanelLayout />
        </StepUpProvider>
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'accounts', element: <AccountsPage /> },
      { path: 'cards', element: <CardsPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'bills', element: <BillsPage /> },
      { path: 'statements', element: <StatementsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'security', element: <SecurityPage /> },
      { path: 'invest', element: <InvestPage /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'fx', element: <FxPage /> },
      { path: 'notify', element: <NotifyPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
