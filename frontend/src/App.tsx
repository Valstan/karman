import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import ThemeApplier from './components/ThemeApplier';
import ThemeSelector from './components/ThemeSelector';

const { Header, Content, Footer } = Layout;
const { Title } = Typography;

type DashboardSummary = {
  credits: {
    total: number;
    active: number;
    overdue: number;
  };
  payments: {
    total: number;
    scheduled: number;
    overdue: number;
    paid: number;
  };
};

type BankRow = {
  id: number;
  name: string;
  website: string | null;
  address: string | null;
  phone: string | null;
};

type CreditRow = {
  id: number;
  name: string;
  raw_name: string;
  bank_id: number;
  bank_name: string;
  bank_website: string | null;
  amount: string;
  interest_rate: string;
  monthly_payment: string | null;
  payment_type: string;
  start_date: string;
  status: string;
  term_months: number;
  description: string | null;
};

type PaymentRow = {
  id: number;
  credit_id: number;
  credit_name: string;
  bank_name: string;
  amount: string;
  principal_amount: string | null;
  interest_amount: string | null;
  due_date: string;
  paid_date: string | null;
  status: string;
};

type DocumentRow = {
  id: number;
  title: string;
  document_type: string;
  document_number: string;
  issue_date: string | null;
  expiry_date: string | null;
  issuing_authority: string | null;
  is_active: boolean;
};

type AuthUser = {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  is_superuser: boolean;
};

type CreditFormValues = {
  name: string;
  bank_id: number;
  amount: string;
  interest_rate: string;
  monthly_payment?: string;
  start_date: string;
  term_months: string;
  status: string;
  payment_type: string;
  description?: string;
};

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  overdue: 'red',
  scheduled: 'blue',
  paid: 'gold',
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Запланирован',
  overdue: 'Просрочен',
  paid: 'Оплачен',
};

const CREDIT_STATUS_LABELS: Record<string, string> = {
  active: 'Активный',
  overdue: 'Просрочен',
  closed: 'Закрыт',
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers || {});
  headers.set('Accept', 'application/json');
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers,
  });

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const messageFromPayload =
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message?: unknown }).message || '')
        : typeof payload === 'string'
          ? payload
          : '';
    throw new ApiError(response.status, messageFromPayload || `HTTP ${response.status}`);
  }

  return payload as T;
}

const DashboardPage: React.FC<{ loading: boolean; data: DashboardSummary | null }> = ({ loading, data }) => {
  return (
    <Card title="Панель управления">
      {loading && !data ? (
        <Spin />
      ) : data ? (
        <>
          <p>Всего кредитов: {data.credits.total}</p>
          <p>Активных кредитов: {data.credits.active}</p>
          <p>Просроченных кредитов: {data.credits.overdue}</p>
          <p>Всего платежей: {data.payments.total}</p>
          <p>Запланированных платежей: {data.payments.scheduled}</p>
          <p>Просроченных платежей: {data.payments.overdue}</p>
          <p>Оплаченных платежей: {data.payments.paid}</p>
        </>
      ) : (
        <Alert type="warning" message="Данные панели пока недоступны" />
      )}
    </Card>
  );
};

const BanksPage: React.FC<{ loading: boolean; banks: BankRow[] }> = ({ loading, banks }) => (
  <Card title={`МКК и банки (${banks.length})`}>
    <Table
      rowKey="id"
      loading={loading}
      dataSource={banks}
      pagination={{ pageSize: 25 }}
      columns={[
        { title: 'Наименование', dataIndex: 'name' },
        {
          title: 'Сайт',
          dataIndex: 'website',
          render: (value: string | null) =>
            value ? (
              <a href={value} target="_blank" rel="noopener noreferrer">
                {value}
              </a>
            ) : (
              'Не указан'
            ),
        },
        { title: 'Телефон', dataIndex: 'phone', render: (value: string | null) => value || '—' },
      ]}
    />
  </Card>
);

const CreditsPage: React.FC<{
  loading: boolean;
  credits: CreditRow[];
  banks: BankRow[];
  onReload: () => Promise<void>;
}> = ({ loading, credits, banks, onReload }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingCredit, setEditingCredit] = useState<CreditRow | null>(null);
  const [form] = Form.useForm<CreditFormValues>();

  const openCreateModal = () => {
    setEditingCredit(null);
    form.setFieldsValue({
      name: '',
      bank_id: banks[0]?.id,
      amount: '0',
      interest_rate: '0',
      start_date: new Date().toISOString().slice(0, 10),
      term_months: '1',
      status: 'active',
      payment_type: 'annuity',
      monthly_payment: '',
      description: '',
    });
    setModalOpen(true);
  };

  const openEditModal = (credit: CreditRow) => {
    setEditingCredit(credit);
    form.setFieldsValue({
      name: credit.raw_name || '',
      bank_id: credit.bank_id,
      amount: credit.amount,
      interest_rate: credit.interest_rate,
      monthly_payment: credit.monthly_payment || '',
      start_date: credit.start_date,
      term_months: String(credit.term_months),
      status: credit.status || 'active',
      payment_type: credit.payment_type || 'annuity',
      description: credit.description || '',
    });
    setModalOpen(true);
  };

  const onSave = async (values: CreditFormValues) => {
    try {
      setSaving(true);
      const payload = {
        ...values,
        bank_id: Number(values.bank_id),
        amount: values.amount,
        interest_rate: values.interest_rate,
        term_months: values.term_months,
        monthly_payment: values.monthly_payment || null,
      };

      if (editingCredit) {
        await apiRequest(`/api/v1/credits/credits/${editingCredit.id}/`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        message.success('Кредит обновлен');
      } else {
        await apiRequest('/api/v1/credits/credits/', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        message.success('Кредит добавлен');
      }

      setModalOpen(false);
      await onReload();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось сохранить кредит');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={`Кредиты (${credits.length})`}
      extra={
        <Space>
          <Button onClick={() => void onReload()}>Обновить</Button>
          <Button type="primary" onClick={openCreateModal} disabled={banks.length === 0}>
            Добавить кредит
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={credits}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Кредит', dataIndex: 'name' },
          { title: 'Банк', dataIndex: 'bank_name' },
          { title: 'Сумма', dataIndex: 'amount' },
          { title: 'Ставка %', dataIndex: 'interest_rate' },
          { title: 'Старт', dataIndex: 'start_date' },
          {
            title: 'Статус',
            dataIndex: 'status',
            render: (status: string) => (
              <Tag color={STATUS_COLORS[status] || 'default'}>{CREDIT_STATUS_LABELS[status] || status}</Tag>
            ),
          },
          {
            title: 'Действия',
            key: 'actions',
            render: (_, credit: CreditRow) => (
              <Button size="small" onClick={() => openEditModal(credit)}>
                Редактировать
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title={editingCredit ? 'Редактировать кредит' : 'Добавить кредит'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void form.submit()}
        confirmLoading={saving}
        okText="Сохранить"
        cancelText="Отмена"
      >
        <Form form={form} layout="vertical" onFinish={onSave}>
          <Form.Item label="Название кредита" name="name">
            <Input placeholder="Оставьте пустым для названия банка" />
          </Form.Item>

          <Form.Item label="Банк" name="bank_id" rules={[{ required: true }]}>
            <Select
              options={banks.map((bank) => ({
                value: bank.id,
                label: bank.name,
              }))}
            />
          </Form.Item>

          <Form.Item label="Сумма" name="amount" rules={[{ required: true }]}>
            <Input />
          </Form.Item>

          <Form.Item label="Процентная ставка" name="interest_rate" rules={[{ required: true }]}>
            <Input />
          </Form.Item>

          <Form.Item label="Ежемесячный платеж" name="monthly_payment">
            <Input />
          </Form.Item>

          <Form.Item label="Дата начала" name="start_date" rules={[{ required: true }]}>
            <Input type="date" />
          </Form.Item>

          <Form.Item label="Срок (месяцев)" name="term_months" rules={[{ required: true }]}>
            <Input />
          </Form.Item>

          <Form.Item label="Статус" name="status" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'active', label: 'Активный' },
                { value: 'overdue', label: 'Просрочен' },
                { value: 'closed', label: 'Закрыт' },
              ]}
            />
          </Form.Item>

          <Form.Item label="Тип платежа" name="payment_type" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'annuity', label: 'Аннуитетный' },
                { value: 'differentiated', label: 'Дифференцированный' },
                { value: 'other', label: 'Другой' },
              ]}
            />
          </Form.Item>

          <Form.Item label="Описание" name="description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

const PaymentsPage: React.FC<{
  loading: boolean;
  payments: PaymentRow[];
  onReload: () => Promise<void>;
}> = ({ loading, payments, onReload }) => {
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const updatePaymentStatus = async (paymentId: number, status: string) => {
    try {
      setUpdatingId(paymentId);
      const payload: Record<string, string> = { status };
      if (status === 'paid') {
        payload.paid_date = new Date().toISOString().slice(0, 10);
      }
      await apiRequest(`/api/v1/credits/payments/${paymentId}/`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      message.success('Статус платежа обновлен');
      await onReload();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось обновить платеж');
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <Card
      title={`Платежи (${payments.length})`}
      extra={
        <Button onClick={() => void onReload()}>
          Обновить
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={payments}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Кредит', dataIndex: 'credit_name' },
          { title: 'Банк', dataIndex: 'bank_name' },
          { title: 'Сумма', dataIndex: 'amount' },
          { title: 'Срок платежа', dataIndex: 'due_date' },
          { title: 'Дата оплаты', dataIndex: 'paid_date', render: (value: string | null) => value || '—' },
          {
            title: 'Статус',
            dataIndex: 'status',
            render: (status: string) => (
              <Tag color={STATUS_COLORS[status] || 'default'}>{PAYMENT_STATUS_LABELS[status] || status}</Tag>
            ),
          },
          {
            title: 'Действия',
            key: 'actions',
            render: (_, payment: PaymentRow) => (
              <Space>
                <Button
                  size="small"
                  loading={updatingId === payment.id}
                  onClick={() => void updatePaymentStatus(payment.id, 'paid')}
                >
                  Оплачен
                </Button>
                <Button
                  size="small"
                  loading={updatingId === payment.id}
                  onClick={() => void updatePaymentStatus(payment.id, 'scheduled')}
                >
                  Scheduled
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
};

const DocumentsPage: React.FC<{ loading: boolean; documents: DocumentRow[] }> = ({ loading, documents }) => (
  <Card title={`Документы (${documents.length})`}>
    <Table
      rowKey="id"
      loading={loading}
      dataSource={documents}
      pagination={{ pageSize: 20 }}
      columns={[
        { title: 'Название', dataIndex: 'title' },
        { title: 'Тип', dataIndex: 'document_type' },
        { title: 'Номер', dataIndex: 'document_number' },
        { title: 'Дата выдачи', dataIndex: 'issue_date', render: (value: string | null) => value || '—' },
        { title: 'Истекает', dataIndex: 'expiry_date', render: (value: string | null) => value || '—' },
        {
          title: 'Активен',
          dataIndex: 'is_active',
          render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? 'Да' : 'Нет'}</Tag>,
        },
      ]}
    />
  </Card>
);

const LoginPage: React.FC<{ onLoggedIn: () => Promise<AuthUser | null> }> = ({ onLoggedIn }) => {
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    try {
      setLoading(true);
      if (!values.username || !values.password) {
        throw new Error('Неверный логин или пароль');
      }
      await apiRequest<{ user: AuthUser }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      await onLoggedIn();
      message.success('Вход выполнен');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Вход" style={{ maxWidth: 420, margin: '40px auto' }}>
      <Form layout="vertical" onFinish={onFinish}>
        <Form.Item label="Логин" name="username" rules={[{ required: true }]}>
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item label="Пароль" name="password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} block>
          Войти
        </Button>
      </Form>
    </Card>
  );
};

const Shell: React.FC = () => {
  const { currentTheme } = useTheme();
  const location = useLocation();
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [credits, setCredits] = useState<CreditRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const authOk = currentUser !== null;

  const refreshAuth = useCallback(async () => {
    try {
      const user = await apiRequest<AuthUser>('/api/v1/auth/me');
      setCurrentUser(user);
      return user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCurrentUser(null);
        return null;
      }
      throw error;
    }
  }, []);

  const loadAllData = useCallback(async () => {
    if (!authOk) {
      return;
    }
    setLoadingData(true);
    setLoadError(null);
    try {
      const [banksData, creditsData, paymentsData, documentsData, summaryData] = await Promise.all([
        apiRequest<BankRow[]>('/api/v1/credits/banks/'),
        apiRequest<CreditRow[]>('/api/v1/credits/credits/'),
        apiRequest<PaymentRow[]>('/api/v1/credits/payments/'),
        apiRequest<DocumentRow[]>('/api/v1/documents/'),
        apiRequest<DashboardSummary>('/api/v1/dashboard/summary/'),
      ]);
      setBanks(banksData);
      setCredits(creditsData);
      setPayments(paymentsData);
      setDocuments(documentsData);
      setSummary(summaryData);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCurrentUser(null);
        setBanks([]);
        setCredits([]);
        setPayments([]);
        setDocuments([]);
        setSummary(null);
        return;
      }
      setLoadError((error as Error).message || 'Ошибка загрузки данных');
    } finally {
      setLoadingData(false);
    }
  }, [authOk]);

  useEffect(() => {
    let active = true;
    const bootstrapAuth = async () => {
      setAuthLoading(true);
      try {
        await refreshAuth();
      } catch (error) {
        if (active) {
          setLoadError((error as Error).message || 'Ошибка проверки авторизации');
        }
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    };
    void bootstrapAuth();
    return () => {
      active = false;
    };
  }, [refreshAuth]);

  useEffect(() => {
    if (authOk) {
      void loadAllData();
    }
  }, [authOk, loadAllData]);

  const logout = async () => {
    try {
      await apiRequest<{ status: string }>('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Best-effort logout.
    } finally {
      setCurrentUser(null);
      setBanks([]);
      setCredits([]);
      setPayments([]);
      setDocuments([]);
      setSummary(null);
    }
  };

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
              KARMAN SPA
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
            selectedKeys={[location.pathname]}
            items={[
              { key: '/dashboard', label: <Link to="/dashboard">Панель</Link> },
              { key: '/credits', label: <Link to="/credits">Кредиты</Link> },
              { key: '/payments', label: <Link to="/payments">Платежи</Link> },
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
              element={<CreditsPage loading={loadingData} credits={credits} banks={banks} onReload={loadAllData} />}
            />
            <Route path="/payments" element={<PaymentsPage loading={loadingData} payments={payments} onReload={loadAllData} />} />
            <Route path="/banks" element={<BanksPage loading={loadingData} banks={banks} />} />
            <Route path="/documents" element={<DocumentsPage loading={loadingData} documents={documents} />} />
            <Route path="/login" element={authOk ? <Navigate to="/dashboard" replace /> : <LoginPage onLoggedIn={refreshAuth} />} />
            <Route path="*" element={<Navigate to={authOk ? '/dashboard' : '/login'} replace />} />
          </Routes>
        </Content>
        <Footer style={{ textAlign: 'center' }}>KARMAN SPA</Footer>
      </Layout>
    </ConfigProvider>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </ThemeProvider>
  );
};

export default App;
