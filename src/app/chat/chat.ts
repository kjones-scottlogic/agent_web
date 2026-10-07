import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatHistory } from './chat-history/chat-history';
import { ChatMessage } from './chat-message';
import { ChatService } from './chat.service';

@Component({
  imports: [FormsModule, ChatHistory],
  selector: 'app-chat',
  templateUrl: './chat.html',
  styleUrl: './chat.css',
})
export class Chat {
  private readonly chatService = inject(ChatService);

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly draft = signal('');
  protected readonly pending = signal(false);

  protected async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.pending()) {
      return;
    }

    this.messages.update((m) => [...m, { role: 'user', text }]);
    this.draft.set('');
    this.pending.set(true);
    try {
      const reply = await this.chatService.reply(text);
      this.messages.update((m) => [...m, { role: 'assistant', text: reply }]);
    } catch (error) {
      const detail = error instanceof HttpErrorResponse ? error.error?.error : undefined;
      const text = detail ?? 'Something went wrong sending your message. Please try again.';
      this.messages.update((m) => [...m, { role: 'error', text }]);
    } finally {
      this.pending.set(false);
    }
  }
}
