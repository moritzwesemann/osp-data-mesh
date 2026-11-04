import { QueryClientProvider } from '@tanstack/react-query';
import { type ComponentType, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router';
import type { RouteId } from '../shared/contract/index.ts';
import { ErrorMessage } from './components/ErrorMessage.tsx';
import { AppShell } from './components/Layout.tsx';
import { Loading } from './components/QueryState.tsx';
import { RequireAccess } from './components/RequireAccess.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { I18nProvider, useI18n } from './i18n/index.tsx';
import { queryClient } from './lib/query.ts';
import { SessionProvider, useMe } from './lib/session.tsx';
import { ForcePasswordChange } from './screens/ForcePasswordChange.tsx';
import { SignIn } from './screens/SignIn.tsx';

/** Bildschirm per Code-Splitting laden (benannter Export). */
function screen<N extends string>(load: () => Promise<Record<N, ComponentType>>, name: N) {
  return lazy(async () => ({ default: (await load())[name] }));
}

const Overview = screen(() => import('./screens/Overview.tsx'), 'Overview');
const AthleteList = screen(() => import('./screens/AthleteList.tsx'), 'AthleteList');
const AthleteForm = screen(() => import('./screens/AthleteForm.tsx'), 'AthleteForm');
const AthleteDetail = screen(() => import('./screens/AthleteDetail.tsx'), 'AthleteDetail');
const ConnectorList = screen(() => import('./screens/ConnectorList.tsx'), 'ConnectorList');
const ConnectorForm = screen(() => import('./screens/ConnectorForm.tsx'), 'ConnectorForm');
const ConnectorDetail = screen(() => import('./screens/ConnectorDetail.tsx'), 'ConnectorDetail');
const ImportRunView = screen(() => import('./screens/ImportRunView.tsx'), 'ImportRunView');
const DatasetList = screen(() => import('./screens/DatasetList.tsx'), 'DatasetList');
const DatasetForm = screen(() => import('./screens/DatasetForm.tsx'), 'DatasetForm');
const DatasetDetail = screen(() => import('./screens/DatasetDetail.tsx'), 'DatasetDetail');
const ProductList = screen(() => import('./screens/ProductList.tsx'), 'ProductList');
const ProductForm = screen(() => import('./screens/ProductForm.tsx'), 'ProductForm');
const ProductDetail = screen(() => import('./screens/ProductDetail.tsx'), 'ProductDetail');
const ReleaseList = screen(() => import('./screens/ReleaseList.tsx'), 'ReleaseList');
const ReleaseForm = screen(() => import('./screens/ReleaseForm.tsx'), 'ReleaseForm');
const ReleaseDetail = screen(() => import('./screens/ReleaseDetail.tsx'), 'ReleaseDetail');
const MyData = screen(() => import('./screens/MyData.tsx'), 'MyData');
const MyDataView = screen(() => import('./screens/MyDataView.tsx'), 'MyDataView');
const Partners = screen(() => import('./screens/Partners.tsx'), 'Partners');
const Catalog = screen(() => import('./screens/Catalog.tsx'), 'Catalog');
const PartnerCatalog = screen(() => import('./screens/PartnerCatalog.tsx'), 'PartnerCatalog');
const ReceivedList = screen(() => import('./screens/ReceivedList.tsx'), 'ReceivedList');
const ReceivedDetail = screen(() => import('./screens/ReceivedDetail.tsx'), 'ReceivedDetail');
const Audit = screen(() => import('./screens/Audit.tsx'), 'Audit');
const Users = screen(() => import('./screens/Users.tsx'), 'Users');
const System = screen(() => import('./screens/System.tsx'), 'System');
const Account = screen(() => import('./screens/Account.tsx'), 'Account');
const NotFound = screen(() => import('./screens/NotFound.tsx'), 'NotFound');

function guard(routes: readonly RouteId[], el: ReactNode) {
  return <RequireAccess routes={routes}>{el}</RequireAccess>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/anmelden" element={<AfterSignIn />} />
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="athleten" element={guard(['athletes.list'], <AthleteList />)} />
        <Route path="athleten/neu" element={guard(['athletes.create'], <AthleteForm />)} />
        <Route path="athleten/:id" element={guard(['athletes.get'], <AthleteDetail />)} />
        <Route path="athleten/:id/bearbeiten" element={guard(['athletes.update'], <AthleteForm />)} />
        <Route path="quellen" element={guard(['connectors.list'], <ConnectorList />)} />
        <Route path="quellen/neu" element={guard(['connectors.create'], <ConnectorForm />)} />
        <Route path="quellen/:id" element={guard(['connectors.get'], <ConnectorDetail />)} />
        <Route path="quellen/:id/bearbeiten" element={guard(['connectors.update'], <ConnectorForm />)} />
        <Route path="importe/:id" element={guard(['imports.get'], <ImportRunView />)} />
        <Route path="datensaetze" element={guard(['datasets.list'], <DatasetList />)} />
        <Route path="datensaetze/neu" element={guard(['datasets.create'], <DatasetForm />)} />
        <Route path="datensaetze/:id" element={guard(['datasets.get'], <DatasetDetail />)} />
        <Route path="datensaetze/:id/bearbeiten" element={guard(['datasets.update'], <DatasetForm />)} />
        <Route path="produkte" element={guard(['products.list'], <ProductList />)} />
        <Route path="produkte/neu" element={guard(['products.create'], <ProductForm />)} />
        <Route path="produkte/:id" element={guard(['products.get'], <ProductDetail />)} />
        <Route path="produkte/:id/bearbeiten" element={guard(['products.update'], <ProductForm />)} />
        <Route path="freigaben" element={guard(['releases.list'], <ReleaseList />)} />
        <Route path="freigaben/neu" element={guard(['releases.create'], <ReleaseForm />)} />
        <Route path="freigaben/:id" element={guard(['releases.get'], <ReleaseDetail />)} />
        <Route path="meine-daten" element={guard(['access.list'], <MyData />)} />
        <Route path="meine-daten/:id" element={guard(['access.data'], <MyDataView />)} />
        <Route path="partner" element={guard(['peers.list'], <Partners />)} />
        <Route path="katalog" element={guard(['catalog.local'], <Catalog />)} />
        <Route path="katalog/partner" element={guard(['discovery.search'], <PartnerCatalog />)} />
        <Route path="empfangen" element={guard(['received.list'], <ReceivedList />)} />
        <Route path="empfangen/:id" element={guard(['received.get'], <ReceivedDetail />)} />
        <Route path="audit" element={guard(['audit.list', 'exchange.log'], <Audit />)} />
        <Route path="benutzer" element={guard(['users.list'], <Users />)} />
        <Route path="system" element={guard(['system.status'], <System />)} />
        <Route path="konto" element={<Account />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/** Nach der Anmeldung zum ursprünglichen Ziel weiterleiten (nur interne Pfade). */
function AfterSignIn() {
  const [params] = useSearchParams();
  const next = params.get('weiter');
  const target = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
  return <Navigate to={target} replace />;
}

function RedirectToSignIn() {
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  const to =
    here === '/' || here.startsWith('/anmelden')
      ? '/anmelden'
      : `/anmelden?weiter=${encodeURIComponent(here)}`;
  return <Navigate to={to} replace />;
}

function AuthGate() {
  const me = useMe();
  const { t, applyUserLocale } = useI18n();
  const locale = me.data?.user.locale;

  useEffect(() => {
    if (locale) applyUserLocale(locale);
  }, [locale, applyUserLocale]);

  if (me.isPending) {
    return (
      <div className="center-page">
        <Loading label={t('shell.loadingApp')} />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="center-page">
        <div className="auth-card">
          <h1>{t('shell.startFailed')}</h1>
          <ErrorMessage error={me.error} onRetry={() => void me.refetch()} />
        </div>
      </div>
    );
  }
  if (!me.data) {
    return (
      <Routes>
        <Route path="/anmelden" element={<SignIn />} />
        <Route path="*" element={<RedirectToSignIn />} />
      </Routes>
    );
  }
  if (me.data.user.mustChangePassword) {
    return <ForcePasswordChange me={me.data} />;
  }
  return (
    <SessionProvider me={me.data}>
      <Suspense fallback={<Loading />}>
        <AppRoutes />
      </Suspense>
    </SessionProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <BrowserRouter>
            <AuthGate />
          </BrowserRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
