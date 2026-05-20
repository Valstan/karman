import React from 'react';
import { Select, Space } from 'antd';
import { useTheme } from '../contexts/ThemeContext';

const ThemeSelector: React.FC = () => {
  const { currentTheme, setTheme, availableThemes } = useTheme();

  const handleThemeChange = (themeName: string) => {
    setTheme(themeName);
  };

  const themeOptions = availableThemes.map(theme => ({
    value: theme.name,
    label: (
      <Space>
        <div 
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            backgroundColor: theme.colors.primary,
            border: `2px solid ${theme.colors.border}`,
          }}
        />
        {theme.name === 'light' && 'Светлая'}
        {theme.name === 'dark' && 'Тёмная'}
        {theme.name === 'ocean' && 'Морская'}
        {theme.name === 'forest' && 'Лесная'}
        {theme.name === 'sunset' && 'Закатная'}
        {theme.name === 'neon' && 'Неоновая'}
        {theme.name === 'pink' && 'Розовая'}
      </Space>
    ),
  }));

  return (
    <Select
      value={currentTheme.name}
      onChange={handleThemeChange}
      options={themeOptions}
      style={{ 
        minWidth: 120,
        color: currentTheme.colors.text,
      }}
      dropdownStyle={{
        backgroundColor: currentTheme.colors.surface,
        border: `1px solid ${currentTheme.colors.border}`,
      }}
    />
  );
};

export default ThemeSelector;
