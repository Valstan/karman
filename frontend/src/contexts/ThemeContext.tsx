import React, { createContext, useContext, useState, ReactNode } from 'react';

// Определение типов тем
export interface Theme {
  name: string;
  colors: {
    primary: string;
    success: string;
    warning: string;
    error: string;
    background: string;
    surface: string;
    text: string;
    border: string;
    header: string;
    footer: string;
  };
}

// Предопределенные темы
const themes: Record<string, Theme> = {
  light: {
    name: 'light',
    colors: {
      primary: '#1890ff',
      success: '#52c41a',
      warning: '#faad14',
      error: '#ff4d4f',
      background: '#ffffff',
      surface: '#fafafa',
      text: '#000000',
      border: '#d9d9d9',
      header: '#001529',
      footer: '#f0f0f0',
    },
  },
  dark: {
    name: 'dark',
    colors: {
      primary: '#177ddc',
      success: '#49aa19',
      warning: '#d89614',
      error: '#d32029',
      background: '#141414',
      surface: '#1f1f1f',
      text: '#ffffff',
      border: '#434343',
      header: '#000000',
      footer: '#262626',
    },
  },
  ocean: {
    name: 'ocean',
    colors: {
      primary: '#0066cc',
      success: '#00aa44',
      warning: '#ff8800',
      error: '#cc0000',
      background: '#e6f3ff',
      surface: '#cce6ff',
      text: '#003366',
      border: '#66b3ff',
      header: '#003d66',
      footer: '#b3d9ff',
    },
  },
  forest: {
    name: 'forest',
    colors: {
      primary: '#228b22',
      success: '#32cd32',
      warning: '#ffa500',
      error: '#dc143c',
      background: '#f0fff0',
      surface: '#e0ffe0',
      text: '#006400',
      border: '#90ee90',
      header: '#004d00',
      footer: '#c0ffc0',
    },
  },
  sunset: {
    name: 'sunset',
    colors: {
      primary: '#ff6b35',
      success: '#28a745',
      warning: '#ffc107',
      error: '#dc3545',
      background: '#fff5f0',
      surface: '#ffe6d9',
      text: '#8b4513',
      border: '#ffb366',
      header: '#cc4a1a',
      footer: '#ffd9cc',
    },
  },
  neon: {
    name: 'neon',
    colors: {
      primary: '#00ffff',
      success: '#00ff00',
      warning: '#ffff00',
      error: '#ff00ff',
      background: '#000000',
      surface: '#1a1a1a',
      text: '#00ffff',
      border: '#333333',
      header: '#000000',
      footer: '#0d0d0d',
    },
  },
  pink: {
    name: 'pink',
    colors: {
      primary: '#e91e63',
      success: '#4caf50',
      warning: '#ff9800',
      error: '#f44336',
      background: '#fce4ec',
      surface: '#f8bbd9',
      text: '#880e4f',
      border: '#f48fb1',
      header: '#ad1457',
      footer: '#fce4ec',
    },
  },
};

// Контекст темы
interface ThemeContextType {
  currentTheme: Theme;
  setTheme: (themeName: string) => void;
  availableThemes: Theme[];
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Провайдер темы
interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [currentThemeName, setCurrentThemeName] = useState<string>('light');

  const setTheme = (themeName: string) => {
    if (themes[themeName]) {
      setCurrentThemeName(themeName);
      localStorage.setItem('karman-theme', themeName);
    }
  };

  // Загружаем сохраненную тему при инициализации
  React.useEffect(() => {
    const savedTheme = localStorage.getItem('karman-theme');
    if (savedTheme && themes[savedTheme]) {
      setCurrentThemeName(savedTheme);
    }
  }, []);

  const currentTheme = themes[currentThemeName];
  const availableThemes = Object.values(themes);

  const value: ThemeContextType = {
    currentTheme,
    setTheme,
    availableThemes,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

// Хук для использования темы
export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
