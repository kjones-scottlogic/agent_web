/** Body of POST /api/chat. */
export interface ChatRequest {
  topic: string;
}

/** Response from POST /api/chat. */
export interface ChatResponse {
  /** The reply text to display. */
  text: string;
}

/** Progress update from the server via SSE. */
export type ProgressUpdate =
  | { type: 'status'; percentage: number; message: string }
  | { type: 'summary'; percentage: number; message: string }
  | { type: 'file'; percentage: number; fileName: string }
  | { type: 'complete'; percentage: number; result: ChatResponse };
