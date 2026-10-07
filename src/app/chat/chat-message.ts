export interface ChatMessage {
  role: 'user' | 'assistant' | 'error' | 'system';
  text: string;
}
