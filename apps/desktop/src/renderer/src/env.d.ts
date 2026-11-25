import type { NestBridge } from '@nest/shared';

declare global {
  interface Window {
    nest?: NestBridge;
  }
}

export {};
