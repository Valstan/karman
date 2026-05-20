import React, { useState } from 'react';
import { Button, Popconfirm, Space, Table, Tag, message } from 'antd';
import { apiRequest } from '../api/client';
import type { PaymentRow } from '../types';
import { PAYMENT_STATUS_LABELS, paymentRowColorByDate, paymentStatusColor } from '../utils/status';
import { daysUntil, formatDate, formatMoney, todayISO } from '../utils/format';

type Props = {
  payments: PaymentRow[];
  onReload: () => Promise<void> | void;
  onEdit: (payment: PaymentRow) => void;
};

const PaymentScheduleTable: React.FC<Props> = ({ payments, onReload, onEdit }) => {
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const setPaid = async (payment: PaymentRow) => {
    try {
      setUpdatingId(payment.id);
      await apiRequest(`/api/v1/credits/payments/${payment.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'paid', paid_date: todayISO() }),
      });
      message.success('Платёж отмечен оплаченным');
      await onReload();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось обновить платёж');
    } finally {
      setUpdatingId(null);
    }
  };

  const setScheduled = async (payment: PaymentRow) => {
    try {
      setUpdatingId(payment.id);
      await apiRequest(`/api/v1/credits/payments/${payment.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'scheduled' }),
      });
      message.success('Платёж возвращён в запланированные');
      await onReload();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось обновить платёж');
    } finally {
      setUpdatingId(null);
    }
  };

  const remove = async (payment: PaymentRow) => {
    try {
      setUpdatingId(payment.id);
      await apiRequest(`/api/v1/credits/payments/${payment.id}/`, { method: 'DELETE' });
      message.success('Платёж удалён');
      await onReload();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось удалить платёж');
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <Table
      rowKey="id"
      size="middle"
      dataSource={payments}
      pagination={false}
      onRow={(payment) => {
        const days = daysUntil(payment.due_date);
        const background = paymentRowColorByDate(days, payment.status);
        return background ? { style: { background } } : {};
      }}
      columns={[
        {
          title: '№',
          render: (_value, _record, index) => index + 1,
          width: 50,
        },
        {
          title: 'Срок',
          dataIndex: 'due_date',
          render: (value: string) => formatDate(value),
        },
        {
          title: 'Сумма, ₽',
          dataIndex: 'amount',
          align: 'right' as const,
          render: (value: string) => <strong>{formatMoney(value)}</strong>,
        },
        {
          title: 'Осн. долг',
          dataIndex: 'principal_amount',
          align: 'right' as const,
          render: (value: string | null) => formatMoney(value),
        },
        {
          title: 'Проценты',
          dataIndex: 'interest_amount',
          align: 'right' as const,
          render: (value: string | null) => formatMoney(value),
        },
        {
          title: 'Оплачен',
          dataIndex: 'paid_date',
          render: (value: string | null) => formatDate(value),
        },
        {
          title: 'Статус',
          dataIndex: 'status',
          render: (status: string) => (
            <Tag color={paymentStatusColor(status)}>{PAYMENT_STATUS_LABELS[status] || status}</Tag>
          ),
        },
        {
          title: 'Действия',
          key: 'actions',
          render: (_value, payment: PaymentRow) => (
            <Space size="small" wrap>
              {payment.status !== 'paid' ? (
                <Button
                  size="small"
                  type="primary"
                  loading={updatingId === payment.id}
                  onClick={() => void setPaid(payment)}
                >
                  Оплачен
                </Button>
              ) : (
                <Button
                  size="small"
                  loading={updatingId === payment.id}
                  onClick={() => void setScheduled(payment)}
                >
                  Вернуть
                </Button>
              )}
              <Button size="small" onClick={() => onEdit(payment)}>
                Изменить
              </Button>
              <Popconfirm
                title="Удалить платёж?"
                okText="Удалить"
                cancelText="Отмена"
                onConfirm={() => void remove(payment)}
              >
                <Button size="small" danger loading={updatingId === payment.id}>
                  Удалить
                </Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]}
    />
  );
};

export default PaymentScheduleTable;
