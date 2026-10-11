import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexDesktopThreadUrl,
  CodexDesktopRolloutReader,
  CodexDesktopThreadRelay,
  createCodexDesktopThreadRelayFromEnv,
} from '../../../src/providers/codex/desktop_thread_relay.js';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'weixin',
    externalScopeId: 'wxid-1',
    text: 'hello',
    metadata: {
      codexbridge: {
        executionMode: 'desktop_shared',
      },
    },
    ...overrides,
  } as any;
}

function makeInput(text = 'hello') {
  return [{ type: 'text', text, text_elements: [] }] as any;
}

function rolloutRecord(type: string, payload: Record<string, unknown>) {
  return `${JSON.stringify({ type, payload })}\n`;
}

function assistantRecord(turnId: string, text: string, phase = 'commentary') {
  return rolloutRecord('response_item', {
    type: 'message', role: 'assistant', phase,
    content: [{ type: 'output_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

test('desktop observer attaches to the unfinished turn and ignores completed history and reasoning', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-observer-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout-thread-1.jsonl');
  fs.writeFileSync(file,
    rolloutRecord('session_meta', { id: 'thread-1' }) +
    rolloutRecord('event_msg', { type: 'task_started', turn_id: 'old' })
    + assistantRecord('old', 'old answer', 'final_answer')
    + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'old', last_agent_message: 'old answer' })
    + rolloutRecord('event_msg', { type: 'task_started', turn_id: 'active' })
    + rolloutRecord('response_item', { type: 'reasoning', summary: [{ text: 'private reasoning' }] })
    + assistantRecord('assistant-message-id', '正在核查。'));
  const relay = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin', pollIntervalMs: 1,
    rolloutReader: new CodexDesktopRolloutReader(root),
    runCommand: async () => assert.fail('observing must not submit a prompt'),
  });
  const controller = new AbortController();
  context.after(() => controller.abort());
  const events: any[] = [];
  await relay.observeThread({
    threadId: 'thread-1', signal: controller.signal,
    onEvent: async (event) => {
      events.push(event);
      if (event.kind === 'progress' && event.outputKind === 'commentary') {
        fs.appendFileSync(file,
          assistantRecord('assistant-message-id', '核查完成。', 'final_answer')
          + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'active', last_agent_message: '核查完成。',
            started_at: 1791683318, completed_at: 1791683443, duration_ms: 125218 }));
      }
      if (event.kind === 'complete') { controller.abort(); }
    },
  });
  assert.deepEqual(events.map((event) => [event.kind, event.turnId, event.text]), [
    ['started', 'active', ''],
    ['progress', 'active', '正在核查。'],
    ['progress', 'active', '核查完成。'],
    ['complete', 'active', '核查完成。'],
  ]);
  assert.equal(events.at(-1).durationMs, 125218, 'mid-turn attachment must use the full recorded turn duration');
});

test('desktop reader derives duration from start/end records and does not invent missing timing', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-timing-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout-thread-1.jsonl');
  fs.writeFileSync(file, rolloutRecord('session_meta', { id: 'thread-1' }) + rolloutRecord('event_msg', { type: 'task_started', turn_id: 'active', started_at: 1791683318 }));
  const reader = new CodexDesktopRolloutReader(root);
  const cursor = await reader.snapshot('thread-1');
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: '2026-10-11T01:48:45.635Z', type: 'event_msg',
    payload: { type: 'turn_aborted', turn_id: 'active' } })}\n`
    + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'unknown', duration_ms: -1 })
    + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'zero', duration_ms: 0 })
    + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'derived', started_at: 10, completed_at: 75 })
    + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'reversed', started_at: 75, completed_at: 10 }));
  const events = await reader.readEvents('thread-1', cursor);
  assert.equal(events[0].kind, 'failed');
  assert.equal(events[0].durationMs, 7635);
  assert.equal(events[1].durationMs, undefined);
  assert.equal(events[2].durationMs, 0);
  assert.equal(events[3].durationMs, 65000);
  assert.equal(events[4].durationMs, undefined);
});

test('desktop reader preserves split UTF-8 records and completed threads are idle', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-utf8-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout-thread-1.jsonl');
  fs.writeFileSync(file, rolloutRecord('session_meta', { id: 'thread-1' }) + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'old', last_agent_message: 'done' }));
  const reader = new CodexDesktopRolloutReader(root);
  const cursor = await reader.snapshot('thread-1');
  assert.equal(cursor.currentTurnId, null);
  assert.deepEqual(cursor.activeEvents, []);
  const buffer = Buffer.from(assistantRecord('new', '中文同步', 'final_answer'));
  const cut = buffer.indexOf(Buffer.from('中文')) + 1;
  fs.appendFileSync(file, buffer.subarray(0, cut));
  assert.deepEqual(await reader.readEvents('thread-1', cursor), []);
  fs.appendFileSync(file, buffer.subarray(cut));
  assert.deepEqual(await reader.readEvents('thread-1', cursor), [
    { kind: 'progress', turnId: 'new', text: '中文同步', outputKind: 'final_answer' },
  ]);
  assert.deepEqual(await reader.readEvents('thread-1', cursor), []);
});

test('desktop reader does not revive a completed task from a different assistant message id', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-completed-message-id-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout-thread-1.jsonl');
  fs.writeFileSync(file,
    rolloutRecord('session_meta', { id: 'thread-1' }) + rolloutRecord('event_msg', { type: 'task_started', turn_id: 'task-turn' })
    + assistantRecord('assistant-message-id', '已完成。', 'final_answer')
    + rolloutRecord('event_msg', { type: 'task_complete', turn_id: 'task-turn', last_agent_message: '已完成。' }));

  const cursor = await new CodexDesktopRolloutReader(root).snapshot('thread-1');

  assert.equal(cursor.currentTurnId, null);
  assert.deepEqual(cursor.activeEvents, []);
});

test('desktop relay forwards visible progress for its own turn and rejects submission into a busy desktop', async () => {
  let now = 0;
  let reads = 0;
  const progress: any[] = [];
  const relay = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin', submitDelayMs: 0, pollIntervalMs: 1, timeoutMs: 20,
    transport: 'gui',
    runCommand: async () => {}, sleep: async (ms) => { now += ms; }, now: () => now,
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map() }; },
      async readEvents() {
        reads += 1;
        return reads === 1 ? [
          { kind: 'user', turnId: 'own', text: 'hello' },
          { kind: 'progress', turnId: 'own', text: 'working', outputKind: 'commentary' },
          { kind: 'progress', turnId: 'own', text: 'answer', outputKind: 'final_answer' },
          { kind: 'progress', turnId: 'own', text: 'answer', outputKind: 'final_answer' },
        ] : [{ kind: 'complete', turnId: 'own', text: 'answer', durationMs: 24907 }];
      },
    } as any,
  });
  const result = await relay.startTurn({
    threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent(),
    onProgress: async (update) => { progress.push(update); },
  });
  assert.equal(result.outputText, 'answer');
  assert.equal(result.durationMs, 24907);
  assert.equal(progress.length, 2);
  assert.equal(progress[1].outputKind, 'final_answer');

  const busy = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin',
    runCommand: async () => assert.fail('busy thread must not receive another prompt'),
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map(), currentTurnId: 'active' }; },
      async readEvents() { return []; },
    },
  });
  await assert.rejects(busy.startTurn({
    threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent(),
  }), /仍在运行/);
});

test('desktop observer excludes bridge-owned turns even when completion is read after submission returns', async () => {
  const controller = new AbortController();
  let mode = 'submission';
  let now = 0;
  const relay = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin', submitDelayMs: 0, pollIntervalMs: 1, timeoutMs: 20,
    transport: 'gui',
    runCommand: async () => {}, sleep: async (ms) => { now += ms; }, now: () => now,
    rolloutReader: {
      async snapshot() {
        return {
          offsets: new Map(), remainders: new Map(),
          activeEvents: mode === 'observer' ? [{ kind: 'started', turnId: 'own', text: '' }] : [],
        };
      },
      async readEvents() {
        if (mode === 'submission') {
          return [{ kind: 'user', turnId: 'own', text: 'hello' }, { kind: 'complete', turnId: 'own', text: 'answer' }];
        }
        controller.abort();
        return [{ kind: 'complete', turnId: 'own', text: 'answer' }];
      },
    } as any,
  });
  await relay.startTurn({ threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent() });
  mode = 'observer';
  await relay.observeThread({ threadId: 'thread-1', signal: controller.signal, onEvent: async () => assert.fail('duplicate output') });
});

test('buildCodexDesktopThreadUrl safely encodes the thread prompt', () => {
  const url = new URL(buildCodexDesktopThreadUrl('019f74a1-1ccc-7662-80bc-19b2dfeb2033', '第一行\n"$(touch /tmp/no)"'));

  assert.equal(url.protocol, 'codex:');
  assert.equal(url.hostname, 'threads');
  assert.equal(url.pathname, '/019f74a1-1ccc-7662-80bc-19b2dfeb2033');
  assert.equal(url.searchParams.get('prompt'), '第一行\n"$(touch /tmp/no)"');
  assert.throws(() => buildCodexDesktopThreadUrl('../bad', 'hello'), /Invalid Codex desktop thread id/);
});

test('default IPC relay never touches the GUI and correlates output by acknowledged turn ID', async () => {
  const started: any[] = [];
  const progress: any[] = [];
  const relay = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin',
    runCommand: async () => assert.fail('background submission must not activate a window or press keys'),
    submitter: { async submitTurn(threadId, prompt) {
      assert.equal(threadId, 'thread-1');
      assert.equal(prompt, 'hello');
      return { turnId: 'own' };
    } },
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map() }; },
      async readEvents() { return [
        { kind: 'user', turnId: 'another', text: 'hello' },
        { kind: 'progress', turnId: 'another', text: 'wrong', outputKind: 'final_answer' },
        { kind: 'complete', turnId: 'another', text: 'wrong' },
        { kind: 'progress', turnId: 'own', text: 'right', outputKind: 'final_answer' },
        { kind: 'complete', turnId: 'own', text: 'right', durationMs: 42 },
      ]; },
    } as any,
  });
  const result = await relay.startTurn({ threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent(),
    onTurnStarted: (value) => { started.push(value); }, onProgress: (value) => { progress.push(value); } });
  assert.equal(result.outputText, 'right');
  assert.equal(result.durationMs, 42);
  assert.deepEqual(started, [{ turnId: 'own', threadId: 'thread-1' }]);
  assert.equal(progress.length, 1);
});

test('IPC failure never falls back to GUI or standalone execution', async () => {
  let attempts = 0;
  const relay = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin',
    submitter: { async submitTurn() { attempts += 1; throw new Error('desktop unavailable'); } },
    runCommand: async () => assert.fail('no GUI fallback'),
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map() }; },
      async readEvents() { assert.fail('submission failed'); },
    },
  });
  await assert.rejects(relay.startTurn({ threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent() }),
    /desktop unavailable/u);
  assert.equal(attempts, 1);
});

test('a possibly submitted IPC turn remains observable after the acknowledgement is lost', async () => {
  let rejectSubmission!: (error: Error) => void;
  let submitting!: () => void;
  const ready = new Promise<void>((resolve) => { submitting = resolve; });
  let active = false;
  const controller = new AbortController();
  const events: any[] = [];
  const relay = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin', pollIntervalMs: 1,
    submitter: { submitTurn() {
      active = true;
      submitting();
      return new Promise((_, reject) => { rejectSubmission = reject; });
    } },
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map(), activeEvents: [] }; },
      async readEvents() { return active ? [
        { kind: 'started', turnId: 'accepted', text: '' },
        { kind: 'progress', turnId: 'accepted', text: 'real reply', outputKind: 'final_answer' },
        { kind: 'complete', turnId: 'accepted', text: 'real reply' },
      ] : []; },
    } as any,
  });
  const observed = relay.observeThread({ threadId: 'thread-1', signal: controller.signal,
    onEvent(event) { events.push(event); if (event.kind === 'complete') { controller.abort(); } } });
  const submitted = relay.startTurn({ threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent() });
  const failed = assert.rejects(submitted, /acknowledgement lost/u);
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(events.length, 0, 'hold the cursor until ownership is known');
  rejectSubmission(new Error('acknowledgement lost'));
  await failed;
  await observed;
  assert.equal(events.find((event) => event.kind === 'progress')?.text, 'real reply');
});

test('busy shared threads never submit IPC and voice uses the transcript without attachment paths', async () => {
  const busy = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin',
    submitter: { async submitTurn() { assert.fail('busy thread must not be submitted'); } },
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map(), currentTurnId: 'active' }; },
      async readEvents() { return []; },
    },
  });
  await assert.rejects(busy.startTurn({ threadId: 'thread-1', inputText: 'hello', input: makeInput(), event: makeEvent() }), /仍在运行/u);
  const voice = new CodexDesktopThreadRelay({
    enabled: true, platform: 'darwin',
    submitter: { async submitTurn(_, prompt) { assert.equal(prompt, '语音内容'); return { turnId: 'voice' }; } },
    rolloutReader: {
      async snapshot() { return { offsets: new Map(), remainders: new Map() }; },
      async readEvents() { return [{ kind: 'complete', turnId: 'voice', text: '收到' }]; },
    } as any,
  });
  assert.equal((await voice.startTurn({ threadId: 'thread-1', inputText: 'path: /private/voice.silk',
    input: makeInput(), event: makeEvent({ text: '语音内容', attachments: [{ kind: 'voice', localPath: '/private/voice.silk' }] }),
  })).outputText, '收到');
});

test('createCodexDesktopThreadRelayFromEnv is opt-in', () => {
  assert.equal(createCodexDesktopThreadRelayFromEnv({}, 'darwin'), null);
  assert.ok(createCodexDesktopThreadRelayFromEnv({
    CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD: '1',
  }, 'darwin'));
});

test('CodexDesktopThreadRelay submits through the desktop and returns the matching completed turn', async () => {
  const commands: Array<{ file: string; args: string[] }> = [];
  const sleeps: number[] = [];
  const started: any[] = [];
  let readCount = 0;
  let now = 0;
  const rolloutReader = {
    async snapshot() {
      return { offsets: new Map(), remainders: new Map() };
    },
    async readEvents() {
      readCount += 1;
      if (readCount === 1) {
        return [{ kind: 'user', turnId: 'new-turn', text: 'hello' }];
      }
      return [{ kind: 'complete', turnId: 'new-turn', text: 'desktop reply' }];
    },
  };
  const relay = new CodexDesktopThreadRelay({
    enabled: true,
    transport: 'gui',
    platform: 'darwin',
    submitDelayMs: 10,
    pollIntervalMs: 5,
    timeoutMs: 100,
    runCommand: async (file, args) => {
      commands.push({ file, args });
    },
    rolloutReader: rolloutReader as any,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  });

  const result = await relay.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    input: makeInput(),
    event: makeEvent(),
    onTurnStarted: async (meta) => {
      started.push(meta);
    },
  });

  assert.equal(result.outputText, 'desktop reply');
  assert.equal(result.turnId, 'new-turn');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.finalSource, 'desktop_rollout');
  assert.deepEqual(started, [{ turnId: 'new-turn', threadId: 'thread-1' }]);
  assert.equal(commands[0]?.file, '/usr/bin/open');
  assert.equal(new URL(commands[0]?.args[0] ?? '').searchParams.get('prompt'), 'hello');
  assert.equal(commands[1]?.file, '/usr/bin/osascript');
  assert.match(commands[1]?.args[1] ?? '', /key code 36/);
  assert.deepEqual(sleeps, [10, 5]);
});

test('CodexDesktopThreadRelay accepts text and transcribed voice, but rejects binary-only turns', () => {
  const relay = new CodexDesktopThreadRelay({ enabled: true, platform: 'darwin' });

  assert.equal(relay.shouldRelay({ event: makeEvent(), input: makeInput() }), true);
  assert.equal(relay.shouldRelay({ event: makeEvent({ metadata: {} }), input: makeInput() }), false);
  assert.equal(relay.shouldRelay({ event: makeEvent({ platform: 'telegram' }), input: makeInput() }), false);
  assert.equal(relay.shouldRelay({
    event: makeEvent({
      text: '语音转写内容',
      attachments: [{ kind: 'voice', localPath: '/tmp/a.silk', transcriptText: '语音转写内容' }],
    }),
    input: makeInput('attachment prompt'),
  }), true);
  assert.equal(relay.shouldRelay({
    event: makeEvent({
      text: '',
      attachments: [{ kind: 'voice', localPath: '/tmp/a.silk' }],
    }),
    input: makeInput('attachment prompt'),
  }), false);
  assert.equal(relay.shouldRelay({
    event: makeEvent({ attachments: [{ kind: 'image', localPath: '/tmp/a.png' }] }),
    input: makeInput(),
  }), false);
  assert.equal(relay.shouldRelay({
    event: makeEvent(),
    input: [...makeInput(), { type: 'localImage', path: '/tmp/a.png' }] as any,
  }), false);
});

test('CodexDesktopThreadRelay submits only the voice transcript to the desktop thread', async () => {
  const commands: Array<{ file: string; args: string[] }> = [];
  let readCount = 0;
  let now = 0;
  const relay = new CodexDesktopThreadRelay({
    enabled: true,
    transport: 'gui',
    platform: 'darwin',
    submitDelayMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 20,
    runCommand: async (file, args) => {
      commands.push({ file, args });
    },
    rolloutReader: {
      async snapshot() {
        return { offsets: new Map(), remainders: new Map() };
      },
      async readEvents() {
        readCount += 1;
        return readCount === 1
          ? [{ kind: 'user', turnId: 'voice-turn', text: '语音转写内容' }]
          : [{ kind: 'complete', turnId: 'voice-turn', text: '收到' }];
      },
    } as any,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });

  const result = await relay.startTurn({
    threadId: 'thread-1',
    inputText: 'Weixin attachments:\npath: /tmp/a.silk',
    input: makeInput('Weixin attachments:\npath: /tmp/a.silk'),
    event: makeEvent({
      text: '语音转写内容',
      attachments: [{ kind: 'voice', localPath: '/tmp/a.silk', transcriptText: '语音转写内容' }],
    }),
  });

  assert.equal(result.outputText, '收到');
  assert.equal(new URL(commands[0]?.args[0] ?? '').searchParams.get('prompt'), '语音转写内容');
});

test('CodexDesktopThreadRelay rejects unsupported hosts before invoking commands', async () => {
  const relay = new CodexDesktopThreadRelay({
    enabled: true,
    platform: 'linux',
    runCommand: async () => {
      assert.fail('command should not run');
    },
  });

  await assert.rejects(relay.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    input: makeInput(),
    event: makeEvent(),
  }), /Desktop target is required/);
});

test('CodexDesktopThreadRelay waits when completed status arrives before assistant text', async () => {
  let readCount = 0;
  let now = 0;
  const relay = new CodexDesktopThreadRelay({
    enabled: true,
    transport: 'gui',
    platform: 'darwin',
    submitDelayMs: 1,
    pollIntervalMs: 1,
    timeoutMs: 20,
    runCommand: async () => {},
    rolloutReader: {
      async snapshot() {
        return { offsets: new Map(), remainders: new Map() };
      },
      async readEvents() {
        readCount += 1;
        if (readCount === 1) {
          return [{ kind: 'user', turnId: 'turn-2', text: 'hello' }];
        }
        if (readCount < 3) {
          return [];
        }
        return [{ kind: 'complete', turnId: 'turn-2', text: 'late reply' }];
      },
    } as any,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
  const result = await relay.startTurn({
    threadId: 'thread-1',
    inputText: 'hello',
    input: makeInput(),
    event: makeEvent(),
  });

  assert.equal(result.outputText, 'late reply');
  assert.ok(readCount >= 3);
});

test('CodexDesktopRolloutReader reads only records appended after the snapshot', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-rollout-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = 'thread-1';
  const filePath = path.join(root, `rollout-${threadId}.jsonl`);
  fs.writeFileSync(filePath, rolloutRecord('session_meta', { id: threadId }) + `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'old reply' },
  })}\n`);
  const reader = new CodexDesktopRolloutReader(root);
  const cursor = await reader.snapshot(threadId);
  fs.appendFileSync(filePath, [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello\n' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'new-turn' },
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'new-turn', last_agent_message: 'new reply' },
    }),
    '',
  ].join('\n'));

  const events = await reader.readEvents(threadId, cursor);

  assert.deepEqual(events, [
    { kind: 'user', turnId: 'new-turn', text: 'hello\n' },
    { kind: 'complete', turnId: 'new-turn', text: 'new reply' },
  ]);
  assert.deepEqual(await reader.readEvents(threadId, cursor), []);
});
