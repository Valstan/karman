import React, { useEffect } from 'react';
import { useTheme } from '../contexts/ThemeContext';

const ThemeApplier: React.FC = () => {
  const { currentTheme } = useTheme();

  useEffect(() => {
    // Применяем CSS переменные для темы
    const root = document.documentElement;
    
    // Устанавливаем CSS переменные
    root.style.setProperty('--theme-primary', currentTheme.colors.primary);
    root.style.setProperty('--theme-success', currentTheme.colors.success);
    root.style.setProperty('--theme-warning', currentTheme.colors.warning);
    root.style.setProperty('--theme-error', currentTheme.colors.error);
    root.style.setProperty('--theme-background', currentTheme.colors.background);
    root.style.setProperty('--theme-surface', currentTheme.colors.surface);
    root.style.setProperty('--theme-text', currentTheme.colors.text);
    root.style.setProperty('--theme-border', currentTheme.colors.border);
    root.style.setProperty('--theme-header', currentTheme.colors.header);
    root.style.setProperty('--theme-footer', currentTheme.colors.footer);

    // Добавляем класс темы к body для дополнительных стилей
    document.body.className = document.body.className.replace(/theme-\w+/g, '');
    document.body.classList.add(`theme-${currentTheme.name}`);

    // Устанавливаем мета-тег для цвета темы браузера
    let themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeColorMeta) {
      themeColorMeta = document.createElement('meta');
      themeColorMeta.setAttribute('name', 'theme-color');
      document.head.appendChild(themeColorMeta);
    }
    themeColorMeta.setAttribute('content', currentTheme.colors.primary);

  }, [currentTheme]);

  return null; // Этот компонент не рендерит ничего видимого
};

export default ThemeApplier;
