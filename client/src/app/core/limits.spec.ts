import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LIMITS as CLIENT_LIMITS } from './limits';

describe('limits constants alignment', () => {
  it('client limits and server limits match exactly', () => {
    const candidatePaths = [
      path.join(process.cwd(), '..', 'server', 'src', 'lib', 'limits.ts'),
      path.join(process.cwd(), 'server', 'src', 'lib', 'limits.ts'),
      path.resolve(__dirname, '../../../../server/src/lib/limits.ts'),
    ];
    const serverLimitsPath = candidatePaths.find(p => fs.existsSync(p));
    expect(serverLimitsPath).toBeDefined();
    const serverFileContent = fs.readFileSync(serverLimitsPath!, 'utf-8');

    const match = serverFileContent.match(/export const LIMITS = \{([\s\S]*?)\} as const;/);
    expect(match).not.toBeNull();

    const serverLimits: Record<string, number> = {};
    const lines = match![1].split('\n');
    for (const line of lines) {
      const lineMatch = line.match(/^\s*([a-zA-Z0-9_]+):\s*(\d+),/);
      if (lineMatch) {
        serverLimits[lineMatch[1]] = Number(lineMatch[2]);
      }
    }

    expect(CLIENT_LIMITS).toEqual(serverLimits);
  });
});
