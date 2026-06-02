import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import zhCN from '../../locales/zh-CN.json';
import enUS from '../../locales/en-US.json';
import jaJP from '../../locales/ja-JP.json';

type Locale = 'zh-CN' | 'en-US' | 'ja-JP';

const localeMap: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
};

const DEFAULT_LOCALE: Locale = 'zh-CN';

function getSystemLocale(): Locale {
  const nav = navigator.language;
  if (nav.startsWith('ja')) return 'ja-JP';
  if (nav.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem('piko-locale');
    if (stored && stored in localeMap) return stored as Locale;
  } catch { /* ignore */ }
  return getSystemLocale();
}

interface I18nContextType {
  locale: Locale;
  t: (key: string, fallback?: string) => string;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextType | null>(null);

function resolveValue(obj: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);

  const t = useCallback(
    (key: string, fallback?: string): string => {
      const messages = localeMap[locale] || localeMap[DEFAULT_LOCALE];
      return resolveValue(messages, key) ?? fallback ?? key;
    },
    [locale],
  );

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem('piko-locale', newLocale);
    } catch { /* ignore */ }
  }, []);

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation(): I18nContextType {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
}

/** Detect if the user has never set a locale preference */
export function detectSystemLocaleChange(): boolean {
  try {
    return localStorage.getItem('piko-locale') === null;
  } catch {
    return true;
  }
}

export { getSystemLocale };
export type { Locale };
