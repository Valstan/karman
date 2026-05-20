import React from 'react';
import { Card, Progress, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import type { ActiveCreditCard } from '../types';
import { creditStatusColor, paymentStatusColor, CREDIT_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../utils/status';
import { formatDate, formatMoney, daysUntil, progressPercent } from '../utils/format';

type Props = {
  credit: ActiveCreditCard;
};

const CreditCard: React.FC<Props> = ({ credit }) => {
  const paid = Number(credit.paid_amount);
  const remaining = Number(credit.remaining_amount);
  const totalProgress = paid + remaining;
  const progress = progressPercent(paid, totalProgress);

  const nextDays = credit.next_payment ? daysUntil(credit.next_payment.due_date) : null;
  const nextLabel =
    credit.next_payment === null
      ? 'Нет запланированных'
      : nextDays === null
        ? formatDate(credit.next_payment.due_date)
        : nextDays < 0
          ? `просрочен на ${Math.abs(nextDays)} дн.`
          : nextDays === 0
            ? 'сегодня'
            : `через ${nextDays} дн.`;

  return (
    <Card
      hoverable
      title={
        <Link to={`/credits/${credit.id}`} style={{ color: 'inherit' }}>
          {credit.name}
        </Link>
      }
      extra={<Tag color={creditStatusColor(credit.status)}>{CREDIT_STATUS_LABELS[credit.status] || credit.status}</Tag>}
      style={{ height: '100%' }}
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{credit.bank_name}</Typography.Text>

        <Space size="small" wrap>
          <Typography.Text strong style={{ fontSize: 18 }}>
            {formatMoney(credit.amount)} ₽
          </Typography.Text>
          {credit.payments_overdue > 0 && (
            <Tag color="red">Просрочено: {credit.payments_overdue}</Tag>
          )}
        </Space>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span>Выплачено</span>
            <span>
              {formatMoney(credit.paid_amount)} / {formatMoney(totalProgress)} ₽
            </span>
          </div>
          <Progress
            percent={Math.round(progress)}
            size="small"
            status={credit.payments_overdue > 0 ? 'exception' : 'active'}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Следующий платёж
          </Typography.Text>
          {credit.next_payment ? (
            <Space size="small">
              <Tag color={paymentStatusColor(credit.next_payment.status)}>
                {PAYMENT_STATUS_LABELS[credit.next_payment.status] || credit.next_payment.status}
              </Tag>
              <Typography.Text strong>{formatMoney(credit.next_payment.amount)} ₽</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ({nextLabel})
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">{nextLabel}</Typography.Text>
          )}
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Платежей: {credit.payments_paid} из {credit.payments_total} оплачено
        </Typography.Text>
      </Space>
    </Card>
  );
};

export default CreditCard;
