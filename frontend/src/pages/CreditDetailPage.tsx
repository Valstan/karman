import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Popconfirm, Progress, Row, Space, Spin, Statistic, Tag, Typography, message } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiRequest } from '../api/client';
import type { BankRow, CreditDetail, PaymentRow } from '../types';
import { CREDIT_STATUS_LABELS, creditStatusColor } from '../utils/status';
import { formatDate, formatMoney, progressPercent } from '../utils/format';
import PaymentScheduleTable from '../components/PaymentScheduleTable';
import CreditFormModal from '../components/CreditFormModal';
import PaymentFormModal from '../components/PaymentFormModal';

type Props = {
  banks: BankRow[];
  onMutate: () => Promise<void>;
};

const CreditDetailPage: React.FC<Props> = ({ banks, onMutate }) => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const creditId = Number(id);

  const [credit, setCredit] = useState<CreditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editCreditOpen, setEditCreditOpen] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PaymentRow | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(creditId)) {
      setError('Некорректный ID кредита');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<CreditDetail>(`/api/v1/credits/credits/${creditId}/`);
      setCredit(data);
    } catch (e) {
      setError((e as Error).message || 'Не удалось загрузить кредит');
      setCredit(null);
    } finally {
      setLoading(false);
    }
  }, [creditId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadAll = useCallback(async () => {
    await load();
    await onMutate();
  }, [load, onMutate]);

  const removeCredit = async () => {
    try {
      await apiRequest(`/api/v1/credits/credits/${creditId}/`, { method: 'DELETE' });
      message.success('Кредит удалён');
      await onMutate();
      navigate('/credits');
    } catch (e) {
      message.error((e as Error).message || 'Не удалось удалить кредит');
    }
  };

  if (loading && !credit) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error || !credit) {
    return (
      <Card title="Кредит">
        <Alert type="error" message={error || 'Кредит не найден'} />
        <Link to="/credits" style={{ marginTop: 16, display: 'inline-block' }}>
          ← Назад к списку
        </Link>
      </Card>
    );
  }

  const paid = Number(credit.aggregates.paid_amount);
  const remaining = Number(credit.aggregates.remaining_amount);
  const scheduleTotal = paid + remaining;
  const progress = progressPercent(paid, scheduleTotal);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <Link to="/credits" style={{ color: 'inherit' }}>
              ← Кредиты
            </Link>
            <span>/</span>
            <span>{credit.name}</span>
          </Space>
        }
        extra={
          <Space>
            <Tag color={creditStatusColor(credit.status)}>
              {CREDIT_STATUS_LABELS[credit.status] || credit.status}
            </Tag>
            <Button onClick={() => setEditCreditOpen(true)}>Редактировать</Button>
            <Popconfirm
              title="Удалить кредит вместе со всеми платежами?"
              okText="Удалить"
              cancelText="Отмена"
              onConfirm={() => void removeCredit()}
            >
              <Button danger>Удалить</Button>
            </Popconfirm>
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={16}>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
              <Descriptions.Item label="Банк">{credit.bank_name}</Descriptions.Item>
              <Descriptions.Item label="Тип платежа">{credit.payment_type}</Descriptions.Item>
              <Descriptions.Item label="Сумма">{formatMoney(credit.amount)} ₽</Descriptions.Item>
              <Descriptions.Item label="Ставка">{credit.interest_rate}%</Descriptions.Item>
              <Descriptions.Item label="Срок">{credit.term_months} мес.</Descriptions.Item>
              <Descriptions.Item label="Старт">{formatDate(credit.start_date)}</Descriptions.Item>
              <Descriptions.Item label="Ежемесячный платёж">
                {credit.monthly_payment ? `${formatMoney(credit.monthly_payment)} ₽` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Описание" span={2}>
                {credit.description || '—'}
              </Descriptions.Item>
            </Descriptions>
          </Col>
          <Col xs={24} md={8}>
            <Card size="small">
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Statistic title="Выплачено" value={formatMoney(credit.aggregates.paid_amount)} suffix="₽" />
                <Statistic title="Осталось" value={formatMoney(credit.aggregates.remaining_amount)} suffix="₽" />
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Прогресс выплат
                  </Typography.Text>
                  <Progress
                    percent={Math.round(progress)}
                    status={credit.aggregates.payments_overdue > 0 ? 'exception' : 'active'}
                  />
                </div>
                <Space size="small" wrap>
                  <Tag color="green">Оплачено: {credit.aggregates.payments_paid}</Tag>
                  <Tag color="blue">Запланировано: {credit.aggregates.payments_scheduled}</Tag>
                  {credit.aggregates.payments_overdue > 0 && (
                    <Tag color="red">Просрочено: {credit.aggregates.payments_overdue}</Tag>
                  )}
                </Space>
              </Space>
            </Card>
          </Col>
        </Row>
      </Card>

      <Card
        title={`График платежей (${credit.payments.length})`}
        extra={
          <Button
            type="primary"
            onClick={() => {
              setEditingPayment(null);
              setPaymentModalOpen(true);
            }}
          >
            Добавить платёж
          </Button>
        }
      >
        {credit.payments.length === 0 ? (
          <Alert
            type="info"
            message="Платежи пока не добавлены"
            description={'Нажмите «Добавить платёж», чтобы внести запланированный или уже совершённый платёж.'}
            showIcon
          />
        ) : (
          <PaymentScheduleTable
            payments={credit.payments}
            onReload={reloadAll}
            onEdit={(payment) => {
              setEditingPayment(payment);
              setPaymentModalOpen(true);
            }}
          />
        )}
      </Card>

      <CreditFormModal
        open={editCreditOpen}
        banks={banks}
        editingCredit={credit}
        onCancel={() => setEditCreditOpen(false)}
        onSaved={reloadAll}
      />

      <PaymentFormModal
        open={paymentModalOpen}
        creditId={creditId}
        editingPayment={editingPayment}
        onCancel={() => {
          setPaymentModalOpen(false);
          setEditingPayment(null);
        }}
        onSaved={reloadAll}
      />
    </Space>
  );
};

export default CreditDetailPage;
