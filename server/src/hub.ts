import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerEvent, Snapshot } from '@office/shared';
import { originAllowed } from './origin';

/** One WebSocket endpoint: a snapshot on connect, then every event broadcast to all clients. */
export class Hub {
  private wss: WebSocketServer;
  constructor(server: Server, private snapshot: () => Snapshot) {
    this.wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info: { origin?: string }) => originAllowed(info.origin) });
    this.wss.on('connection', ws => {
      const e: ServerEvent = { type: 'snapshot', snapshot: this.snapshot(), ts: new Date().toISOString() };
      ws.send(JSON.stringify(e));
    });
  }
  broadcast(e: ServerEvent) {
    const data = JSON.stringify(e);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }
  close() { for (const c of this.wss.clients) c.terminate(); this.wss.close(); }
}
