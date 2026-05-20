import React, { useState } from 'react';
import { Button, Card, Space, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import type { BankRow, CreditRow } from '../types';
import { CREDIT_STATUS_LABELS, creditStatusColor } from '../utils/status';
import { formatDate, formatMoney } from '../utils/format';
import CreditFormModal from '../components/CreditFormModal';

type Props = {
  loading: boolean;
  credits: CreditRow[];
  banks: BankRow[];
  onReload: () => Promise<void>;
};

const CreditsListPage: React.FC<Props> = ({ loading, credits, banks, onReload }) => {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <Card
      title={`Кредиты (${credits.length})`}
      extra={
        <Space>
          <Button onClick={() => void onReload()}>Обновить</Button>
          <Button type="primary" onClick={() => setModalOpen(true)} disabled={banks.length === 0}>
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
          {
            title: 'Кредит',
            dataIndex: 'name',
            render: (value: string, credit: CreditRow) => <Link to={`/credits/${credit.id}`}>{value}</Link>,
          },
          { title: 'Банк', dataIndex: 'bank_name' },
          {
            title: 'Сумма, ₽',
            dataIndex: 'amount',
            align: 'right' as const,
            render: (value: string) => formatMoney(value),
          },
          { title: 'Ставка, %', dataIndex: 'interest_rate', align: 'right' as const },
          { title: 'Срок, мес.', dataIndex: 'term_months', align: 'right' as const },
          { title: 'Старт', dataIndex: 'start_date', render: (value: string) => formatDate(value) },
          {
            title: 'Статус',
            dataIndex: 'status',
            render: (status: string) => (
              <Tag color={creditStatusColor(status)}>{CREDIT_STATUS_LABELS[status] || status}</Tag>
            ),
          },
          {
            title: 'Действия',
            key: 'actions',
            render: (_value, credit: CreditRow) => (
              <Link to={`/credits/${credit.id}`}>
                <Button size="small">Открыть</Button>
              </Link>
            ),
          },
        ]}
      />

      <CreditFormModal
        open={modalOpen}
        banks={banks}
        editingCredit={null}
        onCancel={() => setModalOpen(false)}
        onSaved={onReload}
      />
    </Card>
  );
};

export default CreditsListPage;
