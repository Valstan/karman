import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

/**
 * Контроль к находке R1 аудита #057: значение IP нельзя задать заголовком клиента.
 *
 * Тест написан против трёх фактов, проверенных на боевом боксе (`nginx -T`):
 * nginx ставит `X-Real-IP $remote_addr` (перезаписывает) и
 * `X-Forwarded-For $proxy_add_x_forwarded_for` (дописывает в конец). Если бы приложение
 * брало первый элемент XFF, блокировка перебора не срабатывала бы никогда.
 */
function request(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/auth/login', { headers });
}

describe('clientIp', () => {
  it('берёт X-Real-IP — его nginx перезаписывает, клиент подменить не может', () => {
    expect(
      clientIp(
        request({
          'x-real-ip': '203.0.113.7',
          // Клиент подставил свой — в XFF он остался ПЕРВЫМ, и именно так раньше и читали.
          'x-forwarded-for': '198.51.100.9, 203.0.113.7',
        }),
      ),
    ).toBe('203.0.113.7');
  });

  it('игнорирует подставленный X-Forwarded-For, когда есть доверенный X-Real-IP', () => {
    expect(
      clientIp(
        request({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' }),
      ),
    ).toBe('203.0.113.7');
  });

  it('без X-Real-IP берёт ПОСЛЕДНИЙ элемент XFF — дописанный прокси', () => {
    expect(
      clientIp(request({ 'x-forwarded-for': '198.51.100.9, 203.0.113.7' })),
    ).toBe('203.0.113.7');
  });

  it('один элемент XFF — это и есть адрес', () => {
    expect(clientIp(request({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ротация подставленного XFF больше не меняет результат', () => {
    // Ровно тот обход, которым счётчик неудач обнулялся на каждый запрос.
    const a = clientIp(
      request({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1, 203.0.113.7' }),
    );
    const b = clientIp(
      request({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.2, 203.0.113.7' }),
    );
    expect(a).toBe(b);
  });

  it('мусорный хвост не доезжает: колонка ip — varchar(64), а обрезки в logAuthAudit нет', () => {
    expect(clientIp(request({ 'x-real-ip': 'x'.repeat(200) }))).toBeNull();
    expect(clientIp(request({ 'x-forwarded-for': '203.0.113.7, ' + 'A'.repeat(80) }))).toBe(
      '203.0.113.7',
    );
    expect(clientIp(request({ 'x-forwarded-for': '203.0.113.7; DROP TABLE' }))).toBeNull();
  });

  it('отсутствие заголовков — null, а не исключение', () => {
    expect(clientIp(request({}))).toBeNull();
  });

  it('IPv6 и его сокращённая форма проходят', () => {
    expect(clientIp(request({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });
});