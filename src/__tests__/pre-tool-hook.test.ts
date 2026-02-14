import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

// Path to the hook script
const HOOK_SCRIPT = path.join(process.cwd(), 'hooks', 'pre-tool-check.sh');

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, any>;
  tool_use_id?: string;
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

interface TestCase {
  description: string;
  tool_name: string;
  tool_input: Record<string, any>;
  expectedDecision: 'allow' | 'deny' | 'ask' | RegExp;
  expectedReason?: string | RegExp;
}

async function runHook(input: HookInput): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `echo '${JSON.stringify(input)}' | ${HOOK_SCRIPT}`,
      { shell: '/bin/bash' }
    );
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return {
      exitCode: error.code || 1,
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || ''
    };
  }
}

const baseInput: HookInput = {
  session_id: 'test-session',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp/test',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hello' }
};

describe('Pre-Tool Hook - Table-Driven Tests', () => {
  const testCases: TestCase[] = [
    // Destructive operations - should DENY
    {
      description: 'should deny rm -rf commands',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny git reset --hard',
      tool_name: 'Bash',
      tool_input: { command: 'git reset --hard HEAD~1' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny git push --force',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny git push -f',
      tool_name: 'Bash',
      tool_input: { command: 'git push -f origin main' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny git clean -f',
      tool_name: 'Bash',
      tool_input: { command: 'git clean -f' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny git branch -D',
      tool_name: 'Bash',
      tool_input: { command: 'git branch -D feature-branch' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny file deletion with Delete tool',
      tool_name: 'Delete',
      tool_input: { file_path: '/tmp/test.txt' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },
    {
      description: 'should deny destructive commands even if on allowlist',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules' },
      expectedDecision: 'deny',
      expectedReason: /Destructive/
    },

    // Allowlist operations - should ALLOW
    {
      description: 'should allow npm test (on allowlist)',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      expectedDecision: 'allow'
    },
    {
      description: 'should allow npm install (on allowlist)',
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      expectedDecision: 'allow'
    },
    {
      description: 'should allow npm run build (on allowlist)',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build:prod' },
      expectedDecision: 'allow'
    },
    {
      description: 'should allow git checkout (on allowlist)',
      tool_name: 'Bash',
      tool_input: { command: 'git checkout main' },
      expectedDecision: 'allow'
    },
    {
      description: 'should allow git add (on allowlist)',
      tool_name: 'Bash',
      tool_input: { command: 'git add .' },
      expectedDecision: 'allow'
    },
    {
      description: 'should allow curl (on allowlist)',
      tool_name: 'Bash',
      tool_input: { command: 'curl http://example.com' },
      expectedDecision: 'allow'
    },

    // Not on allowlist - should ASK
    {
      description: 'should ask for python scripts not on allowlist',
      tool_name: 'Bash',
      tool_input: { command: 'python script.py' },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    },
    {
      description: 'should ask for ruby scripts not on allowlist',
      tool_name: 'Bash',
      tool_input: { command: 'ruby app.rb' },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    },
    {
      description: 'should ask for Write tool if not on allowlist',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'test' },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    },
    {
      description: 'should ask for Edit tool if not on allowlist',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/test.txt', old_string: 'old', new_string: 'new' },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    },

    // Safe commands with destructive text in arguments - should NOT be flagged as destructive
    {
      description: 'should not flag gh pr create with "git push --force" in PR body as destructive',
      tool_name: 'Bash',
      tool_input: {
        command: 'gh pr create --title "Fix" --body "mentions git push --force and rm -rf"'
      },
      expectedDecision: 'allow',  // gh pr create is on allowlist, and NOT denied as destructive despite text in body
    },
    {
      description: 'should not flag echo with "git reset --hard" as destructive',
      tool_name: 'Bash',
      tool_input: {
        command: 'echo "git reset --hard is a destructive command"'
      },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    },
    {
      description: 'should not flag cat with heredoc containing "rm -rf" as destructive',
      tool_name: 'Bash',
      tool_input: {
        command: 'cat <<EOF\nDo not run: rm -rf /\nEOF'
      },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    },
    {
      description: 'should not flag curl as destructive even with destructive text in URL',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl https://example.com/api?action=git+reset+--hard'
      },
      expectedDecision: 'allow',  // curl is on allowlist
    },
    {
      description: 'should not flag jq with destructive text in JSON as destructive',
      tool_name: 'Bash',
      tool_input: {
        command: 'echo \'{"command": "git push --force"}\' | jq .'
      },
      expectedDecision: 'ask',
      expectedReason: /not on the allowlist/
    }
  ];

  testCases.forEach((testCase) => {
    it(testCase.description, async () => {
      const input: HookInput = {
        ...baseInput,
        tool_name: testCase.tool_name,
        tool_input: testCase.tool_input
      };

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);

      const output: HookOutput = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput).toBeDefined();
      expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');

      // Check decision
      if (testCase.expectedDecision instanceof RegExp) {
        expect(output.hookSpecificOutput?.permissionDecision).toMatch(testCase.expectedDecision);
      } else {
        expect(output.hookSpecificOutput?.permissionDecision).toBe(testCase.expectedDecision);
      }

      // Check reason if specified
      if (testCase.expectedReason) {
        expect(output.hookSpecificOutput?.permissionDecisionReason).toBeDefined();
        if (testCase.expectedReason instanceof RegExp) {
          expect(output.hookSpecificOutput?.permissionDecisionReason).toMatch(testCase.expectedReason);
        } else {
          expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(testCase.expectedReason);
        }
      }
    });
  });

  it('should always return valid JSON with hookSpecificOutput structure', async () => {
    const result = await runHook(baseInput);

    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();

    const output: HookOutput = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput?.permissionDecision).toMatch(/allow|deny|ask/);
  });
});
