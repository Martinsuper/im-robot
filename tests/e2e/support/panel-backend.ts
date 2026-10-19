import { expect, test as base, type Page } from '@playwright/test';

type BackendOptions = { failures?: Record<string, string>; onboarding?: boolean; savePath?: string | null; label?: 'panel' | 'capture'; memory?: boolean; notificationStatus?: { authorization: string; alertsEnabled?: boolean; alertStyle?: string } };
export const test = base.extend<{ healthyPage: Page }>({
  healthyPage: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(page);
    expect(errors, 'No uncaught UI exceptions').toEqual([]);
  },
});
export { expect };

/** A stateful IPC double; never reads user data or invokes native services. */
export async function installPanelBackend(page: Page, options: BackendOptions = {}) {
  await page.clock.setFixedTime(new Date('2026-10-18T02:00:00Z'));
  await page.addInitScript(options => {
    const storageKey = '__piko_ui_test_state__';
    const state = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? {
      settings: {
        quietMode: 'balanced', companionName: 'Piko', theme: 'sage', language: 'zh-CN',
        sensingPaused: false, breakRemindersEnabled: true, breakReminderIntervalMinutes: 45,
        breakReminderCooldownMinutes: 30, breakReminderQuietHoursEnabled: false,
        breakReminderQuietHoursStart: '22:00', breakReminderQuietHoursEnd: '08:00',
        hasApiKey: false, htmlPreviewEnabled: false, agentAutoApproveCommands: false,
        globalShortcut: 'CmdOrCtrl+Shift+Space',
        ai: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8317/v1', model: 'ui-test', speechModel: 'base', temperature: 0.7, timeoutSeconds: 120 },
      },
      onboarding: options.onboarding ?? false,
      items: [], memos: [], history: [{ id: 'history-1', prompt: '自动化历史提问', response: '自动化历史回答', createdAt: 1792288800 }],
      focus: { status: 'idle', kind: 'focus', remainingSeconds: 0, todayMinutes: 0 },
      soul: { revision: 7, enabled: false, paused: false, enabled_since: 100, categories: [{ category: 'greeting', enabled: false, available: true, enabled_since: null, daily_limit: 2 }], mood_enabled: false, evolution_enabled: false, daily_limit: 3, cooldown_seconds: 7200 },
      role: { profile_id: 'piko', schema_version: 2, revision: 4, default_resource_version: '1', locale: 'zh-CN', user_overrides: {}, effective: { background: 'default', values: [], tone: 'default', catchphrases: [], forbidden_phrases: [], care: 'care', stance: 'stance', extra: '' }, writable: true, fallback_reason: null },
      memories: options.memory ? [{ id: 'memory-1', memoryType: 'profile', title: '自动化记忆', content: '偏好简洁表达', source: 'userExplicit', importance: 5, confidence: 1, recencyScore: 1, privacyLevel: 'publicToUser', status: 'active', createdAt: 1792288800, updatedAt: 1792288800, tags: [], isPinned: false }] : [],
      candidates: options.memory ? [{ id: 'candidate-1', title: '候选偏好', content: '候选记忆内容', memoryType: 'profile', source: 'conversation', confidence: 0.9, importance: 5, tags: [], requiresConfirmation: true }] : [],
      extraction: { enabled: false, intervalMinutes: 30, lastRunAt: 0, processedCount: 0, pendingCount: 0 },
      notificationStatus: { platform: 'macos', authorization: 'authorized', alertsEnabled: true, soundsEnabled: true, alertStyle: 'banner', lastError: null, ...options.notificationStatus },
      nextId: 0,
    };
    const calls: { command: string; args: any }[] = [];
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let callbackId = 0;
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(state));
    const clone = (value: unknown) => structuredClone(value);
    const bridge = window as any;
    bridge.__uiTest = { calls, state };
    bridge.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
    bridge.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: options.label ?? 'panel' }, currentWebview: { label: options.label ?? 'panel' } },
      transformCallback(callback: (event: unknown) => void) { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: any = {}) {
        calls.push({ command, args: clone(args) });
        if (["get_pet_state", "migrate_pet_state", "save_pet_state"].includes(command)) {
          const owner = window as unknown as { __petWire?: { schemaVersion: number; initialized: boolean; entries: Record<string, { revision: number; value: string | null }> } };
          const pet = owner.__petWire ??= { schemaVersion: 1, initialized: true, entries: {} };
          const payload = (args ?? {}) as Record<string, unknown>;
          if (command === "save_pet_state") {
            const key = String(payload.key); const previous = pet.entries[key] ?? { revision: 0, value: null };
            if (previous.revision !== payload.expectedRevision) throw new Error("pet state conflict");
            return pet.entries[key] = { revision: previous.revision + 1, value: payload.value as string | null };
          }
          return structuredClone(pet);
        }
        if (command === "background_status") return [];
        if (command === "get_data_health") return { memoryPersistent: true, sqlite: { acquisitions: 0, waitMicros: 0, holdMicros: 0 }, jsonLockAcquisitions: 0, jsonLockWaitMicros: 0, speechRecognition: true, wasmPlugins: true };

        if (options.failures?.[command]) throw options.failures[command];

        if (command === "plugin:dialog|open") return options.snapshotDirectory ?? null;
        const snapshot = { id: "snapshot-ui", directory: options.snapshotDirectory ?? "/tmp/piko-snapshot-ui", createdAt: 1792288800, fileCount: 2, bytes: 100, excluded: ["API Key"] };
        if (command === "create_data_snapshot" || command === "preview_data_snapshot") return snapshot;
        if (command === "restore_data_snapshot") {
          for (const listener of listeners.values()) if (listener.event === "data-restore-pending") callbacks.get(listener.handler)?.({ event: "data-restore-pending", payload: null });
          return { rollback: snapshot, restoredFiles: 2, restartRequired: true };
        }
        const id = () => `ui-${++state.nextId}`;
        let result: any = null;
        switch (command) {
          case 'plugin:event|listen': listeners.set(callbackId, { event: args.event, handler: args.handler }); return callbackId;
          case 'plugin:event|unlisten': listeners.delete(args.eventId); return null;
          case 'plugin:event|emit': case 'plugin:event|emit_to':
            for (const listener of listeners.values()) if (listener.event === args.event)
              callbacks.get(listener.handler)?.({ event: args.event, id: listener.handler, payload: args.payload });
            return null;
          case 'plugin:autostart|is_enabled': return false;
          case 'plugin:notification|is_permission_granted': return true;
          case 'confirm_screen_capture': case 'cancel_screen_capture': return null;
          case 'plugin:window|inner_position': return { x: 0, y: 0 };
          case 'plugin:window|inner_size': return { width: 400, height: 700 };
          case 'plugin:dialog|save': return options.savePath === undefined ? '/isolated-ui-test/calendar.ics' : options.savePath;
          case 'get_notification_status': result = state.notificationStatus; break;
          case 'request_notification_permission': Object.assign(state.notificationStatus, { authorization: 'authorized', alertsEnabled: true, alertStyle: 'banner' }); result = state.notificationStatus; break;
          case 'send_test_notification': case 'open_notification_settings': break;
          case 'get_settings': result = state.settings; break;
          case 'get_onboarding_status': result = { required: state.onboarding, completed: !state.onboarding, version: '1.0' }; break;
          case 'complete_onboarding': state.onboarding = false; state.settings.companionName = args.companionName; result = state.settings; break;
          case 'skip_onboarding': state.onboarding = false; result = state.settings; break;
          case 'get_focus_state': result = state.focus; break;
          case 'start_focus': case 'start_break': state.focus = { ...state.focus, status: 'running', kind: command === 'start_focus' ? 'focus' : 'break', remainingSeconds: args.minutes * 60 }; result = state.focus; break;
          case 'pause_focus': state.focus.status = 'paused'; result = state.focus; break;
          case 'resume_focus': state.focus.status = 'running'; result = state.focus; break;
          case 'stop_focus': state.focus = { ...state.focus, status: 'idle', remainingSeconds: 0 }; result = state.focus; break;
          case 'list_schedule_items': result = state.items; break;
          case 'create_reminder': case 'create_calendar_event': {
            const input = args.input;
            const item = { id: id(), kind: command === 'create_reminder' ? 'reminder' : 'event', title: input.title, startAt: input.dueAt ?? input.startAt, endAt: input.endAt ?? null, repeat: input.repeat ?? null, status: input.dueAt ? 'pending' : null, source: 'user', createdAt: 1792288800, updatedAt: 1792288800 };
            state.items.push(item); result = item; break;
          }
          case 'complete_schedule_item': { const item = state.items.find((item: any) => item.id === args.id); item.status = 'done'; result = item; break; }
          case 'delete_reminder': case 'delete_calendar_event': state.items = state.items.filter((item: any) => item.id !== args.id); break;
          case 'get_calendar_sync_status': result = { platform: 'macos', available: true, lastSync: null, mappingCount: 0 }; break;
          case 'sync_calendar_to_system': result = { pushed: 2 }; break;
          case 'sync_calendar_from_system': result = { imported: 1 }; break;
          case 'list_memos': result = state.memos; break;
          case 'create_memo': case 'update_memo': {
            const old = state.memos.find((memo: any) => memo.id === args.id);
            const memo = { id: args.id ?? id(), ...args.input, summary: args.input.content, tags: [], createdAt: old?.createdAt ?? 1792288800, updatedAt: 1792288801 };
            state.memos = state.memos.filter((item: any) => item.id !== memo.id).concat(memo); result = memo; break;
          }
          case 'delete_memo': state.memos = state.memos.filter((memo: any) => memo.id !== args.id); break;
          case 'list_chat_history': result = state.history; break;
          case 'clear_chat_history': state.history = []; break;
          case 'list_memories': case 'get_recent_memories': result = state.memories; break;
          case 'search_memories': result = state.memories.filter((item: any) => (item.title + item.content).includes(args.input.query)); break;
          case 'get_pending_candidates': result = state.candidates; break;
          case 'pin_memory': case 'unpin_memory': state.memories.find((item: any) => item.id === args.id).isPinned = command === 'pin_memory'; break;
          case 'delete_memory': state.memories = state.memories.filter((item: any) => item.id !== args.id); break;
          case 'feedback_memory': break;
          case 'reject_memory_candidate': state.candidates = state.candidates.filter((item: any) => item.id !== args.candidateId); break;
          case 'apply_memory_candidates': state.candidates = state.candidates.filter((item: any) => item.id !== args.input.candidateId); result = 1; break;
          case 'get_memory_extraction_status': result = state.extraction; break;
          case 'configure_memory_extraction': Object.assign(state.extraction, args); result = state.extraction; break;
          case 'extract_memories_now': state.extraction.lastRunAt = 1792288800; result = 1; break;
          case 'soul_list_open_loops': case 'soul_list_topic_responses': result = []; break;
          case 'soul_list_open_loop_candidates': result = { candidates: [], active_count: 0, active_limit: 10 }; break;
          case 'get_memory_summaries': case 'list_external_plugins': case 'get_speech_model_status': result = []; break;
          case 'get_memory_settings': result = { enabled: false, extractionIntervalMinutes: 30 }; break;
          case 'screen_capture_permission_status': result = '测试环境'; break;
          case 'update_preferences': Object.assign(state.settings, args.input); result = state.settings; break;
          case 'update_ai_settings': Object.assign(state.settings.ai, args.input); result = state.settings; break;
          case 'list_models': result = [{ id: 'ui-test', name: 'ui-test' }]; break;
          case 'soul_get_settings': result = state.soul; break;
          case 'soul_get_profile': result = state.role; break;
          case 'soul_get_continuity': result = { revision: 1, history_enabled: false, days: 0, nickname: null, nickname_options: [], milestones: [], proposals: [], versions: [] }; break;
          case 'soul_diagnostics': result = { storage: 'ready', profile_valid: true, ledger_readable: true }; break;
          case 'soul_update_settings':
            for (const [key, value] of Object.entries(args.input)) if (key !== 'expected_revision' && value !== null) state.soul[key] = value;
            state.soul.revision++; result = state.soul; break;
          case 'soul_update_profile': state.role.revision++; state.role.user_overrides = args.input.user_overrides; Object.assign(state.role.effective, args.input.user_overrides); result = state.role; break;
          case 'get_extraction_settings': result = { enabled: false, intervalMinutes: 30, minMessages: 5, maxCandidates: 10 }; break;
          case 'get_global_shortcut': result = state.settings.globalShortcut; break;
          case 'show_pet': case 'hide_pet': case 'show_bubble': case 'export_calendar_events': case 'open_calendar_import': break;
          default: throw new Error(`Unimplemented test IPC: ${command}`);
        }
        persist();
        if (['pin_memory', 'unpin_memory', 'delete_memory', 'apply_memory_candidates'].includes(command)) {
          for (const listener of listeners.values()) if (listener.event === 'memories-updated')
            callbacks.get(listener.handler)?.({ event: 'memories-updated', id: listener.handler, payload: null });
        }
        return clone(result);
      },
    };
  }, options);
}

export async function callsFor(page: Page, command: string) {
  return page.evaluate(command => (window as any).__uiTest.calls.filter((call: any) => call.command === command), command);
}
