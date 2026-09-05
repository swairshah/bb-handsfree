import type { ThreadView } from "./view-workspace";

export type CallOrigin = "composer" | "handsfree" | "global";
export type DesktopDestination = "navigate" | "panel";
export type DesktopPreferences = {
  desktopComposerDestination: DesktopDestination;
  desktopAideDestination: DesktopDestination;
  desktopTabBehavior: "reuse" | "new";
};
export const DESKTOP_DEFAULTS: DesktopPreferences = {
  desktopComposerDestination: "navigate",
  desktopAideDestination: "panel",
  desktopTabBehavior: "new",
};
export function desktopDestination(origin: CallOrigin, override: unknown, config: DesktopPreferences): DesktopDestination {
  if (override === "navigate" || override === "panel") return override;
  if (override !== undefined && override !== "auto") throw new Error("Invalid desktop destination.");
  return origin === "handsfree" ? config.desktopAideDestination
    : origin === "composer" ? config.desktopComposerDestination : "navigate";
}

export const DESKTOP_THREAD_ACTION = "desktop-thread";
export const DESKTOP_DIFF_ACTION = "desktop-diff";
export const DESKTOP_PAGE_TAB = { panelId: "sessions", id: "desktop-thread" } as const;
type Presenter = {
  kind: "thread" | "page";
  ownerId: string;
  available(): boolean;
  open(view: ThreadView, reuse: boolean): boolean;
  openDiff?(threadId: string, title: string): boolean;
};

/** Window-local destinations. BB owns native tabs, selection, and closure. */
export class DesktopViews {
  private presenters = new Map<symbol, Presenter>();
  private previews = new Map<string, ThreadView>();
  private listeners = new Set<() => void>();
  private contexts = new Map<symbol, () => ThreadView | null>();
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly preview = (ownerId: string) => this.previews.get(ownerId) ?? null;
  registerPresenter(presenter: Presenter) {
    const key = Symbol(); this.presenters.set(key, presenter);
    return () => { this.presenters.delete(key); };
  }
  registerContext(read: () => ThreadView | null) {
    const key = Symbol(); this.contexts.set(key, read);
    return () => { this.contexts.delete(key); };
  }
  current() {
    for (const read of [...this.contexts.values()].reverse()) { const view = read(); if (view) return view; }
    return null;
  }
  private presenter() { return [...this.presenters.values()].reverse().find(item => item.available()); }
  capabilities() {
    const presenter = this.presenter();
    return { sidePanel: !!presenter, nativeTabs: presenter?.kind === "thread" };
  }
  openDiff(threadId: string, title: string) {
    const presenter = this.presenter();
    if (!presenter?.openDiff) throw new Error("This screen has no available diff panel. Open a thread page or Handsfree and try again.");
    if (!presenter.openDiff(threadId, title)) throw new Error("The current screen declined the diff-panel request.");
  }
  open(views: ThreadView[], disposition: "auto" | "reuse" | "new", preference: "reuse" | "new") {
    const presenter = this.presenter();
    if (!presenter) throw new Error("This screen has no available side panel. Ask to navigate to the thread instead.");
    const unique = [...new Map(views.map(view => [view.threadId, view])).values()];
    if (!unique.length) throw new Error("No threads were selected.");
    if (presenter.kind === "page" && (unique.length > 1 || disposition === "new")) {
      throw new Error("The Aide page supports one side-panel thread. Separate native tabs are available from an existing thread page. Nothing was opened.");
    }
    const reuse = unique.length === 1 && (disposition === "reuse" || (disposition === "auto" && preference === "reuse"));
    const opened: ThreadView[] = [];
    const open = (view: ThreadView) => {
      if (!presenter.available() || !presenter.open(view, reuse)) throw new Error("The current screen declined the side-panel request.");
      if (reuse) {
        this.previews.set(presenter.ownerId, view);
        for (const listener of this.listeners) listener();
      }
    };
    try {
      for (const view of unique) { open(view); opened.push(view); }
      if (unique.length > 1) open(unique[0]); // Host deduplicates and selects the first requested tab.
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${opened.length ? `Opened ${opened.length} of ${unique.length}: ${opened.map(view => view.title).join(", ")}.` : "Nothing was opened."}`);
    }
    return { count: opened.length, selected: unique[0], nativeTabs: presenter.kind === "thread" && !reuse };
  }
}
export const desktopViews = new DesktopViews();
