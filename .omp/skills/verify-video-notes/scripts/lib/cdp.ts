/**
 * CDP（Chromium DevTools Protocol）最小客户端：verify 的驱动脚本和打包版首启门禁共用一份。
 * 只做三件事：列 target、连上 page、发命令 / 求值。
 */
import { writeFileSync } from "node:fs";

export type Target = { type: string; url: string; title: string; webSocketDebuggerUrl: string };

export async function listTargets(port: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return (await res.json()) as Target[];
}

export class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (entry === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async open(port: number): Promise<Cdp> {
    const page = await findPageTarget(port);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error("CDP websocket failed")), { once: true });
    await opened.promise;
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    const ticket = Promise.withResolvers<T>();
    this.pending.set(id, { resolve: (v) => ticket.resolve(v as T), reject: ticket.reject });
    this.ws.send(JSON.stringify({ id, method, params }));
    return ticket.promise;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails !== undefined) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluate failed");
    }
    return res.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

/** 优先选应用自己的页面；一个还没导航完的 page target 也是合法目标。 */
export async function findPageTarget(port: number): Promise<Target> {
  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("vnote-app://")) ?? targets.find((t) => t.type === "page");
  if (page === undefined) throw new Error("no page target on CDP port");
  return page;
}

type AxNode = {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
};

/**
 * 把页面无障碍树写成缩进文本（证据快照）。nodeId 在每次 getFullAXTree 内自洽，
 * 跨调用不保证稳定，所以读取与写盘必须在同一次调用里完成。
 */
export async function writeAxTree(cdp: Cdp, file: string): Promise<number> {
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
  const byParent = new Map<string, AxNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? "root";
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }
  const lines: string[] = [];
  const walk = (parentId: string, depth: number): void => {
    for (const node of byParent.get(parentId) ?? []) {
      if (node.ignored === true) {
        walk(node.nodeId, depth);
        continue;
      }
      const role = node.role?.value ?? "?";
      const name = node.name?.value ?? "";
      const value = node.value?.value;
      const text = name === "" ? role : `${role} ${JSON.stringify(name)}`;
      lines.push(`${"  ".repeat(depth)}${text}${value === undefined || value === "" ? "" : ` value=${JSON.stringify(value)}`}`);
      walk(node.nodeId, depth + 1);
    }
  };
  const root = nodes.find((n) => n.parentId === undefined);
  if (root !== undefined) walk(root.nodeId, 0);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return lines.length;
}
