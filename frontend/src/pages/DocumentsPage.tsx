import React from 'react';
import { Card, Table, Tag } from 'antd';
import type { DocumentRow } from '../types';
import { formatDate } from '../utils/format';

type Props = {
  loading: boolean;
  documents: DocumentRow[];
};

const DocumentsPage: React.FC<Props> = ({ loading, documents }) => (
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
        { title: 'Дата выдачи', dataIndex: 'issue_date', render: (value: string | null) => formatDate(value) },
        { title: 'Истекает', dataIndex: 'expiry_date', render: (value: string | null) => formatDate(value) },
        {
          title: 'Активен',
          dataIndex: 'is_active',
          render: (active: boolean) => <Tag color={active ? 'green' : 'default'}>{active ? 'Да' : 'Нет'}</Tag>,
        },
      ]}
    />
  </Card>
);

export default DocumentsPage;
