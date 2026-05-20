import React from 'react';
import { Card, Table } from 'antd';
import type { BankRow } from '../types';

type Props = {
  loading: boolean;
  banks: BankRow[];
};

const BanksPage: React.FC<Props> = ({ loading, banks }) => (
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

export default BanksPage;
