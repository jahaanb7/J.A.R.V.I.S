import { describe, expect, it } from 'vitest';
import { toSpeech } from './speech';

describe('toSpeech', () => {
  it('drops markdown symbols, links, and list markers', () => {
    expect(toSpeech('**Done.** See [the plan](https://example.com).\n- first\n- second')).toBe(
      'Done. See the plan. first second',
    );
  });

  it('replaces code blocks with a short note instead of reading code aloud', () => {
    const spoken = toSpeech('Run this:\n```js\nconsole.log(1)\n```\nThen stop.');
    expect(spoken).not.toContain('console');
    expect(spoken).toContain('code block omitted');
    expect(spoken).toContain('Then stop.');
  });

  it('keeps short replies whole', () => {
    expect(toSpeech('Added physics review for Thursday.')).toBe('Added physics review for Thursday.');
  });

  it('cuts long replies at a sentence boundary', () => {
    const long = `${'First sentence is here. '.repeat(10)}${'x'.repeat(500)}`;
    const spoken = toSpeech(long);
    expect(spoken.length).toBeLessThanOrEqual(400);
    expect(spoken.endsWith('here.')).toBe(true);
  });

  it('returns an empty string for blank input', () => {
    expect(toSpeech('   ')).toBe('');
  });
});
