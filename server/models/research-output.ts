import { Finding } from './finding.ts';

export interface ResearchOutput {
  findings: Finding[];
  query: string;
  timestamp: string;
}
