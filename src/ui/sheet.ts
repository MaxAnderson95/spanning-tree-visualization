import { el } from "./format.ts";

type Target = "side" | "dials";

/**
 * Collapses the side and dial stacks into a single bottom drawer below ~700px,
 * driven by one `body.is-compact` class so the desktop layout is untouched. A
 * tab bar switches which panel is open (one at a time).
 */
export class MobileSheet {
  private readonly tabs: HTMLElement;
  private open: Target | null = null;

  constructor() {
    this.tabs = el("div", "sheet-tabs");
    const map = this.tab("Map", () => this.show(null));
    const inspect = this.tab("Inspect", () => this.show("side"));
    const tune = this.tab("Chaos", () => this.show("dials"));
    this.tabs.append(map, inspect, tune);
    document.body.appendChild(this.tabs);

    const mql = window.matchMedia("(max-width: 700px)");
    const apply = (): void => {
      document.body.classList.toggle("is-compact", mql.matches);
      if (!mql.matches) this.show(null);
    };
    mql.addEventListener("change", apply);
    apply();
  }

  /** Programmatically raise a drawer (e.g. when a node is tapped). */
  raise(target: Target): void {
    if (document.body.classList.contains("is-compact")) this.show(target);
  }

  private show(target: Target | null): void {
    this.open = target;
    for (const id of ["side", "dials"] as Target[]) {
      document.getElementById(id)?.classList.toggle("is-open", id === target);
    }
    document.body.classList.toggle("sheet-open", target !== null);
    for (const [i, name] of (["map", "side", "dials"] as const).entries()) {
      const active = (target === null && name === "map") || target === name;
      this.tabs.children[i]?.classList.toggle("is-active", active);
    }
  }

  get current(): Target | null {
    return this.open;
  }

  private tab(label: string, onClick: () => void): HTMLElement {
    const btn = el("button", "sheet-tab", label);
    btn.addEventListener("click", onClick);
    return btn;
  }
}
