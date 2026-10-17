import type { ReplayLibrary } from "./media-types.js";
import type { createMediaDiagnostics } from "./media-diagnostics.js";

declare global {
  interface Navigator {
    readonly connection?: EventTarget & {
      readonly saveData?: boolean;
      readonly effectiveType?: string;
    };
  }
  interface Window {
    yapReplayHls?: ReplayLibrary;
    yapMediaDiagnostics?: ReturnType<typeof createMediaDiagnostics>;
  }
}
