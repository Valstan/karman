import React, { useEffect } from 'react';
import { Form, Input, InputNumber, Modal, Select, message } from 'antd';
import { apiRequest } from '../api/client';
import type { BankRow, CreditRow, CreditFormValues } from '../types';
import { CREDIT_STATUS_OPTIONS, PAYMENT_TYPE_OPTIONS } from '../utils/status';
import { todayISO } from '../utils/format';

type Props = {
  open: boolean;
  banks: BankRow[];
  editingCredit: CreditRow | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
};

const CreditFormModal: React.FC<Props> = ({ open, banks, editingCredit, onCancel, onSaved }) => {
  const [form] = Form.useForm<CreditFormValues>();
  const [saving, setSaving] = React.useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (editingCredit) {
      form.setFieldsValue({
        name: editingCredit.raw_name || '',
        bank_id: editingCredit.bank_id,
        amount: editingCredit.amount,
        interest_rate: editingCredit.interest_rate,
        monthly_payment: editingCredit.monthly_payment || '',
        start_date: editingCredit.start_date,
        term_months: String(editingCredit.term_months),
        status: editingCredit.status || 'active',
        payment_type: editingCredit.payment_type || 'annuity',
        description: editingCredit.description || '',
      });
    } else {
      form.setFieldsValue({
        name: '',
        bank_id: banks[0]?.id,
        amount: '0',
        interest_rate: '0',
        start_date: todayISO(),
        term_months: '12',
        status: 'active',
        payment_type: 'annuity',
        monthly_payment: '',
        description: '',
      });
    }
  }, [open, editingCredit, banks, form]);

  const handleSubmit = async (values: CreditFormValues) => {
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
        message.success('Кредит обновлён');
      } else {
        await apiRequest('/api/v1/credits/credits/', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        message.success('Кредит добавлен');
      }

      await onSaved();
      onCancel();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось сохранить кредит');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editingCredit ? 'Редактировать кредит' : 'Добавить кредит'}
      open={open}
      onCancel={onCancel}
      onOk={() => void form.submit()}
      confirmLoading={saving}
      okText="Сохранить"
      cancelText="Отмена"
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item label="Название кредита" name="name" tooltip="Если пусто — используется название банка">
          <Input placeholder="Например: Ипотека на квартиру" />
        </Form.Item>

        <Form.Item label="Банк / МКК" name="bank_id" rules={[{ required: true }]}>
          <Select
            showSearch
            optionFilterProp="label"
            options={banks.map((bank) => ({ value: bank.id, label: bank.name }))}
          />
        </Form.Item>

        <Form.Item label="Сумма кредита, ₽" name="amount" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} min={0} step={1000} stringMode />
        </Form.Item>

        <Form.Item label="Процентная ставка, %" name="interest_rate" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} min={0} step={0.1} stringMode />
        </Form.Item>

        <Form.Item label="Ежемесячный платёж, ₽" name="monthly_payment">
          <InputNumber style={{ width: '100%' }} min={0} step={100} stringMode />
        </Form.Item>

        <Form.Item label="Дата начала" name="start_date" rules={[{ required: true }]}>
          <Input type="date" />
        </Form.Item>

        <Form.Item label="Срок (месяцев)" name="term_months" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} min={1} step={1} stringMode />
        </Form.Item>

        <Form.Item label="Тип платежа" name="payment_type" rules={[{ required: true }]}>
          <Select options={PAYMENT_TYPE_OPTIONS} />
        </Form.Item>

        <Form.Item label="Статус" name="status" rules={[{ required: true }]}>
          <Select options={CREDIT_STATUS_OPTIONS} />
        </Form.Item>

        <Form.Item label="Описание" name="description">
          <Input.TextArea rows={3} placeholder="Любые заметки по кредиту" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CreditFormModal;
