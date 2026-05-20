import React from 'react';
import { Card, Empty, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import type { UpcomingPayment } from '../types';
import { PAYMENT_STATUS_LABELS, paymentStatusColor } from '../utils/status';
import { daysUntil, formatDate, formatMoney } from '../utils/format';

type Props = {
  loading: boolean;
  payments: UpcomingPayment[];
};

const UpcomingPaymentsList: React.FC<Props> = ({ loading, payments }) => (
  <Card title={`Ближайшие платежи (${payments.length})`} size="small">
    {payments.length === 0 && !loading ? (
      <Empty description="Нет платежей на ближайшие 30 дней" image={Empty.PRESENTED_IMAGE_SIMPLE} />
    ) : (
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={payments}
        pagination={false}
        columns={[
          {
            title: 'Срок',
            dataIndex: 'due_date',
            render: (value: string) => {
              const days = daysUntil(value);
              const label =
                days === null
                  ? formatDate(value)
                  : days < 0
                    ? `${formatDate(value)} (просрочен на ${Math.abs(days)} дн.)`
                    : days === 0
                      ? `${formatDate(value)} (сегодня)`
                      : `${formatDate(value)} (через ${days} дн.)`;
              return (
                <span style={{ color: days !== null && days < 0 ? '#ff4d4f' : undefined }}>
                  {label}
                </span>
              );
            },
          },
          {
            title: 'Кредит',
            dataIndex: 'credit_name',
            render: (value: string, payment: UpcomingPayment) => (
              <Link to={`/credits/${payment.credit_id}`}>{value}</Link>
            ),
          },
          { title: 'Банк', dataIndex: 'bank_name' },
          {
            title: 'Сумма, ₽',
            dataIndex: 'amount',
            align: 'right' as const,
            render: (value: string) => formatMoney(value),
          },
          {
            title: 'Статус',
            dataIndex: 'status',
            render: (status: string) => (
              <Tag color={paymentStatusColor(status)}>{PAYMENT_STATUS_LABELS[status] || status}</Tag>
            ),
          },
        ]}
      />
    )}
  </Card>
);

export default UpcomingPaymentsList;
