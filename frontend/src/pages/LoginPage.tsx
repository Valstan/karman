import React, { useState } from 'react';
import { Button, Card, Form, Input, message } from 'antd';
import { apiRequest } from '../api/client';
import type { AuthUser } from '../types';

type Props = {
  onLoggedIn: () => Promise<AuthUser | null>;
};

const LoginPage: React.FC<Props> = ({ onLoggedIn }) => {
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    try {
      setLoading(true);
      if (!values.username || !values.password) {
        throw new Error('Неверный логин или пароль');
      }
      await apiRequest<{ user: AuthUser }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      await onLoggedIn();
      message.success('Вход выполнен');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Вход" style={{ maxWidth: 420, margin: '40px auto' }}>
      <Form layout="vertical" onFinish={onFinish}>
        <Form.Item label="Логин" name="username" rules={[{ required: true }]}>
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item label="Пароль" name="password" rules={[{ required: true }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} block>
          Войти
        </Button>
      </Form>
    </Card>
  );
};

export default LoginPage;
