import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ChatRequest, ProgressUpdate } from './chat-api';

/** Sends a topic to the API server via SSE stream and returns an Observable of progress updates. */
@Injectable({ providedIn: 'root' })
export class ChatService {
  reply(topic: string): Observable<ProgressUpdate> {
    return new Observable((subscriber) => {
      this.streamReply(topic, subscriber).catch((error) => {
        subscriber.error(error);
      });
    });
  }

  private async streamReply(
    topic: string,
    subscriber: any,
  ): Promise<void> {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic } satisfies ChatRequest),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr.trim()) {
              const update: ProgressUpdate = JSON.parse(jsonStr);
              subscriber.next(update);
              if (update.type === 'complete') {
                subscriber.complete();
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
