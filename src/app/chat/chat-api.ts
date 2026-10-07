/** Body of POST /api/chat. */
export interface ChatRequest {
  topic: string;
}

/** Response from POST /api/chat. */
export interface ChatResponse {
  /** The reply text to display. */
  text: string;
}
