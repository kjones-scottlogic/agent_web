import { Component, ElementRef, afterRenderEffect, inject, input } from '@angular/core';
import { ChatMessage } from '../chat-message';

@Component({
  selector: 'app-chat-history',
  templateUrl: './chat-history.html',
  styleUrl: './chat-history.css',
})
export class ChatHistory {
  readonly messages = input.required<ChatMessage[]>();

  constructor() {
    // The host element is the scroll container; keep the newest message in view.
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterRenderEffect(() => {
      this.messages();
      host.scrollTop = host.scrollHeight;
    });
  }
}
