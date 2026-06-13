import { describe, it, expect } from 'vitest';
import { escapeHtml, renderReminderText } from './render';

describe('escapeHtml', () => {
  it('экранирует & < >', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('renderReminderText', () => {
  it('заголовок жирным + тело', () => {
    expect(renderReminderText('Платёж', 'Внести 100')).toBe('🔔 <b>Платёж</b>\nВнести 100');
  });

  it('без тела — только заголовок', () => {
    expect(renderReminderText('Срок', '   ')).toBe('🔔 <b>Срок</b>');
  });

  it('экранирует пользовательский текст (защита HTML parse_mode)', () => {
    expect(renderReminderText('<x>', '<y>')).toBe('🔔 <b>&lt;x&gt;</b>\n&lt;y&gt;');
  });
});
