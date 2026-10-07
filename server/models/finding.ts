export interface Finding {
  claim: string;
  source_url: string;
  document_name: string;
  page_number: number | null;
  confidence: 'high' | 'medium' | 'low';
  retrieved_by: string;
}
