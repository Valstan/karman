import React from 'react';
import { Alert, Col, Empty, Row, Spin, Statistic, Card } from 'antd';
import type { DashboardSummary } from '../types';
import CreditCard from '../components/CreditCard';
import UpcomingPaymentsList from '../components/UpcomingPaymentsList';
import { formatMoney } from '../utils/format';

type Props = {
  loading: boolean;
  data: DashboardSummary | null;
};

const DashboardPage: React.FC<Props> = ({ loading, data }) => {
  if (loading && !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!data) {
    return <Alert type="warning" message="Данные панели пока недоступны" />;
  }

  return (
    <div>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Активные кредиты" value={data.credits.active} suffix={`/ ${data.credits.total}`} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Просроченные кредиты"
              value={data.credits.overdue}
              valueStyle={{ color: data.credits.overdue > 0 ? '#ff4d4f' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Выплачено, ₽"
              value={formatMoney(data.payments.paid_amount)}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Осталось выплатить, ₽" value={formatMoney(data.payments.remaining_amount)} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title={`Активные кредиты (${data.active_credits.length})`} bodyStyle={{ padding: 16 }}>
            {data.active_credits.length === 0 ? (
              <Empty description="Активных кредитов нет" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Row gutter={[16, 16]}>
                {data.active_credits.map((credit) => (
                  <Col key={credit.id} xs={24} md={12}>
                    <CreditCard credit={credit} />
                  </Col>
                ))}
              </Row>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <UpcomingPaymentsList loading={loading} payments={data.upcoming_payments} />
        </Col>
      </Row>
    </div>
  );
};

export default DashboardPage;
