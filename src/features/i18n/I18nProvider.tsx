/* eslint-disable react-refresh/only-export-components -- provider module also exposes translation hooks and locale helpers */
import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import zhCN from '../../locales/zh-CN.json';
import enUS from '../../locales/en-US.json';
import jaJP from '../../locales/ja-JP.json';
import type { AppSettings } from '../../types/appTypes';
import { defaultAppSettings } from '../app/appShared';
import { isTauriRuntime, runCommand, runCommandQuiet } from '../app/appRuntime';

type Locale = 'zh-CN' | 'en-US' | 'ja-JP';

const localeMap: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
};

const DEFAULT_LOCALE: Locale = 'zh-CN';

function isLocale(value: string): value is Locale {
  return value in localeMap;
}

function getSystemLocale(): Locale {
  const nav = navigator.language;
  if (nav.startsWith('ja')) return 'ja-JP';
  if (nav.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem('piko-locale');
    if (stored && isLocale(stored)) return stored;
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

  // 桌面端：初次从设置读取语言，并跟随 settings-updated（其他窗口切换时同步）。
  // localStorage 仅作 web 预览模式的持久化与桌面端的启动缓存。
  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    void runCommand<AppSettings>('get_settings', undefined, defaultAppSettings)
      .then((settings) => {
        if (!disposed && isLocale(settings.language)) {
          setLocaleState(settings.language);
        }
      })
      .catch(() => undefined);
    const unlisten = listen<AppSettings>('settings-updated', (event) => {
      if (isLocale(event.payload.language)) {
        setLocaleState(event.payload.language);
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((dispose) => dispose());
    };
  }, []);

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
    if (isTauriRuntime) {
      runCommandQuiet('update_language', { language: newLocale });
    }
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
