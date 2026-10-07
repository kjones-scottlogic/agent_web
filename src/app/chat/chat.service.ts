import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChatRequest, ChatResponse } from './chat-api';

/** Sends a topic to the API server (server/server.mts) and returns its reply text. */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly http = inject(HttpClient);

  async reply(topic: string): Promise<string> {
    const response = await firstValueFrom(
      this.http.post<ChatResponse>('/api/chat', { topic } satisfies ChatRequest),
    );
    return response.text;
  }
}
