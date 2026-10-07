import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatHistory } from './chat-history/chat-history';
import { ChatMessage } from './chat-message';
import { ChatService } from './chat.service';
import { ProgressUpdate } from './chat-api';

@Component({
  imports: [CommonModule, FormsModule, ChatHistory],
  selector: 'app-chat',
  templateUrl: './chat.html',
  styleUrl: './chat.css',
})
export class Chat {
  private readonly chatService = inject(ChatService);

  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly draft = signal('');
  protected readonly pending = signal(false);
  protected readonly progress = signal(0);

  protected send(): void {
    const text = this.draft().trim();
    if (!text || this.pending()) {
      return;
    }

    this.messages.update((m) => [...m, { role: 'user', text }]);
    this.draft.set('');
    this.pending.set(true);
    this.progress.set(0);

    this.chatService.reply(text).subscribe({
      next: (update: ProgressUpdate) => {
        this.progress.set(update.percentage);

        if (update.type === 'status') {
          this.messages.update((m) => [...m, { role: 'system', text: update.message }]);
        } else if (update.type === 'summary') {
          this.messages.update((m) => [...m, { role: 'assistant', text: update.message }]);
        } else if (update.type === 'file') {
          this.messages.update((m) => [...m, { role: 'system', text: `Report saved to: ${update.fileName}` }]);
        }
      },
      error: (error: Error) => {
        const errorMsg = error.message ?? 'Something went wrong sending your message. Please try again.';
        this.messages.update((m) => [...m, { role: 'error', text: errorMsg }]);
        this.pending.set(false);
        this.progress.set(0);
      },
      complete: () => {
        this.messages.update((m) => [...m, { role: 'system', text: 'Research complete!' }]);
        this.pending.set(false);
        this.progress.set(0);
      },
    });
  }
}
