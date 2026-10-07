export interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
}
