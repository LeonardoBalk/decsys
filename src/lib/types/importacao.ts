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
  sheets?: { name: string; rows: number; columns: number; has_data?: boolean }[];
  selected_sheet?: string | null;
  reading_notes?: string[];
  quality_warnings?: string[];
};
