export type IiuMunicipality = { ibge_code: string; name: string; state: string };

export type IiuCityProfile = "pequeno" | "medio" | "grande" | "metropole";

export type IiuDimensionMeta = { code: string; name: string; color: string; display_order: number; weight: number };

export type IiuRankingItem = {
  rank: number;
  score: number;
  municipality_ibge_code: string;
  name: string;
  state: string | null;
  overall_score: number;
  maturity: string | null;
  dimension_scores: Record<string, number | null>;
  scored_indicators: number;
  observed_indicators: number;
};

export type IiuRankingPage = {
  city_profile: IiuCityProfile;
  dimension: string | null;
  generated_at: string;
  cached: boolean;
  truncated: boolean;
  scored_municipalities: number;
  total_indicators: number;
  dimensions: IiuDimensionMeta[];
  total: number;
  limit: number;
  offset: number;
  items: IiuRankingItem[];
};

export type IiuCompareIndicator = {
  code: string;
  name: string;
  type: string | null;
  unit: string;
  direction: string;
  raw_value: number | null;
  reference_period: string | null;
  score: number | null;
  benchmark: { minimum: number; maximum: number } | null;
};

export type IiuCompareDimension = {
  code: string;
  name: string;
  color: string;
  weight: number;
  score: number | null;
  scored_indicators: number;
  observed_indicators: number;
  total_indicators: number;
  indicators: IiuCompareIndicator[];
};

export type IiuCompareMunicipality = {
  municipality_ibge_code: string;
  name: string | null;
  state: string | null;
  overall_score: number | null;
  maturity: string | null;
  observed_indicators: number;
  scored_indicators: number;
  total_indicators: number;
  dimensions: IiuCompareDimension[];
};

export type IiuComparison = { city_profile: IiuCityProfile; municipalities: IiuCompareMunicipality[] };

export type IiuSeriesPoint = {
  reference_period: string;
  value: number | string | null;
  unit: string;
  source_name: string;
  import_title: string;
  period_granularity?: "month" | "year" | null;
};

export type IiuIndicatorSummary = { code: string; name: string; unit: string; observations: number; first_period: string; last_period: string };

export type IiuTimeseriesIndicators = { municipality_ibge_code: string; municipality_name: string; state: string; truncated: boolean; indicators: IiuIndicatorSummary[] };

export type IiuTimeseries = {
  municipality_ibge_code: string;
  municipality_name: string;
  state: string;
  indicator: { code: string; name: string; unit: string } | null;
  points: IiuSeriesPoint[];
};
