import type { ServerResponse } from 'node:http';
import type { PresenceUser, ProjectEvent } from '@sixpoint/shared';

interface Client {
  res: ServerResponse;
  user: PresenceUser;
}

/** In-process pub/sub for project SSE streams (R-51) and presence (R-53). */
export class EventHub {
  private projects = new Map<string, Set<Client>>();
  private heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const set of this.projects.values()) for (const c of set) c.res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  subscribe(projectId: string, res: ServerResponse, user: PresenceUser): () => void {
    let set = this.projects.get(projectId);
    if (!set) this.projects.set(projectId, (set = new Set()));
    const client = { res, user };
    set.add(client);
    this.publishPresence(projectId);
    return () => {
      set!.delete(client);
      if (!set!.size) this.projects.delete(projectId);
      this.publishPresence(projectId);
    };
  }

  publish(projectId: string, event: ProjectEvent) {
    const set = this.projects.get(projectId);
    if (!set) return;
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of set) c.res.write(data);
  }

  publishAll(event: ProjectEvent) {
    for (const id of this.projects.keys()) this.publish(id, event);
  }

  presence(projectId: string): PresenceUser[] {
    const set = this.projects.get(projectId);
    return set ? [...set].map((c) => c.user) : [];
  }

  private publishPresence(projectId: string) {
    this.publish(projectId, { type: 'presence', origin: null, users: this.presence(projectId) });
  }

  close() {
    clearInterval(this.heartbeat);
    for (const set of this.projects.values()) for (const c of set) c.res.end();
    this.projects.clear();
  }
}
