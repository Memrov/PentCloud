import {
  validateBrowserState,
  type BrowserAuthState
} from "./browser-target-access";
import type { ScopedTarget } from "../../../../shared/target-access";
type Target = ScopedTarget & { id: string };
type Entry = { owner: string; expiresAt: number; state: BrowserAuthState };
/** Browser auth is transient run data, never reusable target configuration or Git evidence. */
export class RunBrowserAuth {
  constructor(
    private io: {
      get(key: string): unknown;
      put(key: string, value: unknown): void;
      remove(key: string): unknown;
      now?: () => number;
    }
  ) {}
  private key(id: string) {
    return "browser-auth:" + id;
  }
  private owner(target: Target) {
    return JSON.stringify([target.id, target.url, target.access?.login]);
  }
  clear(id: string) {
    this.io.remove(this.key(id));
  }
  read(id: string, target: Target) {
    const entry = this.io.get(this.key(id)) as Entry | undefined;
    if (!entry) return;
    if (
      entry.expiresAt <= (this.io.now ?? Date.now)() ||
      entry.owner !== this.owner(target)
    ) {
      this.clear(id);
      return;
    }
    return validateBrowserState(target, entry.state);
  }
  write(id: string, target: Target, state: BrowserAuthState) {
    this.io.put(this.key(id), {
      owner: this.owner(target),
      expiresAt: (this.io.now ?? Date.now)() + 30 * 60 * 1000,
      state: validateBrowserState(target, state)
    });
  }
}
