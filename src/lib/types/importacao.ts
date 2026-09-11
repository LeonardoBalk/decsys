export type DownloadCandidate = {
  name: string;
  url: string;
};

export type Indicator = {
  id: string;
  code: string;
  name: string;
  unit: string;
};

export type SourceProfile = {
  kind: string;
  file_name: string;
  source_url?: string;
  rows: number;
  columns: { name: string; dtype: string; null_count: number }[];
  sample: Record<string, string | number | null>[];
  suggestions: Record<string, string>;
  agent_assessment?: { status: string; summary: string };
  sheets?: { name: string; rows: number; columns: number }[];
  selected_sheet?: string | null;
  reading_notes?: string[];
};
