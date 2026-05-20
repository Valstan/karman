import React from 'react';
import { Alert, Button, ConfigProvider, Layout, Menu, Space, Spin, Typography } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import ThemeApplier from './components/ThemeApplier';
import ThemeSelector from './components/ThemeSelector';
import { useAppData } from './hooks/useAppData';
import DashboardPage from './pages/DashboardPage';
import CreditsListPage from './pages/CreditsListPage';
import CreditDetailPage from './pages/CreditDetailPage';
import BanksPage from './pages/BanksPage';
import DocumentsPage from './pages/DocumentsPage';
import LoginPage from './pages/LoginPage';

const { Header, Content, Footer } = Layout;
const { Title } = Typography;

const Shell: React.FC = () => {
  const { currentTheme } = useTheme();
  const location = useLocation();
  const {
    currentUser,
    authLoading,
    banks,
    credits,
    documents,
    summary,
    loadingData,
    loadError,
    refreshAuth,
    loadAllData,
    logout,
  } = useAppData();

  const authOk = currentUser !== null;

  if (authLoading) {
    return (
      <Layout style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </Layout>
    );
  }

  if (!authOk && location.pathname !== '/login') {
    return <Navigate to="/login" replace />;
  }

  const selectedKey = location.pathname.startsWith('/credits') ? '/credits' : location.pathname;

  return (
    <ConfigProvider
      locale={ruRU}
      theme={{
        token: {
          colorPrimary: currentTheme.colors.primary,
          colorSuccess: currentTheme.colors.success,
          colorWarning: currentTheme.colors.warning,
          colorError: currentTheme.colors.error,
          colorBgBase: currentTheme.colors.background,
          colorTextBase: currentTheme.colors.text,
          colorBorder: currentTheme.colors.border,
        },
      }}
    >
      <ThemeApplier />
      <Layout style={{ minHeight: '100vh', backgroundColor: currentTheme.colors.background }}>
        <Header style={{ background: '#0b2a5a', padding: '0 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '100%' }}>
            <Title level={3} style={{ margin: 0, lineHeight: '64px', color: '#ffffff' }}>
              KARMAN
            </Title>
            <Space>
              {authOk && (
                <>
                  <Button onClick={() => void loadAllData()}>Обновить</Button>
                  <Button onClick={() => void logout()}>Выйти</Button>
                </>
              )}
              {currentUser && <span style={{ color: '#fff' }}>{currentUser.username}</span>}
              <ThemeSelector />
            </Space>
          </div>
        </Header>
        {authOk && (
          <Menu
            theme="dark"
            mode="horizontal"
            style={{ background: '#0b2a5a', color: '#ffffff' }}
            selectedKeys={[selectedKey]}
            items={[
              { key: '/dashboard', label: <Link to="/dashboard">Панель</Link> },
              { key: '/credits', label: <Link to="/credits">Кредиты</Link> },
              { key: '/banks', label: <Link to="/banks">Банки</Link> },
              { key: '/documents', label: <Link to="/documents">Документы</Link> },
            ]}
          />
        )}
        <Content style={{ padding: '24px' }}>
          {loadError && <Alert type="error" message={loadError} style={{ marginBottom: 16 }} />}
          <Routes>
            <Route path="/" element={<Navigate to={authOk ? '/dashboard' : '/login'} replace />} />
            <Route path="/dashboard" element={<DashboardPage loading={loadingData} data={summary} />} />
            <Route
              path="/credits"
              element={
                <CreditsListPage
                  loading={loadingData}
                  credits={credits}
                  banks={banks}
                  onReload={loadAllData}
                />
              }
            />
            <Route
              path="/credits/:id"
              element={<CreditDetailPage banks={banks} onMutate={loadAllData} />}
            />
            <Route path="/banks" element={<BanksPage loading={loadingData} banks={banks} />} />
            <Route path="/documents" element={<DocumentsPage loading={loadingData} documents={documents} />} />
            <Route
              path="/login"
              element={authOk ? <Navigate to="/dashboard" replace /> : <LoginPage onLoggedIn={refreshAuth} />}
            />
            <Route path="*" element={<Navigate to={authOk ? '/dashboard' : '/login'} replace />} />
          </Routes>
        </Content>
        <Footer style={{ textAlign: 'center' }}>KARMAN — учёт кредитов</Footer>
      </Layout>
    </ConfigProvider>
  );
};

const App: React.FC = () => (
  <ThemeProvider>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </ThemeProvider>
);

export default App;
