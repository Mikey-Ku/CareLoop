export type VitalsSource = "video_file" | "relay_video";

export type ValidationEvent = {
  code: number;
  timestampUs: number;
  hint: string;
};

export type VitalsError = {
  code: number | string;
  message: string;
  retryable?: boolean;
};

export type VitalsResult = {
  heartRate: number | null;
  breathingRate: number | null;
  confidence: number | null;
  measuredAt: string | null;
  source: VitalsSource;
  validation: ValidationEvent[];
  errors: VitalsError[];
};

export function emptyVitalsResult(source: VitalsSource, errors: VitalsError[] = []): VitalsResult {
  return {
    heartRate: null,
    breathingRate: null,
    confidence: null,
    measuredAt: null,
    source,
    validation: [],
    errors,
  };
}
