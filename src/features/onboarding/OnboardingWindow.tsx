import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n/I18nProvider';

type OnboardingStep = 'name' | 'ai' | 'complete';

interface OnboardingProps {
  onComplete: () => void;
  onSkip: () => void;
}

interface ProviderOption {
  value: string;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

const PROVIDERS: ProviderOption[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { value: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-6' },
  { value: 'gemini', label: 'Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash' },
  { value: 'lmstudio', label: 'LM Studio', defaultBaseUrl: 'http://localhost:1234/v1', defaultModel: '' },
];

export function OnboardingWindow({ onComplete, onSkip }: OnboardingProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<OnboardingStep>('name');
  const [companionName, setCompanionName] = useState('Piko');
  const [selectedProvider, setSelectedProvider] = useState('openai-compatible');
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0].defaultBaseUrl);
  const [model, setModel] = useState(PROVIDERS[0].defaultModel);
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);

  const handleProviderChange = useCallback((value: string) => {
    setSelectedProvider(value);
    const provider = PROVIDERS.find(p => p.value === value);
    if (provider) {
      setBaseUrl(provider.defaultBaseUrl);
      setModel(provider.defaultModel);
    }
  }, []);

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await invoke('update_ai_settings', {
        input: {
          provider: selectedProvider,
          baseUrl,
          model,
          temperature: 0.7,
          timeoutSeconds: 120,
          apiKey: apiKey || null,
        },
      });
      await invoke('list_models');
      setTestResult('success');
    } catch {
      setTestResult('error');
    } finally {
      setTesting(false);
    }
  }, []);

  const handleNext = useCallback(async () => {
    if (step === 'name') {
      setStep('ai');
      return;
    }

    if (step === 'ai') {
      // Save AI settings
      try {
        await invoke('update_ai_settings', {
          input: {
            provider: selectedProvider,
            baseUrl,
            model,
            temperature: 0.7,
            timeoutSeconds: 120,
            apiKey: apiKey || null,
          },
        });
      } catch { /* ignore errors during onboarding */ }

      // Mark onboarding complete
      try {
        await invoke('complete_onboarding', {
          companionName,
          onboardingVersion: '1.0',
        });
      } catch { /* ignore */ }

      setStep('complete');
      return;
    }

    onComplete();
  }, [step, companionName, selectedProvider, baseUrl, model, apiKey, onComplete]);

  const handleSkip = useCallback(() => {
    void invoke('skip_onboarding').finally(() => {
      onSkip();
    });
  }, [onSkip]);

  return (
    <div className="onboarding-container">
      <div className="onboarding-card">
        <div className="onboarding-header">
          <h1 className="onboarding-title">{t('onboarding.title', '欢迎使用 Piko')}</h1>
          <button className="onboarding-skip" onClick={handleSkip}>
            {t('onboarding.skip', '跳过')}
          </button>
        </div>

        {/* Step 1: Name */}
        {step === 'name' && (
          <div className="onboarding-step">
            <div className="onboarding-step-number">1 / 3</div>
            <h2>{t('onboarding.step1', '给你的精灵起个名字')}</h2>
            <input
              className="onboarding-input"
              type="text"
              value={companionName}
              onChange={(e) => setCompanionName(e.target.value)}
              placeholder={t('onboarding.step1Placeholder', '例如：Piko')}
              maxLength={30}
              autoFocus
            />
          </div>
        )}

        {/* Step 2: AI Service */}
        {step === 'ai' && (
          <div className="onboarding-step">
            <div className="onboarding-step-number">2 / 3</div>
            <h2>{t('onboarding.step2', '选择 AI 服务')}</h2>

            <select
              className="onboarding-select"
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              {PROVIDERS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>

            <input
              className="onboarding-input"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Base URL"
            />

            <input
              className="onboarding-input"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model"
            />

            <input
              className="onboarding-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API Key"
            />

            <button
              className="onboarding-test-btn"
              onClick={handleTestConnection}
              disabled={testing}
            >
              {testing ? '测试中...' : t('onboarding.step2Test', '测试连接')}
            </button>

            {testResult === 'success' && (
              <p className="onboarding-test-success">
                {t('onboarding.step2Success', '连接成功！')}
              </p>
            )}
            {testResult === 'error' && (
              <p className="onboarding-test-error">
                {t('onboarding.step2Failed', '连接失败')}
              </p>
            )}
          </div>
        )}

        {/* Step 3: Complete */}
        {step === 'complete' && (
          <div className="onboarding-step onboarding-complete">
            <div className="onboarding-step-number">3 / 3</div>
            <h2>{t('onboarding.step3', '准备就绪')}</h2>
            <p>{t('onboarding.step3Message', '一切就绪！Piko 会在桌面上陪伴你。')}</p>
          </div>
        )}

        <div className="onboarding-footer">
          {step !== 'name' && (
            <button
              className="onboarding-prev-btn"
              onClick={() => setStep(step === 'complete' ? 'ai' : 'name')}
            >
              {t('onboarding.previous', '上一步')}
            </button>
          )}
          <button
            className="onboarding-next-btn"
            onClick={handleNext}
          >
            {step === 'complete'
              ? t('onboarding.complete', '完成')
              : t('onboarding.next', '下一步')}
          </button>
        </div>
      </div>
    </div>
  );
}
