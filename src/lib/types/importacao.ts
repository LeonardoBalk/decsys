export type DownloadCandidate = {
  name: string;
  url: string;
};

export type Indicator = {
  id: string;
  code: string;
  name: string;
  unit: string;
  dimension?: string;
  definition?: string;
  expected_frequency?: string | null;
  active?: boolean;
};

export type IndicatorRecommendation = {
  code: string;
  name: string;
  dimension: string;
  definition: string;
  unit: string;
  expected_frequency: string;
  value_field: string;
};

export type SourceProfile = {
  kind: string;
  file_name: string;
  source_url?: string;
  rows: number;
  columns: { name: string; dtype: string; null_count: number }[];
  sample: Record<string, string | number | null>[];
  suggestions: Record<string, string>;
  indicator_recommendations?: IndicatorRecommendation[];
  agent_assessment?: { status: string; summary: string; risks?: string[]; municipality_field?: string | null; year_field?: string | null; measure_field?: string | null };
  sheets?: { name: string; rows: number; columns: number; has_data?: boolean; imported?: boolean; rows_estimated?: boolean }[];
  selected_sheet?: string | null;
  reading_notes?: string[];
  quality_warnings?: string[];
  upload_token?: string;
};

export type ImportSummary = {
  id: string;
  title: string;
  file_name: string | null;
  source_url: string | null;
  status: "draft" | "analyzing" | "needs_review" | "approved" | "archived" | "discarded";
  total_rows: number;
  created_at: string;
  updated_at: string | null;
};
