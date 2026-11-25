import type { NestClient } from '@nest/shared';
import { createIpcClient } from './ipc';
import { createMockClient } from './mock';

export function createClient(): NestClient {
  if (typeof window !== 'undefined' && window.nest) {
    return createIpcClient(window.nest);
  }
  return createMockClient();
}
