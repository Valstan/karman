import React, { useEffect } from 'react';
import { Form, Input, InputNumber, Modal, Select, message } from 'antd';
import { apiRequest } from '../api/client';
import type { PaymentFormValues, PaymentRow } from '../types';
import { PAYMENT_STATUS_OPTIONS } from '../utils/status';
import { todayISO } from '../utils/format';

type Props = {
  open: boolean;
  creditId: number;
  editingPayment: PaymentRow | null;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
};

const PaymentFormModal: React.FC<Props> = ({ open, creditId, editingPayment, onCancel, onSaved }) => {
  const [form] = Form.useForm<PaymentFormValues>();
  const [saving, setSaving] = React.useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (editingPayment) {
      form.setFieldsValue({
        amount: editingPayment.amount,
        principal_amount: editingPayment.principal_amount || '',
        interest_amount: editingPayment.interest_amount || '',
        due_date: editingPayment.due_date,
        paid_date: editingPayment.paid_date || '',
        status: editingPayment.status,
      });
    } else {
      form.setFieldsValue({
        amount: '',
        principal_amount: '',
        interest_amount: '',
        due_date: todayISO(),
        paid_date: '',
        status: 'scheduled',
      });
    }
  }, [open, editingPayment, form]);

  const handleSubmit = async (values: PaymentFormValues) => {
    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        amount: values.amount,
        principal_amount: values.principal_amount || null,
        interest_amount: values.interest_amount || null,
        due_date: values.due_date,
        status: values.status,
      };

      if (values.status === 'paid') {
        payload.paid_date = values.paid_date || todayISO();
      } else if (values.paid_date) {
        payload.paid_date = values.paid_date;
      }

      if (editingPayment) {
        await apiRequest(`/api/v1/credits/payments/${editingPayment.id}/`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        message.success('Платёж обновлён');
      } else {
        await apiRequest(`/api/v1/credits/credits/${creditId}/payments/`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        message.success('Платёж добавлен');
      }

      await onSaved();
      onCancel();
    } catch (error) {
      message.error((error as Error).message || 'Не удалось сохранить платёж');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editingPayment ? 'Редактировать платёж' : 'Добавить платёж'}
      open={open}
      onCancel={onCancel}
      onOk={() => void form.submit()}
      confirmLoading={saving}
      okText="Сохранить"
      cancelText="Отмена"
      width={480}
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item label="Сумма платежа, ₽" name="amount" rules={[{ required: true }]}>
          <InputNumber style={{ width: '100%' }} min={0} step={100} stringMode />
        </Form.Item>

        <Form.Item label="Основной долг, ₽" name="principal_amount">
          <InputNumber style={{ width: '100%' }} min={0} step={100} stringMode />
        </Form.Item>

        <Form.Item label="Проценты, ₽" name="interest_amount">
          <InputNumber style={{ width: '100%' }} min={0} step={10} stringMode />
        </Form.Item>

        <Form.Item label="Срок платежа" name="due_date" rules={[{ required: true }]}>
          <Input type="date" />
        </Form.Item>

        <Form.Item label="Статус" name="status" rules={[{ required: true }]}>
          <Select options={PAYMENT_STATUS_OPTIONS} />
        </Form.Item>

        <Form.Item
          label="Дата фактической оплаты"
          name="paid_date"
          tooltip="Заполнится автоматически сегодняшней датой при статусе «Оплачен», если оставить пустым"
        >
          <Input type="date" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default PaymentFormModal;
